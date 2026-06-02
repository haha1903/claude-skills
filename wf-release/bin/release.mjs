#!/usr/bin/env node
// wf-release — check ADO build / release pipeline status (buddy build, test
// release). Accepts a buildId or a full build-results URL (as found in the
// notification emails). org/project are taken from the URL, else default to
// msazure/One.
//
//   release.mjs status <buildId | build-results-URL>
//
// ev2 rollout completion is NOT polled here — it arrives by email (the rollout
// email carries the link + status). This skill answers "did the pipeline /
// release succeed", and surfaces per-stage results so the caller can see how
// far it got.

import { execFileSync } from "node:child_process";

function sh(args) {
  return execFileSync("az", args, { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
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

if (cmd !== "status" || !argv[1]) {
  console.error("usage: release.mjs status <buildId | build-results-URL>");
  process.exit(1);
}

const { org, project, buildId } = parseTarget(argv[1]);

const build = JSON.parse(sh([
  "pipelines", "build", "show", "--id", buildId,
  "--org", org, "--project", project, "--output", "json",
]));

// Stage-level results from the timeline.
let stages = [];
try {
  const tl = JSON.parse(sh([
    "devops", "invoke", "--area", "build", "--resource", "Timeline",
    "--route-parameters", `project=${project}`, `buildId=${buildId}`,
    "--org", org, "--api-version", "7.0", "--output", "json",
  ]));
  stages = (tl.records || [])
    .filter((r) => r.type === "Stage")
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((r) => ({ name: r.name, state: r.state, result: r.result }));
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
  branch: build.sourceBranch,
  finishTime: build.finishTime,
  url,
  stages,
}, null, 2));
