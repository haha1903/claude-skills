#!/usr/bin/env node
/**
 * Collect all OnCall daily-brief data sources in parallel, print one JSON blob.
 *
 * The agent should run this ONCE, read the JSON, then organize the report and send
 * it (Logseq + ~/Tasks/Scrum + Notes to self). All API/query logic lives here so it
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
import { icm, ado, ev2, kusto } from "../../_iris-shared/index.mjs";

// Current UTC as ISO string, for overdue next-action comparison (IcM NextActionTime
// is an ISO timestamp string).
const NOW_UTC = new Date().toISOString().replace(/\.\d{3}Z$/, "");

const SKILLS = path.join(os.homedir(), ".claude/skills");

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

// IcM classification — matches the 5 IcM "Pending Action" shared queries.
// All 5 share the same pending-action prefix (icm-pending already applies it);
// they differ only by OwningTeamId + MonitorId, evaluated in THIS priority order
// (By Monitor wins first — any incident with a MonitorId goes there regardless of team):
//   By Monitor      -> MonitorId present
//   CIS RP          -> OwningTeamId 60533
//   CIS-Ev2 Bridge  -> OwningTeamId 141437
//   PlannedQuotas   -> OwningTeamId 153661
//   Other           -> MonitorId null AND team not in {60533,141437,153661}
const ICM_TEAM_CIS_RP = 60533;
const ICM_TEAM_EV2_BRIDGE = 141437;
const ICM_TEAM_PLANNED_QUOTAS = 153661;

function icmQueryClass(inc) {
  const mon = inc.MonitorId;
  if (mon !== null && mon !== undefined && mon !== "") {
    return "By Monitor";
  }
  const tid = inc.OwningTeamId;
  if (tid === ICM_TEAM_CIS_RP) return "CIS RP";
  if (tid === ICM_TEAM_EV2_BRIDGE) return "CIS-Ev2 Bridge";
  if (tid === ICM_TEAM_PLANNED_QUOTAS) return "PlannedQuotas";
  return "Other";
}

// Report order for the 5 query buckets
const ICM_QUERY_ORDER = ["By Monitor", "CIS RP", "CIS-Ev2 Bridge", "PlannedQuotas", "Other"];

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
    throw new Error(String(err.stderr || err.stdout || `exit ${err.status}`).slice(0, 400));
  }
}

// ---- IcM (item 1) --------------------------------------------------------
async function collectIcm() {
  const incidents = await icm.pendingActions(undefined, 200);

  const slim = (inc) => {
    const out = {};
    for (const k of ["IncidentId", "Title", "Severity", "OwningTeamName", "OwningContactAlias", "NextActionTime"]) {
      out[k] = inc[k] === undefined ? null : inc[k];
    }
    out.portalUrl = ICM_PORTAL.replace("{}", String(inc.IncidentId));
    out.comment = (inc.CleanComment || "").slice(0, 200);
    return out;
  };

  const hasSignal = (inc) => {
    // A comment carries a diagnosis only if it's not the boilerplate the
    // monitor/ack pipeline writes on every new incident.
    const c = (inc.CleanComment || "").trim().toLowerCase();
    return Boolean(c) && c !== "incident created" && c !== "acknowledging incident";
  };

  const buckets = {};
  for (const inc of incidents) {
    const q = icmQueryClass(inc);
    (buckets[q] = buckets[q] || []).push(inc);
  }

  const groups = [];
  for (const q of ICM_QUERY_ORDER) {
    const rows = buckets[q];
    if (!rows || !rows.length) continue;
    // sub-group by title family so a ~100-incident bucket collapses to categories
    const fams = {};
    for (const inc of rows) {
      const f = icmTitleFamily(inc.Title || "");
      const fg = fams[f] = fams[f] || { family: f, count: 0, sample: null, sampleSignal: false, assignees: new Set() };
      fg.count += 1;
      fg.assignees.add(inc.OwningContactAlias || "");
      // Prefer a sample whose comment carries a real diagnosis; among equals,
      // take the most recent (largest IncidentId).
      const sig = hasSignal(inc);
      const better = (fg.sample === null
        || (sig && !fg.sampleSignal)
        || (sig === fg.sampleSignal
          && (inc.IncidentId || 0) > fg.sample.IncidentId));
      if (better) {
        fg.sample = slim(inc);
        fg.sampleSignal = sig;
      }
    }
    const families = Object.values(fams).map((f) => ({
      family: f.family,
      count: f.count,
      sample: f.sample,
      unassigned: (f.assignees.has("") && f.assignees.size === 1),
    })).sort((a, b) => b.count - a.count);
    // per-bucket assignee tally (who owns this query's incidents)
    const assignees = {};
    for (const inc of rows) {
      const a = inc.OwningContactAlias || "UNASSIGNED";
      assignees[a] = (assignees[a] || 0) + 1;
    }
    const sortedAssignees = {};
    for (const [k, v] of Object.entries(assignees).sort((x, y) => y[1] - x[1])) {
      sortedAssignees[k] = v;
    }
    groups.push({
      query: q,
      count: rows.length,
      queryUrl: ICM_QUERY.replace("{}", ICM_QUERY_LINKS[q] || ""),
      assignees: sortedAssignees,
      families,
    });
  }

  // flagged = Sev<=2 OR owned by haichang OR unassigned OR overdue next-action
  const flagged = [];
  for (const inc of incidents) {
    const na = inc.NextActionTime;
    const overdue = Boolean(na) && String(na) < NOW_UTC;
    const sev = inc.Severity === undefined || inc.Severity === null ? 9 : inc.Severity;
    if (sev <= 2 || inc.OwningContactAlias === "haichang"
      || !(inc.OwningContactAlias || "") || overdue) {
      const f = slim(inc);
      f.overdue = overdue;
      f.reason = sev <= 2 ? "Sev≤2"
        : inc.OwningContactAlias === "haichang" ? "mine"
          : overdue ? "overdue"
            : "unassigned";
      flagged.push(f);
    }
  }
  return { count: incidents.length, groups, flagged };
}

// ---- Build pipelines (item d/f/g) with failure drill-down ----------------
function timelineFailures(buildId) {
  // Return failed timeline tasks + the top error lines from their logs.
  // Raw ADO calls via iris ado; the log-failure extraction is oncall-specific.
  let records;
  try {
    records = ado.timeline(buildId);
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
        for (let ln of ado.logLines(buildId, logId)) {
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
    records = ado.timeline(buildId);
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
      logtxt = ado.logLines(buildId, logId).join("\n");
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
    runs = ado.recentRuns(defId, { top: 6 });
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
  }

  // Drill failed runs newest-first; keep the first one that yields concrete log
  // failures (some "failed" runs are empty EV2-rollout tasks with no test detail).
  for (const r of runs) {
    if (r.result !== "failed") continue;
    const tl = timelineFailures(r.id);
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
      const url = ado.findEv2PortalUrl(rep.id);
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

function releaseFailures(detail) {
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
                for (let ln of ado.restText(lu).split(/\r?\n/)) {
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

function collectEv2() {
  try {
    const detail = ado.releaseDetail(EV2_RELEASE_DEF);
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
      res.failures = releaseFailures(detail);
    }
    return res;
  } catch (e) {
    return { item: "e", defId: EV2_RELEASE_DEF, error: String(e.message) };
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

// ---- bowloper support mail (item b) --------------------------------------
function collectMail() {
  const out = run(["node", path.join(SKILLS, "o-find-mail/bin/search.mjs"), "bowloper", "--top", "10"], 120);
  const items = [];
  for (let line of out.split("\n")) {
    line = line.trim();
    if (!line.startsWith("{")) continue;
    try {
      const m = JSON.parse(line);
      items.push({ received: m.received, from: m.from, subject: m.subject });
    } catch {
      // ignore
    }
  }
  // search.mjs prints one JSON object per record separated by newlines? if it's a
  // stream of pretty JSON, fall back to brace-matching:
  if (!items.length) {
    const re = /\{[^{}]*\}/g;
    let m;
    while ((m = re.exec(out)) !== null) {
      try {
        const d = JSON.parse(m[0]);
        if ("subject" in d) {
          items.push({ received: d.received, from: d.from, subject: d.subject });
        }
      } catch {
        // ignore
      }
    }
  }
  return items;
}

// ---- Teams channels (item a/m) -------------------------------------------
function collectChannel(key, chatId) {
  try {
    const out = run(["node", path.join(SKILLS, "o-teams-digest/bin/dump-chat.mjs"), chatId,
      "--top", "6", "--json"], 90);
    const msgs = JSON.parse(out);
    const posts = [];
    for (const m of msgs) {
      let body = (m.body || {}).content || "";
      body = body.replace(/<[^>]+>/g, "").trim();
      posts.push({
        time: (m.createdDateTime || "").slice(0, 16),
        from: (m.from || {}).displayName || "?",
        text: body.slice(0, 100),
      });
    }
    return [key, posts];
  } catch (e) {
    return [key, { error: String(e.message).slice(0, 150) }];
  }
}

async function main() {
  const date = process.argv[2] || run(["date", "+%F"], 10).trim(); // caller may pass Sydney date
  const result = { date, errors: {} };

  // icm is a single query against the IcM warehouse, but that cluster 401s a new
  // connection made inside a burst of concurrent Kusto requests. It's only one
  // call (~6s) and everything else can wait, so run it FIRST and alone, before
  // fanning out the rest. This sidesteps the burst-time 401 without slowing the
  // (independent) remaining sources.
  try { result.icm = await collectIcm(); }
  catch (e) { result.errors.icm = String(e && e.message ? e.message : e).slice(0, 200); }

  // The remaining sources are independent and don't hit the same cluster, so run
  // them fully in parallel. Each task carries a { dest, sub } route so a rejected
  // task lands in errors.
  const tasks = [];
  tasks.push({ dest: "pipelines.ev2", sub: null, fn: () => collectEv2() });
  tasks.push({ dest: "requestErrors", sub: null, fn: () => collectRequestErrors() });
  tasks.push({ dest: "mail", sub: null, fn: () => collectMail() });
  for (const [k, meta] of Object.entries(BUILD_PIPELINES)) {
    tasks.push({ dest: "pipelines", sub: k, fn: () => collectBuildPipeline(k, meta) });
  }
  for (const [k, cid] of Object.entries(CHANNELS)) {
    tasks.push({ dest: "channels", sub: k, fn: () => collectChannel(k, cid) });
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
