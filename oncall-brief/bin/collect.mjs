#!/usr/bin/env node
/**
 * Collect all OnCall daily-brief data sources in parallel, print one JSON blob.
 *
 * The agent should run this ONCE, read the JSON, then organize the report and send
 * it (Obsidian + ~/Tasks/Scrum + Notes to self). All API/query logic lives here so it
 * runs fast and identically every day — the agent does not re-derive commands.
 *
 * Usage:  collect.mjs            # today (Sydney) window
 *         collect.mjs 2026-07-03 # explicit date
 * Output: JSON on stdout: {date, icm, pipelines, requestErrors, mail, channels, errors}
 * Any source that fails is recorded under its key as {"error": "..."} and in
 * top-level "errors"; the run never aborts on a single source.
 *
 * Node ESM port of collect.py — calls the iris TS SDK instead of Python msapi.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { icm, ado, ev2, kusto, webjobs } from "../../_iris-shared/index.mjs";

// Current UTC as ISO string, for overdue next-action comparison (IcM NextActionTime
// is an ISO timestamp string).
const NOW_UTC = new Date().toISOString().replace(/\.\d{3}Z$/, "");

// Sibling skills live next to this one. In the loop container HOME is /home/app
// but the skills are copied to CLAUDE_CONFIG_DIR/skills, so homedir() alone
// resolves to a path that does not exist.
const SKILLS = process.env.CLAUDE_CONFIG_DIR
  ? path.join(process.env.CLAUDE_CONFIG_DIR, "skills")
  : path.join(os.homedir(), ".claude/skills");

// iris's ADO reads shell out to `az`, which the loop container image does not
// carry: there they throw `spawnSync az ENOENT`, and since every pipeline is
// collected under its own try/catch that lands as a quiet per-pipeline error --
// i.e. a report that looks all-green while nothing was checked. So pick the REST
// twins when az is missing. Both return the same shapes.
const AZ = ado.hasAz();
const adoRead = {
  recentRuns: (defId, o) => (AZ ? ado.recentRuns(defId, o) : ado.recentRunsRest(defId, o)),
  timeline: (buildId) => (AZ ? ado.timeline(buildId) : ado.timelineRest(buildId)),
  logLines: (buildId, logId) => (AZ ? ado.logLines(buildId, logId) : ado.logLinesRest(buildId, logId)),
  restText: (url) => (AZ ? ado.restText(url) : ado.restTextRest(url)),
  releaseDetail: (defId) => (AZ ? ado.releaseDetail(defId) : ado.releaseDetailRest(defId)),
  findEv2PortalUrl: (buildId) => (AZ ? ado.findEv2PortalUrl(buildId) : ado.findEv2PortalUrlRest(buildId)),
};

const ORG = "https://dev.azure.com/msazure";
const PROJ = "One";
const KUSTO_CLUSTER = "https://betprod.westus2.kusto.windows.net";
const KUSTO_DB = "Lionrock";
// Geneva log (Lionrock .NET ILogger) — for drilling error messages behind a plan/request
const GENEVA_CLUSTER = "https://agboa.westus2.kusto.windows.net";
const GENEVA_DB = "lionrock";

// Link bases (the agent renders IDs as clickable links using these)
const ICM_PORTAL = "https://portal.microsofticm.com/imp/v5/incidents/details/{}/summary";
const ICM_QUERY = "https://portal.microsofticm.com/imp/v3/incidents/search/advanced?sl={}";
// All Lionrock request types (sub/parent/planned-quota) share this detail path
const REQUEST_PORTAL = "https://lionrock-prod.microsoftlionrock.com/quota/requests/{}";
// Regional plan (item k) has no RequestId — link by ServiceTreeId + Blueprint
const PLAN_PORTAL = "https://lionrock-prod.microsoftlionrock.com/quota/plans/services/{}/{}/editor";

// The 5 IcM shared-query shortlinks (sl=) — bucket headers link to these.
// If a query definition changes, get the new sl / filter from the user.
const ICM_QUERY_LINKS = {
  "By Monitor": "u2v5or3w5s2",
  "CIS RP": "khb3flgx3td",
  "CIS-Ev2 Bridge": "3rjfdtvnbt5",
  "PlannedQuotas": "dvgzsods0wx",
  "Other": "134mc43rc2c",
};

// Build pipelines (item d/f/g) + EV2 release (item e)
const BUILD_PIPELINES = {
  rolling: { id: 421909, name: "Lionrock Rolling Test", item: "d" },
  plannedQuotaArm: { id: 440083, name: "Planned Quota ARM Daily Test", item: "f" },
  releaseIncremental: { id: 393677, name: "Lionrock Release Incremental - Test", item: "g" },
};
const EV2_RELEASE_DEF = 20382; // item e (Daily UAT == Ev2 Automation), vsrm release

// item n / backup duty 5 — the UAT webjob site. Reported for a long time as "manual,
// needs SAW, skipped", which was wrong twice over: it needs no SAW, and the skipping hid
// a job that had failed on all 28 retained runs plus one that had never completed.
//
// It does need the workload identity: this subscription is invisible to an ordinary
// `az login` account, which is probably how the SAW belief started.
const WEBJOB_SITE = {
  subscription: "c9e275b8-def5-4853-b8e3-47b4255228cc", // CIS_Lionrock_NonProd
  resourceGroup: "lionrock-uat",
  site: "lionrock-webjob-uat",
};

// Lionrock external-table error views (items h/i/j/k/l)
const ERROR_TABLES = [
  ["subRequest", "SubRequest", 'Status == "Error"', "CreatedTime", "h"],
  ["parentRequest", "Request", 'Status == "CompletedWithError"', "CreatedTime", "i"],
  ["plannedQuotaRequest", "PlannedQuotaRequest", 'Status == "Error"', "CreatedTime", "j"],
  ["planRegion", "PlanRegion", 'Status == "Error"', "SubmitTime", "k"],
  ["capacityOrder", "CapacityOrder", 'Status == "Failed"', "CreatedTime", "l"],
];

// Teams channels (item a/m) — teamId b19d6aa1-7d0c-490b-9c55-c6bd9debf861
const CHANNELS = {
  askForSupport: "19:049604f9b8b14a3a9b2b8704a408ef53@thread.tacv2",
  featureRequests: "19:d84538faff744e20a0ec7ed51db933de@thread.tacv2",
  agcSupport: "19:dd7df7dcb23b4111a0bce4fb2a247b3c@thread.tacv2",
};

// Item c is this mailbox, NOT the personal inbox the mail tool reads by default. See
// collectMail for what that distinction was quietly costing.
const SUPPORT_MAILBOX = process.env.ONCALL_SUPPORT_MAILBOX || "bowloper@microsoft.com";

// NOTE: the local re-implementation of the 5 "Pending Action" queries used to live here
// (MonitorId / OwningTeamId → family). It is gone: collectIcm now runs the team's own saved
// queries via icm.pendingByFamily, so the grouping comes from the portal rather than from a
// copy of its rules that could drift from them. icmTitleFamily below is still used, for
// sub-grouping WITHIN a family.

function icmTitleFamily(title) {
  // Collapse an IcM title to a coarse family so a bucket of ~100 fans down to a
  // handful of categories. Handles both Region-Access '@ErrorName' titles and the
  // CIS task-style '[WABO] … Task <X>' titles.
  const t = title || "";
  let m = /@(\w+)/.exec(t); // …@GenevaActionsOperationsError
  if (m) return m[1];
  m = /Error occurred \d+:([^\s@]+)/.exec(t); // Error occurred 500499:<Name>
  if (m) return m[1];
  m = /\bTask\s+([A-Za-z0-9_.\-]+)/.exec(t); // [WABO] … Task <X>
  if (m) return "Task " + m[1];
  return t.slice(0, 40);
}

function run(cmd, timeout = 180) {
  // Run a command, return stdout text (raises on non-zero).
  try {
    return execFileSync(cmd[0], cmd.slice(1), { encoding: "utf-8", timeout: timeout * 1000, maxBuffer: 64 * 1024 * 1024 });
  } catch (e) {
    const err = e;
    const text = String(err.stderr || err.stdout || `exit ${err.status}`);
    throw new Error(explainFailure(cmd, text));
  }
}

/**
 * Turn a failed sub-command into something a reader can act on.
 *
 * The one case worth detecting is a helper script that is not there at all. Several items
 * come from the Agent365 `o-*` skills, which need interactive broker auth and so are not
 * installed in the container -- a permanent, expected difference, not a fault. Left raw it
 * surfaces as 400 characters of `MODULE_NOT_FOUND` with a Node stack, which reads like the
 * tool crashed. That is the wrong thing to put in front of someone doing an on-call
 * checkpoint: it invites either "the collector is broken" or, worse, treating the item as
 * clear because the message was unreadable.
 *
 * Everything else passes through, truncated. A real failure should look like one.
 */
function explainFailure(cmd, text) {
  if (/MODULE_NOT_FOUND|Cannot find module/.test(text)) {
    // The missing path is in the message; name the SKILL, which is what a reader can check.
    const m = /Cannot find module '([^']+)'/.exec(text);
    const skill = m ? (m[1].split("/skills/")[1] || m[1]).split("/")[0] : path.basename(cmd[1] ?? "?");
    return `not available in this environment: ${skill} is not installed`;
  }
  return text.slice(0, 400);
}

// ---- IcM (items 1 and d) -------------------------------------------------
/**
 * The pending-action queue, from the team's OWN saved queries.
 *
 * This used to call `icm.pendingActions()` and re-cluster the result locally, which was
 * wrong twice over. That reads the Kusto warehouse, 10-15 minutes behind and including
 * incidents already drained, and it invented its own grouping instead of using the
 * portal's. Measured side by side on the same morning: the warehouse path reported 127
 * incidents in 4 groups with PlannedQuotas missing entirely, while the saved queries
 * returned 56 in all 5 -- so the report was more than twice the real queue and silently
 * dropped a family.
 *
 * `icm.pendingByFamily()` runs the five authoritative queries under the "Pending Action"
 * folder against the live /api2 face, and excludes anything already tagged
 * `oncall-bot-handled`. So what comes back is the unhandled set, grouped the way the team
 * groups it. **Do not re-cluster the families** -- the grouping IS the answer. Sub-grouping
 * WITHIN a family by title is still worth it, because one root cause fanning out into 40
 * incidents is one investigation.
 *
 * It also carries a reconciliation check: groupedCount should equal allCount (the
 * "- All" query). When it does not, a family query has drifted and the number is suspect.
 */
async function collectIcm() {
  const r = await icm.pendingByFamily();

  // What the portal shows, alongside what pendingByFamily returns.
  //
  // pendingByFamily excludes anything tagged `oncall-bot-handled`, which is what makes a
  // drained family drop out of tomorrow's run. The catch is that the tag is permanent while
  // the incident is not: measured 2026-08-21, the five queries held 106 incidents in the
  // portal, 65 of them tagged, and ALL 65 still ACTIVE -- some tagged three weeks earlier.
  // So a report built on the filtered number alone reads "By Monitor: 11" against a portal
  // showing 48, and "CIS-Ev2 Bridge: clear" against one that has an open incident.
  //
  // Both numbers are wanted for different questions: untagged = what needs work now,
  // portal = what the team actually has open. Reporting only the first understates the queue
  // by whatever has accumulated, which grows every run.
  const portalCounts = {};
  for (const fam of r.families ?? []) {
    try {
      const q = await icm.sharedQueryIncidents(fam.name, { folder: r.folder ?? "Pending Action" });
      const rows = q.incidents ?? [];
      const tagged = rows.filter((i) => String(i.Keywords || "").includes("oncall-bot-handled"));
      portalCounts[fam.family] = {
        portal: rows.length,
        handled: tagged.length,
        // A tagged incident that is still ACTIVE was hidden rather than finished.
        handledStillActive: tagged.filter((i) => String(i.Status ?? i.State ?? "").toUpperCase() === "ACTIVE").length,
      };
    } catch (e) {
      portalCounts[fam.family] = { error: String(e.message).slice(0, 120) };
    }
  }

  // Field names differ from the warehouse shape: Id not IncidentId, ContactAlias not
  // OwningContactAlias, and PortalUrl arrives ready-made.
  const slim = (inc) => ({
    IncidentId: inc.Id ?? null,
    Title: inc.Title ?? null,
    Severity: inc.Severity ?? null,
    State: inc.State ?? null,
    OwningTeamName: inc.OwningTeamName ?? null,
    OwningContactAlias: inc.ContactAlias ?? null,
    portalUrl: inc.PortalUrl ?? ICM_PORTAL.replace("{}", String(inc.Id ?? "")),
    // Distinguishes a burst from N separate problems, which is the first thing to know.
    hitCount: inc.HitCount ?? null,
    customerImpacting: inc.IsCustomerImpacting ?? null,
    // `new` = never triaged by us; `awaiting-decision` = a prior run already proposed
    // something and is waiting on a human. The second must NOT be re-investigated.
    oncallState: inc.oncallState ?? null,
    acknowledged: inc.NotificationStatus === "Acknowledged" ? true
      : inc.NotificationStatus ? false : null,
  });

  const all = [];
  const groups = [];
  for (const fam of r.families ?? []) {
    const rows = fam.incidents ?? [];
    for (const inc of rows) all.push(inc);
    if (!rows.length) {
      // An empty family is information: it says that query was checked and is clear.
      groups.push({ query: fam.family, name: fam.name, queryId: fam.queryId, count: 0,
        ...(portalCounts[fam.family] ? { portalCount: portalCounts[fam.family] } : {}), families: [] });
      continue;
    }

    const fams = {};
    for (const inc of rows) {
      const f = icmTitleFamily(inc.Title || "");
      const fg = fams[f] = fams[f] || { family: f, count: 0, sample: null, hits: 0, assignees: new Set() };
      fg.count += 1;
      fg.hits += inc.HitCount ?? 0;
      fg.assignees.add(inc.ContactAlias || "");
      // Newest as the representative, so the link goes to a live example.
      if (fg.sample === null || (inc.Id ?? 0) > (fg.sample.IncidentId ?? 0)) fg.sample = slim(inc);
    }
    const families = Object.values(fams).map((f) => ({
      family: f.family,
      count: f.count,
      hits: f.hits,
      sample: f.sample,
      unassigned: f.assignees.has("") && f.assignees.size === 1,
      // Nothing to re-investigate here; a prior run is waiting on a person.
      awaitingDecision: rows.some((i) => i.oncallState === "awaiting-decision"
        && icmTitleFamily(i.Title || "") === f.family),
    })).sort((a, b) => b.count - a.count);

    const assignees = {};
    for (const inc of rows) {
      const a = inc.ContactAlias || "UNASSIGNED";
      assignees[a] = (assignees[a] || 0) + 1;
    }
    const sortedAssignees = {};
    for (const [k, v] of Object.entries(assignees).sort((x, y) => y[1] - x[1])) sortedAssignees[k] = v;

    groups.push({
      query: fam.family,
      name: fam.name,
      queryId: fam.queryId,
      count: rows.length,
      ...(portalCounts[fam.family] ? { portalCount: portalCounts[fam.family] } : {}),
      queryUrl: ICM_QUERY.replace("{}", ICM_QUERY_LINKS[fam.family] || ""),
      assignees: sortedAssignees,
      families,
    });
  }

  // flagged = Sev<=2 OR mine OR unassigned OR customer-impacting. No NextActionTime here:
  // the saved queries already ARE the pending-action set, so "overdue" is not a further
  // distinction the way it was against the warehouse.
  const flagged = [];
  for (const inc of all) {
    const sev = inc.Severity ?? 9;
    const mine = inc.ContactAlias === (process.env.ICM_ALIAS || "haichang");
    const unowned = !(inc.ContactAlias || "");
    if (sev <= 2 || mine || unowned || inc.IsCustomerImpacting) {
      const f = slim(inc);
      f.reason = sev <= 2 ? `Sev${sev}`
        : inc.IsCustomerImpacting ? "customer-impacting"
          : mine ? "mine" : "unassigned";
      flagged.push(f);
    }
  }
  // Worst first: severity, then customer impact.
  flagged.sort((a, b) => (a.Severity ?? 9) - (b.Severity ?? 9)
    || Number(Boolean(b.customerImpacting)) - Number(Boolean(a.customerImpacting)));

  const portalTotal = Object.values(portalCounts).reduce((n, v) => n + (v.portal ?? 0), 0);
  const hiddenStillActive = Object.values(portalCounts).reduce((n, v) => n + (v.handledStillActive ?? 0), 0);

  return {
    count: r.groupedCount ?? all.length,
    // What the portal shows, and how much of the gap is tagged-but-still-open. Report both:
    // `count` is the work to do, `portalCount` is what the team sees.
    portalCount: portalTotal,
    handledStillActive: hiddenStillActive,
    allCount: r.allCount ?? null,
    // false means a family query has drifted and the counts do not add up -- say so
    // rather than presenting the total as solid.
    reconciled: r.allCount == null ? null : r.groupedCount === r.allCount,
    folder: r.folder ?? null,
    groups,
    flagged,
  };
}

// ---- Build pipelines (item d/f/g) with failure drill-down ----------------
async function timelineFailures(buildId) {
  // Return failed timeline tasks + the top error lines from their logs.
  // Raw ADO calls via iris ado; the log-failure extraction is oncall-specific.
  let records;
  try {
    records = await adoRead.timeline(buildId);
  } catch (e) {
    return { error: `timeline: ${e.message}` };
  }
  const failed = records.filter((r) => r.result === "failed");
  const tasks = [];
  for (const r of failed) {
    const entry = {
      type: r.type,
      name: r.name,
      issues: (r.issues || []).map((i) => i.message).filter((m) => m),
    };
    const logId = (r.log || {}).id;
    if (r.type === "Task" && logId) {
      try {
        const hits = [];
        for (let ln of await adoRead.logLines(buildId, logId)) {
          ln = ln.replace(/\x1b\[[0-9;]*m|\[\d+m/g, ""); // strip ANSI/color codes
          ln = ln.replace(/^\S*Z\s+/, "").trim(); // strip leading timestamp
          if (/(^failed\s|Assert\.\w+ failed|Test run summary|exited with code)/i.test(ln)
            && !ln.includes("at Microsoft.VisualStudio")) {
            hits.push(ln);
          }
        }
        entry.logFailures = hits.slice(-25);
      } catch (e) {
        entry.logError = String(e.message).slice(0, 150);
      }
    }
    tasks.push(entry);
  }
  return { failedTasks: tasks };
}

async function inprogressEv2Rollout(buildId) {
  // For an in-progress run, find the EV2 rollout task still running and ask EV2
  // for its REAL status (a run can sit inProgress for up to 7 days on a failed
  // rollout — the ADO run never flips to `failed`). Returns the EV2 rollout status
  // dict, or None if no EV2 rollout step is in flight.
  let records;
  try {
    records = await adoRead.timeline(buildId);
  } catch (e) {
    return { error: `timeline: ${e.message}` };
  }
  let cand = records.filter((r) =>
    r.type === "Task"
    && /ev2.*rollout|rollout/i.test(r.name || "")
    && r.state !== "completed");
  if (!cand.length) {
    cand = records.filter((r) =>
      r.type === "Task" && /ev2/i.test(r.name || "")
      && r.state !== "completed");
  }
  for (const r of cand) {
    const logId = (r.log || {}).id;
    if (!logId) continue;
    let logtxt;
    try {
      logtxt = (await adoRead.logLines(buildId, logId)).join("\n");
    } catch {
      continue;
    }
    const m = /ra\.ev2portal\.azure\.net\/#\/rollouts\/\S+/.exec(logtxt);
    if (m) {
      const st = await ev2.rolloutStatus(m[0].replace(/[.,)]+$/, ""));
      st.task = r.name;
      return st;
    }
  }
  return null;
}

async function collectBuildPipeline(key, meta) {
  const defId = meta.id;
  let runs;
  try {
    runs = await adoRead.recentRuns(defId, { top: 6 });
  } catch (e) {
    return [key, { item: meta.item, name: meta.name, defId, error: String(e.message) }];
  }
  const result = {
    item: meta.item,
    name: meta.name,
    defId,
    pipelineUrl: `${ORG}/${PROJ}/_build?definitionId=${defId}`,
    runs,
    latest: runs.length ? runs[0] : null,
  };

  // If the latest run is still in progress, don't blindly trust the last completed
  // one — check whether it's stuck on an EV2 rollout, and get the rollout's REAL
  // status from EV2 (it won't surface as a `failed` ADO run for up to 7 days).
  const latest = runs.length ? runs[0] : null;
  if (latest && latest.status === "inProgress") {
    const ev2Status = await inprogressEv2Rollout(latest.id);
    if (ev2Status) {
      result.inProgressRollout = {
        num: latest.num,
        runUrl: `${ORG}/${PROJ}/_build/results?buildId=${latest.id}`,
        ...ev2Status,
      };
      // EV2 says Failed / has failed actions -> this is a real failure to report,
      // even though the ADO run still shows inProgress.
      // EV2 still Running -> in flight; the report should fall back to the last
      // completed run (below) but note the rollout is in progress.
    }

    // A run can also sit inProgress with NO rollout url in its log yet (it died
    // before printing one), so inProgressRollout stays null and the report would
    // quietly fall back to lastCompleted -- reading as green while the pipeline
    // has not finished a run for days. Age the in-flight run so that is visible.
    const anchor = runs.find((r) => r.status === "completed" && r.finished);
    const ageHours = anchor
      ? Math.round((Date.parse(NOW_UTC + "Z") - Date.parse(anchor.finished)) / 36e5)
      : null;
    result.inFlight = {
      num: latest.num,
      runUrl: `${ORG}/${PROJ}/_build/results?buildId=${latest.id}`,
      rolloutFound: Boolean(result.inProgressRollout),
      hoursSinceLastCompleted: ageHours,
      stale: ageHours !== null && ageHours >= 24,
    };
  }

  // Drill failed runs newest-first; keep the first one that yields concrete log
  // failures (some "failed" runs are empty EV2-rollout tasks with no test detail).
  for (const r of runs) {
    if (r.result !== "failed") continue;
    const tl = await timelineFailures(r.id);
    const hasDetail = (tl.failedTasks || []).some((t) => t.logFailures);
    const drill = { num: r.num, runUrl: `${ORG}/${PROJ}/_build/results?buildId=${r.id}`, ...tl };
    if (hasDetail || !("failedRun" in result)) {
      result.failedRun = drill; // remember first failed run as fallback
    }
    if (hasDetail) break; // prefer a run with real test/assertion detail
  }

  // The "last completed" run — what to trust when the latest is still in flight.
  result.lastCompleted = runs.find((r) => r.status === "completed") || null;

  // EV2 rollout link for the representative run (even when it succeeded — the
  // on-call wants the rollout link regardless of outcome). Prefer the latest
  // completed run; fall back to the newest run.
  const rep = result.lastCompleted || result.latest;
  if (rep) {
    try {
      const url = await adoRead.findEv2PortalUrl(rep.id);
      if (url) {
        result.ev2RolloutUrl = !url.startsWith("http") ? "https://" + url : url;
      }
    } catch {
      // ignore
    }
  }
  return [key, result];
}

// ---- EV2 Automation release (item e) -------------------------------------
function cleanLogLine(ln) {
  ln = ln.replace(/\x1b\[[0-9;]*m|\[\d+m/g, ""); // ANSI/color
  return ln.replace(/^\S*Z\s+/, "").trim(); // leading timestamp
}

async function releaseFailures(detail) {
  // Drill a release detail's rejected/failed environments down to the failing
  // tasks and the key log lines (named tests / asserts / rollout status). Returns
  // a list of {env, task, issues, logFailures}.
  const out = [];
  for (const env of detail.environments || []) {
    if (!["rejected", "failed", "partiallySucceeded"].includes(env.status)) continue;
    for (const dep of env.deploySteps || []) {
      for (const phase of dep.releaseDeployPhases || []) {
        for (const dj of phase.deploymentJobs || []) {
          for (const task of dj.tasks || []) {
            if (!["failed", "partiallySucceeded"].includes(task.status)) continue;
            const entry = {
              env: env.name,
              task: task.name,
              issues: (task.issues || []).map((i) => i.message).filter((m) => m),
            };
            const lu = task.logUrl;
            if (lu) {
              try {
                const hits = [];
                for (let ln of (await adoRead.restText(lu)).split(/\r?\n/)) {
                  ln = cleanLogLine(ln);
                  if (/(^Failed\s|Assert\.\w+ failed|Total tests|Test Run Failed)/i.test(ln)
                    && !ln.includes("ExceptionDispatchInfo")) {
                    hits.push(ln);
                  }
                }
                entry.logFailures = hits.slice(-15);
              } catch (e) {
                entry.logError = String(e.message).slice(0, 150);
              }
            }
            out.push(entry);
          }
        }
      }
    }
  }
  return out;
}

async function collectEv2() {
  try {
    const detail = await adoRead.releaseDetail(EV2_RELEASE_DEF);
    if ("error" in detail) {
      return { item: "e", defId: EV2_RELEASE_DEF, error: detail.error };
    }
    const envs = (detail.environments || []).map((e) => ({ name: e.name, status: e.status }));
    const res = {
      item: "e",
      name: "Daily UAT == Ev2 Automation",
      defId: EV2_RELEASE_DEF,
      releaseUrl: detail.releaseUrl,
      latestRelease: detail.name,
      environments: envs,
    };
    // If any env is not clean, drill down to the failing tasks + log detail.
    if (envs.some((e) => ["rejected", "failed", "partiallySucceeded"].includes(e.status))) {
      res.failures = await releaseFailures(detail);
    }
    return res;
  } catch (e) {
    return { item: "e", defId: EV2_RELEASE_DEF, error: String(e.message) };
  }
}

// item n / backup duty 5 — WebJobs on the UAT site.
//
// Reports the run HISTORY for anything failing, not just the latest status, because "it
// failed today" and "it has failed every retained run for a month" call for completely
// different responses and only the second is worth waking anyone. Same for the failure
// text: the raw log is mostly MSAL trace, so hand back the extracted cause.
// Budget for the whole duty, not per HTTP attempt -- iris caps each attempt at 60s and
// retries the transient failures inside this. Measured: a successful ARM list takes 4 to
// 44s, one call in five is a gateway timeout, and history costs one more round trip per
// failing job. 150s covers a retry on the slow path and still fails fast enough that a
// broken endpoint does not hold up the rest of the collect.
//
// Do NOT raise this expecting reliability. It buys retries, not patience: an earlier
// version passed the budget straight through to each attempt, and 300s turned into a
// 13-minute run before something killed it.
const WEBJOB_TIMEOUT = 150;

async function collectWebJobs() {
  try {
    const h = await webjobs.health(WEBJOB_SITE, new Date(), WEBJOB_TIMEOUT);
    const detail = async (job) => {
      const out = { name: job.name, schedule: job.schedule, status: job.status, startTime: job.startTime };
      try {
        const runs = await webjobs.runHistory(WEBJOB_SITE, job.name, WEBJOB_TIMEOUT);
        out.retainedRuns = runs.length;
        out.statusCounts = runs.reduce((a, r) => ({ ...a, [r.status]: (a[r.status] || 0) + 1 }), {});
        out.oldestRetained = runs.at(-1)?.startTime;
      } catch (e) {
        out.historyError = String(e.message).slice(0, 120);
      }
      if (job.outputUrl) {
        try { out.failure = webjobs.extractFailure(await webjobs.runLog(job.outputUrl, WEBJOB_TIMEOUT), 8); }
        catch (e) { out.logError = String(e.message).slice(0, 120); }
      }
      return out;
    };

    return {
      item: "n",
      name: `WebJobs ${WEBJOB_SITE.site}`,
      site: h.site,
      // Per-half read errors. ARM degrades one endpoint at a time here, so `failed: []`
      // alongside `errors.triggered` means "not read", not "nothing failed".
      ...(h.errors ? { errors: h.errors } : {}),
      portalUrl: `https://portal.azure.com/#@microsoft.onmicrosoft.com/resource/subscriptions/${WEBJOB_SITE.subscription}/resourceGroups/${WEBJOB_SITE.resourceGroup}/providers/Microsoft.Web/sites/${WEBJOB_SITE.site}/webJobs`,
      continuous: { total: h.continuous.total, notRunning: h.continuous.notRunning },
      triggered: {
        total: h.triggered.total,
        runningOk: h.triggered.running.map((j) => j.name),
        failed: await Promise.all(h.triggered.failed.map(detail)),
        overrunning: await Promise.all(h.triggered.overrunning.map(detail)),
        slowThisRun: h.triggered.slowThisRun.map((j) => ({ name: j.name, schedule: j.schedule, startTime: j.startTime })),
      },
    };
  } catch (e) {
    return { item: "n", name: `WebJobs ${WEBJOB_SITE.site}`, error: String(e.message).slice(0, 200) };
  }
}

// Per-table detail projection for the 24h error rows (non-zero buckets get listed).
// `requestUrl` is added for tables whose key is a Lionrock RequestId.
const ERROR_DETAIL = {
  subRequest: [["ParentRequestId", "SubRequestId", "RequestServiceType", "SKU", "CreatedTime"], "ParentRequestId"],
  parentRequest: [["RequestId", "Requestor", "Submitter", "Region", "RequestSource", "CreatedTime"], "RequestId"],
  plannedQuotaRequest: [["RequestId", "Region", "Blueprint", "ContactEmail", "CreatedTime"], "RequestId"],
  planRegion: [["ServiceTreeId", "Blueprint", "Region", "Version", "Submitter", "SubmitTime"], null],
  capacityOrder: [["Id", "IsHobo", "CreatedTime"], null], // do NOT project ExpiryDate (breaks the view)
};

async function genevaPlanError(servicetreeId, region) {
  // Item k requires the error MESSAGE via Geneva log. Find the ProcessNewPlansJob
  // failure (root cause) for a PlanRegion that's in Error, plus a contributing line.
  try {
    const regionClause = region ? ` or FormattedMessage has "${region}"` : "";
    const kql = `Log
| where PreciseTimeStamp >= ago(2d)
| where FormattedMessage has "${servicetreeId}"${regionClause}
| where Level >= 3
| project PreciseTimeStamp, LoggerName, Level, FormattedMessage
| order by PreciseTimeStamp desc
| take 20`;
    const { rows } = await kusto.queryKusto(GENEVA_CLUSTER, GENEVA_DB, kql);
    const root = rows.find((r) => (r.LoggerName || "").includes("ProcessNewPlansJob")
      && (r.FormattedMessage || "").includes("Failed to process")) || null;
    // contributing = a DIFFERENT logger's error (e.g. Batch SKU auth) matched by region
    const contrib = rows.find((r) => r.LoggerName !== (root || {}).LoggerName
      && !(r.LoggerName || "").includes("ProcessNewPlansJob")) || null;

    const line = (r) => {
      if (!r) return null;
      const msg = (r.FormattedMessage || "").replace(/\s+/g, " ").trim();
      return { logger: r.LoggerName, msg: msg.slice(0, 280) };
    };
    return { rootCause: line(root), contributing: line(contrib) };
  } catch (e) {
    return { error: String(e.message).slice(0, 150) };
  }
}

// ---- Lionrock external-table error views (item h/i/j/k/l) -----------------
async function collectRequestErrors() {
  const result = {};
  for (const [key, tbl, flt, tk, item] of ERROR_TABLES) {
    try {
      const { rows: tot } = await kusto.queryKusto(KUSTO_CLUSTER, KUSTO_DB, `external_table('${tbl}') | where ${flt} | count`);
      const { rows: r24 } = await kusto.queryKusto(KUSTO_CLUSTER, KUSTO_DB,
        `external_table('${tbl}') | where ${flt} | where ${tk} >= ago(24h) | count`);
      const new24h = r24[0].Count;
      const entry = { item, table: tbl, new24h, total: tot[0].Count };
      // Non-zero buckets: pull the actual rows so the report can show WHAT failed.
      if (new24h) {
        const [proj, idField] = ERROR_DETAIL[key];
        const { rows } = await kusto.queryKusto(KUSTO_CLUSTER, KUSTO_DB,
          `external_table('${tbl}') | where ${flt} | where ${tk} >= ago(24h) `
          + `| project ${proj.join(",")} | sort by ${tk} desc | take 25`);
        for (const r of rows) {
          if (idField && r[idField]) {
            r.requestUrl = REQUEST_PORTAL.replace("{}", r[idField]);
          }
          // planRegion: link by ServiceTreeId + Blueprint (no RequestId)
          if (key === "planRegion" && r.ServiceTreeId && r.Blueprint) {
            r.planUrl = PLAN_PORTAL.replace("{}", r.ServiceTreeId).replace("{}", r.Blueprint);
          }
        }
        entry.rows = rows;
        if (proj.includes("Region")) {
          const reg = {};
          for (const r of rows) {
            reg[r.Region] = (reg[r.Region] || 0) + 1;
          }
          entry.byRegion24h = Object.entries(reg)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => ({ region: k, count: v }));
        }
        // item k: drill the error message via Geneva log (per the checklist)
        if (key === "planRegion") {
          for (const r of rows) {
            r.genevaError = await genevaPlanError(r.ServiceTreeId, r.Region);
          }
        }
      }
      result[key] = entry;
    } catch (e) {
      result[key] = { item, table: tbl, error: String(e.message).slice(0, 150) };
    }
  }
  return result;
}

// ---- bowloper support mail (item c) --------------------------------------
/**
 * Item c, deliberately WITHOUT the content.
 *
 * The mailbox may be read to work out what is going on. Its contents must not end up in
 * a report, a reply, or anything else that leaves this process -- a support mailbox holds
 * other people's words, subscription ids and business detail, sent to a person rather
 * than to a channel. Reading it and republishing it are different acts and only the
 * first is authorised.
 *
 * So this returns shape, not text: how many threads, over what window, how many look
 * unanswered. That is enough to say "four support mails, two still unanswered, redirect
 * them to the Support channel", which is what item c actually asks for. Anyone who needs
 * the words opens Outlook.
 */
async function collectMail() {
  const { openClient } = await import(path.join(SKILLS, "_o-sdk-shared/client.mjs"));
  const c = await openClient();
  const mail = await c.mail();
  // $select is the enforcement, not just an optimisation: ask only for the two fields the
  // counts need, so no subject or body is fetched into this process at all. Nothing
  // downstream can leak what was never read.
  // Format copied from the host's o-find-mail, which works: the string starts with `?`
  // and the filter value is percent-encoded. Omitting either gives Graph
  // `Request_BadRequest` with nothing naming the cause.
  // `$search`, not `$filter`, and the difference is not cosmetic. The mail tool reads
  // `/me/messages` and cannot be aimed at another mailbox, so a bare date filter counts the
  // PERSONAL inbox -- Azure DevOps notifications, newsletters, the lot. Item c is about
  // bowloper@, and the figure this used to report ("at least 50 threads, 6 unread") was
  // therefore the wrong mailbox entirely. Mail addressed to the shared mailbox arrives here
  // too, so searching by participant isolates it; verified it really filters rather than being
  // ignored, since a nonexistent recipient returns nothing.
  //
  // Two constraints that follow: the KQL term must be QUOTED (bare, Graph rejects the colon
  // with `character ':' is not valid at position 12`), and $search cannot be combined with
  // $filter, so the 7-day window is applied locally below.
  const r = await mail.searchByQuery(
    {
      queryParameters: `?$search=${encodeURIComponent(`"participants:${SUPPORT_MAILBOX}"`)}`
        + `&$top=50&$select=receivedDateTime,isRead`,
    },
    { timeoutMs: 180000 },
  );
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  let recent = 0, unread = 0;
  for (const m of r.messages ?? []) {
    const at = Date.parse(String(m.receivedDateTime ?? ""));
    if (!Number.isFinite(at) || at < cutoff) continue;
    recent++;
    if (m.isRead === false) unread++;
  }
  // A count that equals $top is a page boundary, not an answer. Say so rather than
  // reporting 50 as though the week held exactly fifty.
  const capped = (r.messages ?? []).length >= 50;
  return {
    mailbox: SUPPORT_MAILBOX,
    threads7d: recent,
    ...(capped ? { atLeast: true } : {}),
    unread,
    note: `counts only for ${SUPPORT_MAILBOX}; subjects and bodies are deliberately not fetched`
      + (capped ? ". threads7d is a floor: the page limit was reached" : ""),
  };
}

// ---- Teams channels (item a/b) -------------------------------------------
/**
 * Items a and b, through iris's Agent365 facade.
 *
 * Previously this shelled out to `o-teams-digest`, which is not installed in the
 * container, so all three channels came back as errors and three of the nine checkpoint
 * items were permanently blank. iris talks to the Enterprise Graph MCP gateway with a
 * delegated token from the cache on the PVC, which works in both environments.
 *
 * Channel posts are not private in the way mail is -- they were written to a team -- so
 * the text is kept here: an on-call reading item a needs to know what was asked.
 */
const TEAM_ID = "b19d6aa1-7d0c-490b-9c55-c6bd9debf861";

async function collectChannel(key, channelId) {
  const { openClient } = await import(path.join(SKILLS, "_o-sdk-shared/client.mjs"));
  const c = await openClient();
  try {
    const teams = await c.teams();
    const r = await teams.listChannelMessages({ teamId: TEAM_ID, channelId, top: 8 });
    const posts = [];
    for (const m of r.messages ?? []) {
      const body = String(m.body?.content ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      // A post with no text is a join/leave or a reaction; it is not a support request.
      if (!body) continue;
      const at = String(m.createdDateTime ?? "");
      // Whether anyone has answered IS the question for items a and b, and this line used to
      // read `m.replyCount` -- a field that does not exist on these messages. So it was always
      // undefined, every report said only "N posts exist", and an on-call had to open all of
      // them to find the one still waiting. `listReplies` is the real source. One extra call
      // per post, over 8 posts per channel, which is worth it for the one thing the item asks.
      let replies;
      let answered;
      try {
        const rr = await teams.listReplies({ teamId: TEAM_ID, channelId, messageId: String(m.id), maxReplies: 10 });
        // Only replies AFTER the post count: the list can include the root in some shapes.
        const after = (rr.replies ?? []).filter((x) => String(x.createdDateTime ?? "") > at);
        replies = after.length;
        answered = after.length > 0;
      } catch {
        // Unknown beats wrong. An on-call reading `answered: undefined` knows to look; reading
        // `answered: false` would be told nobody replied when nobody checked.
        replies = undefined;
        answered = undefined;
      }
      posts.push({
        time: at.slice(0, 16),
        from: m.from?.user?.displayName ?? m.from?.displayName ?? "?",
        text: body.slice(0, 300),
        replies,
        answered,
      });
    }
    return [key, posts];
  } finally {
    // Was missing, so every channel leaked its client. Three channels per run, on a pod that
    // runs this daily.
    await c.close();
  }
}

// The two rotation roles own disjoint sources, so each can skip the other's
// (halves the run). Default stays "all" for the combined daily brief.
const SCOPES = {
  all: { icm: true, pipelines: true, requestErrors: true, mail: true, channels: true },
  primary: { icm: true, pipelines: false, requestErrors: true, mail: true, channels: true },
  backup: { icm: false, pipelines: true, requestErrors: false, mail: false, channels: false },
};

async function main() {
  const argv = process.argv.slice(2);
  const scopeArg = (argv.find((a) => a.startsWith("--scope=")) || "").split("=")[1] || "all";
  const want = SCOPES[scopeArg];
  if (!want) {
    process.stderr.write(`unknown --scope=${scopeArg} (expected: ${Object.keys(SCOPES).join(" | ")})\n`);
    process.exit(2);
  }
  const date = argv.find((a) => !a.startsWith("--")) || run(["date", "+%F"], 10).trim(); // caller may pass Sydney date
  const result = { date, scope: scopeArg, errors: {} };

  // icm is a single query against the IcM warehouse, but that cluster 401s a new
  // connection made inside a burst of concurrent Kusto requests. It's only one
  // call (~6s) and everything else can wait, so run it FIRST and alone, before
  // fanning out the rest. This sidesteps the burst-time 401 without slowing the
  // (independent) remaining sources.
  if (want.icm) {
    try { result.icm = await collectIcm(); }
    catch (e) { result.errors.icm = String(e && e.message ? e.message : e).slice(0, 200); }
  }

  // The remaining sources are independent and don't hit the same cluster, so run
  // them fully in parallel. Each task carries a { dest, sub } route so a rejected
  // task lands in errors.
  const tasks = [];
  if (want.pipelines) tasks.push({ dest: "pipelines.ev2", sub: null, fn: () => collectEv2() });
  if (want.pipelines) tasks.push({ dest: "webjobs", sub: null, fn: () => collectWebJobs() });
  if (want.requestErrors) tasks.push({ dest: "requestErrors", sub: null, fn: () => collectRequestErrors() });
  if (want.mail) tasks.push({ dest: "mail", sub: null, fn: () => collectMail() });
  if (want.pipelines) {
    for (const [k, meta] of Object.entries(BUILD_PIPELINES)) {
      tasks.push({ dest: "pipelines", sub: k, fn: () => collectBuildPipeline(k, meta) });
    }
  }
  if (want.channels) {
    for (const [k, cid] of Object.entries(CHANNELS)) {
      tasks.push({ dest: "channels", sub: k, fn: () => collectChannel(k, cid) });
    }
  }

  const settled = await Promise.allSettled(tasks.map((t) => Promise.resolve().then(t.fn)));

  const pipelines = {};
  const channels = {};
  for (let i = 0; i < tasks.length; i++) {
    const { dest, sub } = tasks[i];
    const s = settled[i];
    if (s.status === "rejected") {
      result.errors[dest + (sub ? `.${sub}` : "")] = String(s.reason && s.reason.message ? s.reason.message : s.reason).slice(0, 200);
      continue;
    }
    const val = s.value;
    if (dest === "pipelines" && sub) {
      const [, v] = val;
      pipelines[sub] = v;
    } else if (dest === "pipelines.ev2") {
      pipelines.ev2 = val;
    } else if (dest === "channels") {
      const [, v] = val;
      channels[sub] = v;
    } else {
      result[dest] = val;
    }
  }
  result.pipelines = { ...pipelines, ...(result.pipelines || {}) };
  result.channels = channels;

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

main();
