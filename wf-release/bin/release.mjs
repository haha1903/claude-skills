#!/usr/bin/env node
// wf-release — check ADO build / release pipeline status (buddy build, test
// release). Accepts a buildId or a full build-results URL (as found in the
// notification emails). org/project are taken from the URL, else default to
// msazure/One.
//
//   release.mjs status <buildId | build-results-URL>   # status of one build
//   release.mjs runs <pipelineId>                       # recent runs of a pipeline (candidates to pick from)
//
// ev2 rollout completion is NOT polled here — it arrives by email (the rollout
// email carries the link + status). This skill answers "did the pipeline /
// release succeed", and surfaces per-stage results so the caller can see how
// far it got.

import { execFileSync } from "node:child_process";

function sh(args) {
  return execFileSync("az", args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
}

const ORG = "https://dev.azure.com/msazure";
const PROJECT = "One";

// List recent runs of a pipeline as CANDIDATES — we do NOT guess which one is
// "the release run". Scheduled (build-only) and manual (release-enabled) runs
// interleave, and a run still in flight may sort anywhere, so picking "the
// latest" is wrong. Instead return the recent runs (inProgress ones merged in
// explicitly, since `--top N` ordering can truncate them off) sorted newest
// first, with reason/status/result, and let the caller decide using task
// context (when they triggered it, manual vs schedule, etc). Feed the chosen
// id to `status` for per-stage detail (the Prod/Release stage being non-skipped
// is the real signal that a run is release-enabled).
function listRuns(pipelineId) {
  const base = ["pipelines", "runs", "list", "--pipeline-ids", pipelineId,
    "--org", ORG, "--project", PROJECT, "--output", "json"];
  const pick = (r) => ({
    id: r.id, buildNumber: r.name, status: r.status, result: r.result,
    reason: r.reason, branch: r.sourceBranch, queueTime: r.queueTime,
  });
  const byId = new Map();
  for (const r of JSON.parse(sh([...base, "--top", "15"]))) byId.set(r.id, r);
  // Merge inProgress explicitly — they can fall outside the --top window.
  for (const r of JSON.parse(sh([...base, "--status", "inProgress"]))) byId.set(r.id, r);
  return [...byId.values()]
    .map(pick)
    .sort((a, b) => String(b.queueTime).localeCompare(String(a.queueTime)));
}

function parseTarget(arg) {
  // Accept a bare id or a URL like
  // https://dev.azure.com/{org}/{project}/_build/results?buildId=123&view=results
  let org = "https://dev.azure.com/msazure";
  let project = "One";
  let buildId = arg;
  const urlMatch = arg.match(/dev\.azure\.com\/([^/]+)\/([^/]+)\/_build\/results\?.*\bbuildId=(\d+)/);
  if (urlMatch) {
    org = `https://dev.azure.com/${urlMatch[1]}`;
    project = decodeURIComponent(urlMatch[2]);
    buildId = urlMatch[3];
  } else {
    const idMatch = arg.match(/(\d{6,})/);
    if (idMatch) buildId = idMatch[1];
  }
  return { org, project, buildId };
}

const argv = process.argv.slice(2);
const cmd = argv[0];

if (cmd === "runs" && argv[1]) {
  const runs = listRuns(argv[1].replace(/\D/g, ""));
  console.log(JSON.stringify({ pipelineId: Number(argv[1].replace(/\D/g, "")), count: runs.length, runs }, null, 2));
  process.exit(0);
}

if (cmd !== "status" || !argv[1]) {
  console.error("usage: release.mjs status <buildId | build-results-URL>  |  release.mjs runs <pipelineId>");
  process.exit(1);
}

const { org, project, buildId } = parseTarget(argv[1]);

const build = JSON.parse(sh([
  "pipelines", "build", "show", "--id", buildId,
  "--org", org, "--project", project, "--output", "json",
]));

// Stage-level results + approval signal from the timeline.
let stages = [];
let approval = { state: "unknown", note: "no Approval phase/task in timeline yet" };
try {
  const tl = JSON.parse(sh([
    "devops", "invoke", "--area", "build", "--resource", "Timeline",
    "--route-parameters", `project=${project}`, `buildId=${buildId}`,
    "--org", org, "--api-version", "7.0", "--output", "json",
  ]));
  const records = tl.records || [];
  stages = records
    .filter((r) => r.type === "Stage")
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((r) => ({ name: r.name, state: r.state, result: r.result }));

  // Approval status comes from manual-validation records, NOT from a stage
  // being inProgress. A stage can be inProgress because its rollout/monitoring
  // is running AFTER approval already passed — keying "waiting for approval"
  // off stage state is wrong. The real signal is the "Waiting for Approval" /
  // "Approval" phase|task records (and "Request Approved" once granted).
  const isApprovalRec = (r) => /\bapproval\b|waiting for approval|request approved/i.test(r.name || "");
  const apprRecs = records.filter(isApprovalRec);
  if (apprRecs.length > 0) {
    const pending = apprRecs.find((r) => r.state === "inProgress" || r.state === "pending");
    if (pending) {
      approval = { state: "pending", note: `waiting at: ${pending.name}` };
    } else {
      const granted = apprRecs.some((r) => /request approved/i.test(r.name || "") || (/\bapproval\b/i.test(r.name || "") && r.result === "succeeded"));
      approval = granted
        ? { state: "approved", note: "approval phase/task completed" }
        : { state: "unknown", note: "approval records present but state unclear" };
    }
  }
} catch (e) {
  stages = [{ name: "(timeline fetch failed)", state: String(e.message).slice(0, 120) }];
}

const url = `${org}/${encodeURIComponent(project)}/_build/results?buildId=${buildId}&view=results`;
console.log(JSON.stringify({
  buildId: Number(buildId),
  definition: build.definition?.name,
  buildNumber: build.buildNumber,
  status: build.status,       // notStarted | inProgress | completed | ...
  result: build.result,       // succeeded | partiallySucceeded | failed | canceled (null while running)
  approval,                   // { state: pending|approved|unknown, note } — derived from manual-validation records, NOT stage state
  branch: build.sourceBranch,
  finishTime: build.finishTime,
  url,
  stages,
}, null, 2));
