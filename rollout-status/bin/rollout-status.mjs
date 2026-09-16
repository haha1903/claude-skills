#!/usr/bin/env node
/**
 * Whether an EV2 rollout landed, and which action failed.
 *
 *   rollout-status.mjs <portalUrl> [--tree] [--json]
 *   rollout-status.mjs <rolloutId> --service-group=NAME [--infra=int|prod] [--tree] [--json]
 *
 * Exit 1 if any action failed, so this can drive a watch loop.
 *
 * No service-group default. A portal URL already carries it, and inventing one means silently
 * reporting on somebody else's rollout when the caller forgot the flag.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ev2 } from "../../_iris-shared/index.mjs";

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith("--"));
const flag = (n) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : undefined;
};
const has = (n) => args.includes(`--${n}`);

if (!target) {
  console.error("Usage: rollout-status.mjs <portalUrl | rolloutId --service-group=NAME> [--tree] [--json]");
  process.exit(2);
}

/**
 * Does this look like a portal URL?
 *
 * NOT `startsWith("http")`: iris's findEv2PortalUrl returns the host without a scheme
 * (`ra.ev2portal.azure.net/#/rollouts/...`), because that is how it appears in the pipeline log it is
 * scraped from. Measured -- with a scheme check the whole URL was taken as a rolloutId and the tool
 * asked for a --service-group that was sitting in the argument it had just rejected.
 */
function looksLikePortalUrl(s) {
  return /ev2portal\.azure\.net/.test(String(s ?? "")) || /^https?:\/\//.test(String(s ?? ""));
}

/**
 * Is there an EV2 credential at all?
 *
 * Probed BEFORE calling iris, not inferred from an error string. Every fetching function here needs a
 * client certificate (`rolloutToken` → `fetchRollout` → everything else), and iris returns
 * `{error: "ENOENT ..."}` rather than throwing -- which is exactly the shape that gets skimmed as "no
 * failures found". A missing credential means the rollout state is UNKNOWN, and unknown must never be
 * reported as healthy.
 */
function credentialPath() {
  return process.env.EV2_CONFIG ?? path.join(os.homedir(), ".ev2", "config.yaml");
}

if (!fs.existsSync(credentialPath())) {
  console.error("EV2 rollout status is NOT AVAILABLE in this environment.");
  console.error(`  no EV2 credentials: ${credentialPath()} does not exist`);
  console.error("  This is NOT \"the rollout is fine\" and NOT \"no failures found\".");
  console.error("  The rollout state is UNKNOWN from here. Report it as unknown, with the link:");
  console.error(`  ${looksLikePortalUrl(target) ? target : `rolloutId ${target}`}`);
  process.exit(3);   // distinct from 1 (a real failure) so a caller can tell them apart
}

const parsed = looksLikePortalUrl(target) ? ev2.parsePortalUrl(target) : null;
const rolloutId = parsed?.rolloutId ?? target;
const serviceGroup = parsed?.serviceGroup ?? flag("service-group");
const infra = parsed?.infra ?? flag("infra") ?? "prod";

if (!serviceGroup) {
  console.error("A rolloutId needs --service-group=NAME (a portal URL carries it already).");
  console.error("Not defaulted on purpose: a wrong service group reports on somebody else's rollout.");
  process.exit(2);
}

function printFailure(f, indent = "  ") {
  console.log(`${indent}FAILED ${f.name ?? ""} / ${f.step ?? ""}: ${f.errorCode ?? ""} ${f.errorReason ?? ""}`);
  console.log(`${indent}  resource=${f.resourceGroup ?? "?"}/${f.resource ?? "?"}${f.correlationId ? ` correlation=${f.correlationId}` : ""}`);
  for (const e of f.evidence ?? []) {
    console.log(`${indent}  ${e.source}${e.shellName ? ` shell=${e.shellName}` : ""}${e.exitCode !== undefined ? ` exit=${e.exitCode}` : ""}${e.truncated ? " [truncated]" : ""}`);
    if (e.message) console.log(`${indent}    ${e.message.replace(/\n/g, `\n${indent}    `)}`);
  }
  if (f.evidenceTruncated) console.log(`${indent}  Additional evidence omitted. Read the raw rollout for complete detail.`);
}

if (has("tree")) {
  // The recursive walk. A ring orchestration's top-level ResourceGroups is empty, so a flat read
  // reports "0 actions" for a rollout that is busy or broken several rings down.
  const node = await ev2.rolloutProgress(rolloutId, serviceGroup, infra);
  const rows = ev2.flattenProgress(node);
  if (has("json")) {
    console.log(JSON.stringify(rows, null, 1));
  } else {
    for (const r of rows) {
      const indent = "  ".repeat(r.path.split("/").length - 1);
      console.log(`${indent}${r.path}  ${r.status ?? "?"}  ${JSON.stringify(r.counts)}`);
      if (r.error) console.error(`${indent}  UNKNOWN: ${r.error}`);
      for (const a of r.running) console.log(`${indent}  RUNNING ${a.name ?? ""} / ${a.step ?? ""}`);
      for (const f of r.failed) printFailure(f, `${indent}  `);
    }
  }
  process.exit(rows.some((r) => r.error) ? 3 : rows.some((r) => r.failed.length || r.status === "Failed") ? 1 : 0);
}

let rollout;
try {
  rollout = await ev2.fetchRollout(rolloutId, serviceGroup, infra);
} catch (error) {
  console.error(`EV2 returned an error rather than a rollout: ${error.message}`);
  console.error("Treat this as UNKNOWN, not as success.");
  process.exit(3);
}

const summary = ev2.summarizeActions(rollout);
const failed = ev2.extractFailedActions(rollout);
const rings = ev2.childRings(rollout);

if (has("json")) {
  console.log(JSON.stringify({ rolloutId, serviceGroup, infra, summary, failed, rings }, null, 1));
} else {
  console.log(`rollout ${rolloutId}  ${rollout.Status ?? rollout.status ?? "?"}`);
  console.log(`  actions: ${JSON.stringify(summary.counts)}`);
  for (const a of summary.running) console.log(`  RUNNING ${a.name ?? ""} / ${a.step ?? ""}`);
  for (const f of failed) printFailure(f);
  // A rollout with child rings and no actions of its own is the shape that reads as clean while the
  // real state is several rings down. Say so rather than letting the empty counts speak.
  // `counts` is the field summarizeActions returns -- checked against a real rollout, because a
  // guessed field name would make this branch dead code and the warning would silently never appear.
  const own = Object.keys(summary.counts ?? {}).length;
  if (!failed.length && rings.length && !own) {
    console.log(`  This is a ring orchestration with ${rings.length} child ring(s) and no actions of`);
    console.log("  its own -- re-run with --tree, or the real state stays hidden.");
  }
  // Distinct from the above: no rings AND no actions. A completed rollout can have its action detail
  // aged out, so this is not an error -- but it is not per-action confirmation either.
  if (!failed.length && !rings.length && !own) {
    console.log("  No per-action detail returned (EV2 keeps it only for a while after completion).");
    console.log("  The Status above is the answer; there is nothing action-level to confirm it with.");
  }
}
process.exit(failed.length || summary.status === "Failed" ? 1 : 0);
