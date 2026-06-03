#!/usr/bin/env node
// wf-pr — Azure DevOps PR operations, run from inside a repo worktree.
// Infers org/project/repo from the git remote so callers pass only the PR id.
//
//   pr.mjs create --title "..." [--description "..."] [--target main] [--draft]
//   pr.mjs status <prId>
//   pr.mjs comments <prId>                 # list active (unresolved) threads
//   pr.mjs resolve <prId> <threadId> [--comment "done: ..."]
//
// All output is JSON or concise lines meant for an LLM to act on.

import { execFileSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";

function sh(args, opts = {}) {
  return execFileSync("az", args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024, ...opts });
}

function gitRemote() {
  const url = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf-8" }).trim();
  // https://{org}@dev.azure.com/{org}/{project}/_git/{repo}
  const m = url.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/(.+?)(?:\.git)?$/);
  if (!m) throw new Error(`Cannot parse ADO org/project/repo from remote: ${url}`);
  return {
    org: `https://dev.azure.com/${m[1]}`,
    project: decodeURIComponent(m[2]),
    repo: decodeURIComponent(m[3]),
  };
}

function currentBranch() {
  return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf-8" }).trim();
}

function parseFlags(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const n = argv[i + 1];
      if (n === undefined || n.startsWith("--")) out[k] = true;
      else { out[k] = n; i++; }
    } else out._.push(a);
  }
  return out;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const { org, project, repo } = gitRemote();
// `az repos pr show` rejects --project (PR id is org-global); only create/list
// need it. So baseArgs carries just --org; create adds --project explicitly.
const baseArgs = ["--org", org];

if (cmd === "create") {
  const f = parseFlags(argv.slice(1));
  if (!f.title) {
    console.error('usage: pr.mjs create --title "..." [--description "..."] [--target main] [--draft] [--work-items "id1 id2 ..."] [--no-auto-complete]');
    process.exit(1);
  }
  // Two-stage flow modeled after ~/bin/cpr:
  //   1. create with --auto-complete false + squash + delete-source-branch
  //      (and --work-items / --transition-work-items if given)
  //   2. update to enable --auto-complete and set the merge commit message
  // This mirrors the ADO UI's "Set auto-complete" button: the PR is created
  // ready, then auto-complete is flipped on after creation. Skip step 2 with
  // --no-auto-complete (drafts default to no auto-complete too).
  const isDraft = !!f.draft;
  const wantAutoComplete = !isDraft && !f["no-auto-complete"];
  const workItems = (typeof f["work-items"] === "string" ? f["work-items"] : "")
    .split(/\s+/).map((s) => s.trim()).filter(Boolean);

  const createArgs = [
    "repos", "pr", "create",
    "--repository", repo,
    "--source-branch", currentBranch(),
    "--target-branch", f.target || "main",
    "--title", f.title,
    "--squash", "true",
    "--delete-source-branch", "true",
    "--auto-complete", "false",          // explicitly off; we set it via update below
    ...baseArgs, "--project", project,
    "--output", "json",
  ];
  if (f.description) createArgs.push("--description", f.description);
  if (isDraft) createArgs.push("--draft", "true");
  if (workItems.length) {
    createArgs.push("--transition-work-items", "true");
    createArgs.push("--work-items", ...workItems);
  }
  const pr = JSON.parse(sh(createArgs));
  const prId = pr.pullRequestId;

  let autoCompleteEnabled = false;
  if (wantAutoComplete) {
    // Use the merge-commit message pattern ADO UI auto-sets: "Merged PR <id>: <title>".
    sh([
      "repos", "pr", "update",
      "--id", String(prId),
      "--auto-complete", "true",
      "--merge-commit-message", `Merged PR ${prId}: ${f.title}`,
      ...baseArgs, "--output", "json",
    ]);
    autoCompleteEnabled = true;
  }

  const url = `${org}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequest/${prId}`;
  console.log(JSON.stringify({
    prId, url,
    status: pr.status,
    title: pr.title,
    autoComplete: autoCompleteEnabled,
    workItems: workItems.length ? workItems : undefined,
  }, null, 2));
} else if (cmd === "status") {
  const prId = argv[1];
  if (!prId) { console.error("usage: pr.mjs status <prId>"); process.exit(1); }
  const pr = JSON.parse(sh(["repos", "pr", "show", "--id", prId, ...baseArgs, "--output", "json"]));
  // Policy evaluations (PoP, build, reviewer policies) live in a separate call.
  let policies = [];
  try {
    const repoId = pr.repository?.id;
    const artifactId = `vstfs:///CodeReview/CodeReviewId/${pr.repository?.project?.id}/${prId}`;
    const raw = sh([
      "devops", "invoke",
      "--area", "policy", "--resource", "evaluations",
      "--route-parameters", `project=${project}`,
      "--query-parameters", `artifactId=${artifactId}`,
      "--org", org, "--api-version", "7.1-preview", "--output", "json",
    ]);
    const evals = JSON.parse(raw)?.value ?? [];
    policies = evals.map((e) => ({
      name: e.configuration?.type?.displayName || e.configuration?.type?.id,
      status: e.status, // approved | rejected | running | queued | notApplicable
    }));
    void repoId;
  } catch (e) {
    policies = [{ name: "(policy fetch failed)", status: String(e.message).slice(0, 120) }];
  }
  const reviewers = (pr.reviewers || []).map((r) => ({
    name: r.displayName,
    // vote: 10 approved, 5 approved-with-suggestions, 0 none, -5 waiting, -10 rejected
    vote: r.vote,
    required: r.isRequired || false,
  }));
  console.log(JSON.stringify({
    prId: Number(prId),
    title: pr.title,
    status: pr.status,                 // active | completed | abandoned
    isDraft: pr.isDraft,
    mergeStatus: pr.mergeStatus,       // succeeded | conflicts | ...
    sourceBranch: pr.sourceRefName,
    targetBranch: pr.targetRefName,
    reviewers,
    policies,
  }, null, 2));
} else if (cmd === "comments") {
  const prId = argv[1];
  if (!prId) { console.error("usage: pr.mjs comments <prId>"); process.exit(1); }
  const pr = JSON.parse(sh(["repos", "pr", "show", "--id", prId, ...baseArgs, "--output", "json"]));
  const repoId = pr.repository?.id;
  const raw = sh([
    "devops", "invoke",
    "--area", "git", "--resource", "pullRequestThreads",
    "--route-parameters", `project=${project}`, `repositoryId=${repoId}`, `pullRequestId=${prId}`,
    "--org", org, "--api-version", "7.1", "--output", "json",
  ]);
  const threads = JSON.parse(raw)?.value ?? [];
  // Surface unresolved threads. Do NOT filter by commentType=='system' — the
  // GitOps PR Assistant posts review comments as 'system'. Skip only true ADO
  // system events (branch updates etc., author TFS) and deleted threads.
  const open = [];
  for (const t of threads) {
    if (t.isDeleted) continue;
    // status: active | fixed | wontFix | closed | byDesign | pending | null.
    // null status = an ADO system event (vote / policy update / reviewer
    // joined / auto-complete set), NOT a real comment thread — skip it.
    if (!t.status) continue;
    const resolved = ["fixed", "closed", "wontFix", "byDesign"].includes(t.status);
    if (resolved) continue;
    const comments = (t.comments || []).filter((c) => {
      const author = c.author?.displayName || "";
      if (author === "Microsoft.VisualStudio.Services.TFS") return false;
      return (c.content || "").trim().length > 0;
    });
    if (comments.length === 0) continue;
    open.push({
      threadId: t.id,
      status: t.status || "active",
      file: t.threadContext?.filePath || null,
      comments: comments.map((c) => ({
        author: c.author?.displayName,
        text: (c.content || "").replace(/<[^>]+>/g, "").trim().slice(0, 800),
      })),
    });
  }
  console.log(JSON.stringify({ prId: Number(prId), openThreads: open.length, threads: open }, null, 2));
} else if (cmd === "resolve") {
  const prId = argv[1];
  const threadId = argv[2];
  const f = parseFlags(argv.slice(3));
  if (!prId || !threadId) { console.error('usage: pr.mjs resolve <prId> <threadId> [--comment "..."]'); process.exit(1); }
  const pr = JSON.parse(sh(["repos", "pr", "show", "--id", prId, ...baseArgs, "--output", "json"]));
  const repoId = pr.repository?.id;
  // Optionally add a reply comment first.
  if (f.comment) {
    const payload = JSON.stringify({ content: f.comment, commentType: "text" });
    const tmp1 = `/tmp/pr-comment-${Date.now()}.json`;
    writeFileSync(tmp1, payload);
    sh([
      "devops", "invoke",
      "--area", "git", "--resource", "pullRequestThreadComments",
      "--route-parameters", `project=${project}`, `repositoryId=${repoId}`, `pullRequestId=${prId}`, `threadId=${threadId}`,
      "--http-method", "POST", "--in-file", tmp1,
      "--org", org, "--api-version", "7.1", "--output", "none",
    ]);
    unlinkSync(tmp1);
  }
  // Set thread status to fixed (resolved).
  const payload = JSON.stringify({ status: "fixed" });
  const tmp2 = `/tmp/pr-resolve-${Date.now()}.json`;
  writeFileSync(tmp2, payload);
  sh([
    "devops", "invoke",
    "--area", "git", "--resource", "pullRequestThreads",
    "--route-parameters", `project=${project}`, `repositoryId=${repoId}`, `pullRequestId=${prId}`, `threadId=${threadId}`,
    "--http-method", "PATCH", "--in-file", tmp2,
    "--org", org, "--api-version", "7.1", "--output", "none",
  ]);
  unlinkSync(tmp2);
  console.log(`resolved thread ${threadId} on PR ${prId}`);
} else {
  console.error("usage: pr.mjs create|status|comments|resolve ...");
  process.exit(1);
}
