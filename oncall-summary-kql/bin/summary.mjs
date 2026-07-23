#!/usr/bin/env node
/**
 * Weekly IcM incident-activity summary — STANDALONE (no iris, no shared deps).
 *
 * Pulls incident activity from the IcM Kusto warehouse time-series and groups it
 * by a business category you define in config.json's `categoryKql` snippet.
 * Auth is just `az` (az login): the warehouse accepts the signed-in user's token.
 *
 *   summary.mjs [--week N] [--config path] [--out dir]
 *     --week N   0 = current on-call week, 1 = last full week (default 1), ...
 *     --config   config file (default ../config/config.json)
 *     --out      output dir for the .md (default: enclosing git repo root, else cwd)
 *
 * Writes OnCall_IcM_Summary_<start>_to_<end>.md and prints its path.
 * Needs: az login (a user with IcM Kusto warehouse access) + network to the cluster.
 *
 * NOTE: the on-call roster (who was primary/secondary) is NOT filled in — that
 * needs IcM service-identity auth which this standalone skill deliberately avoids.
 * The report leaves a placeholder for it.
 */
import { promises as fs, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const __dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const weekOffset = Number(arg("--week", "1"));
const configPath = arg("--config", path.join(__dir, "..", "config", "config.json"));
// Default output = <repo root>/docs/oncall-summary (so reports land in the
// project's docs, not wherever cwd happens to be); fall back to cwd/docs if not
// inside a repo. Created if missing.
const root = repoRoot(process.cwd());
const outDir = arg("--out", path.join(root ?? process.cwd(), "docs", "oncall-summary"));

/** Walk up from `dir` to the nearest ancestor containing a .git entry; null if none. */
function repoRoot(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(d, ".git"))) return d;
    const parent = path.dirname(d);
    if (parent === d) return null;
    d = parent;
  }
}

const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));
const tz = cfg.timeZone ?? "Australia/Sydney";
const weekStartDay = cfg.weekStartDay ?? 5; // Friday
const groupBy = cfg.groupBy ?? "Category";
const cfIds = cfg.customFieldIds ?? [];
// categoryKql may be a string or an array of lines (each line typically one
// `condition, value,` case branch, optionally with a trailing // comment). Arrays
// are joined with newlines so the config stays readable + commentable (JSONC).
const categoryKql = Array.isArray(cfg.categoryKql) ? cfg.categoryKql.join("\n") : (cfg.categoryKql ?? "");

validateGroupBy(groupBy);
validateSnippet(categoryKql);

// ── resolve the on-call week window (Fri->Thu by default) in the given tz ──────
const { weekStart, weekEnd, startUtc, endUtc } = resolveWeek(new Date(), tz, weekStartDay, weekOffset);

// ── run the grouped query ──────────────────────────────────────────────────────
const kql = buildKql(cfg.owningTenantId, startUtc, endUtc, cfIds, categoryKql, groupBy, cfg.teamDisplayNames);
const { rows } = await queryKusto(cfg.cluster, cfg.database ?? "IcmDataWarehouse", kql);

const md = render(rows);
const out = path.join(outDir, `OnCall_IcM_Summary_${weekStart}_to_${weekEnd}.md`);
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(out, md);
console.log(out);

// ── rendering ──────────────────────────────────────────────────────────────────
function render(rows) {
  const num = (v) => Number(v ?? 0);
  const tot = (k) => rows.reduce((n, r) => n + num(r[k]), 0);
  const label = cfg.categoryLabel ?? groupBy;
  let md = `# IcM On-Call Weekly Summary\n\n`;
  md += `**Window:** ${weekStart} (Fri) to ${weekEnd} (Thu), ${tz}  |  **Source:** IcmDataWarehouse (time-series)  |  **Team:** ${cfg.teamName ?? "(team)"}\n\n`;
  md += `## On-Call This Week\n\n`;
  md += `| Role | Name | Alias | Percentage |\n|---|---|---|--:|\n| Primary |  |  | x% |\n| Secondary |  |  | x% |\n\n`;
  md += `## Highlights\n\n1. \n2. \n3. \n\n`;
  md += `## Incident Activity\n\n`;
  md += `### Totals\n\n| New | Resolved | Mitigated | Transferred Out |\n|--:|--:|--:|--:|\n| ${tot("New")} | ${tot("Resolved")} | ${tot("Mitigated")} | ${tot("TransferredOut")} |\n\n`;
  md += `### By ${label}\n\n| ${cap(label)} | New | Resolved | Mitigated |\n|---|--:|--:|--:|\n`;
  // Sort by New desc (busiest category first); tie-break by category name.
  const sorted = [...rows].sort((a, b) => num(b.New) - num(a.New) || String(a[groupBy]).localeCompare(String(b[groupBy])));
  for (const r of sorted) md += `| ${r[groupBy]} | ${num(r.New)} | ${num(r.Resolved)} | ${num(r.Mitigated)} |\n`;
  return md;
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ── KQL builder ─────────────────────────────────────────────────────────────────
// Data layer prepares one row per in-window incident with the action flags,
// TeamLeaf, a TeamDisplay column (TeamLeaf mapped through teamDisplayNames), and
// each declared cf_<id>. Then the user snippet (if any) computes `groupBy`; if the
// snippet is empty, Category defaults to TeamDisplay. Then a fixed summarize counts
// the four actions per category.
function buildKql(tenant, w0, w1, cfIds, snippet, groupBy, teamDisplayNames) {
  const cfList = cfIds.length ? cfIds.join(", ") : "-1";
  const cfExtend = cfIds.map((id) => `| extend cf_${id} = tostring(cf_bag["${id}"])`).join("\n");
  // TeamLeaf -> friendly display name via config map; unmapped falls back to TeamLeaf.
  const dnPairs = Object.entries(teamDisplayNames ?? {});
  const teamDisplayExtend = dnPairs.length
    ? `| extend TeamDisplay = case(${dnPairs.map(([k, v]) => `TeamLeaf == '${kqlStr(k)}', '${kqlStr(v)}'`).join(", ")}, TeamLeaf)`
    : `| extend TeamDisplay = TeamLeaf`;
  // If no user snippet, group by the display name directly.
  const categoryStep = (snippet && snippet.trim()) ? snippet : `| extend ${groupBy} = TeamDisplay`;
  return `
let W0 = datetime(${w0});
let W1 = datetime(${w1});
let cf = IncidentCustomFieldEntries
    | where CustomFieldId in (${cfList})
    | summarize arg_max(Lens_IngestionTime, *) by IncidentId, CustomFieldId
    | summarize cf_bag = make_bag(bag_pack(tostring(CustomFieldId), Value)) by IncidentId;
let snap = Incidents
    | where OwningTenantId == ${tenant}
    | summarize arg_max(Lens_IngestionTime, *) by IncidentId;
let winInc = snap | where CreateDate >= W0 and CreateDate < W1 | distinct IncidentId;
let firstTeam = Incidents | where IncidentId in (winInc)
    | summarize arg_min(ModifiedDate, OwningTeamId) by IncidentId
    | project IncidentId, FirstTeamId = OwningTeamId;
let transfers = snap | where IncidentId in (winInc)
    | join kind=inner firstTeam on IncidentId
    | where OwningTeamId != FirstTeamId
    | distinct IncidentId;
snap
| extend IsNew = CreateDate >= W0 and CreateDate < W1
| extend IsResolved = ResolveDate >= W0 and ResolveDate < W1
| extend IsMitigated = MitigateDate >= W0 and MitigateDate < W1
| extend IsTransferred = IncidentId in (transfers)
| where IsNew or IsResolved or IsMitigated or IsTransferred
| join kind=leftouter cf on IncidentId
| extend TeamLeaf = tostring(split(OwningTeamName, '\\\\')[-1])
${teamDisplayExtend}
${cfExtend}
${categoryStep}
| summarize New = countif(IsNew), Resolved = countif(IsResolved),
            Mitigated = countif(IsMitigated), TransferredOut = countif(IsTransferred)
    by ${groupBy}
| order by ${groupBy} asc
`;
}

// ── standalone Kusto call (az token + fetch, v2 REST) ───────────────────────────
async function azToken(resource) {
  const { stdout } = await pexec("az", ["account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"]);
  return stdout.trim();
}
async function queryKusto(cluster, db, kql) {
  const token = await azToken(cluster);
  const res = await fetch(`${cluster}/v2/rest/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ db, csl: kql }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Kusto ${res.status}: ${text.slice(0, 300)}`);
  const frames = JSON.parse(text);
  const prim = frames.find((t) => t.FrameType === "DataTable" && t.TableKind === "PrimaryResult")
    ?? frames.find((t) => t.TableName === "Table_0");
  if (!prim) throw new Error("No primary result table in Kusto response");
  const cols = prim.Columns.map((c) => c.ColumnName);
  const rows = prim.Rows.map((r) => Object.fromEntries(r.map((v, i) => [cols[i], v])));
  return { cols, rows };
}

// ── window resolution (Fri->Thu, IANA tz) ───────────────────────────────────────
function localParts(instant, timeZone) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(instant);
  const g = (t) => p.find((x) => x.type === t)?.value ?? "";
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g("weekday")];
  return { y: Number(g("year")), m: Number(g("month")), d: Number(g("day")), wd };
}
function tzOffsetMinutes(date, timeZone) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(date);
  const g = (t) => Number(p.find((x) => x.type === t)?.value);
  const asUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second"));
  return Math.round((asUtc - date.getTime()) / 60000);
}
function localMidnightUtc(y, m, d, timeZone) {
  const probe = new Date(Date.UTC(y, m - 1, d, 12));
  const off = tzOffsetMinutes(probe, timeZone);
  return new Date(Date.UTC(y, m - 1, d) - off * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
}
function resolveWeek(now, timeZone, weekStartDay, weekOffset) {
  const { y, m, d, wd } = localParts(now, timeZone);
  const back = (wd - weekStartDay + 7) % 7;
  const startMs = Date.UTC(y, m - 1, d) - back * 86400000 - weekOffset * 7 * 86400000;
  const s = new Date(startMs), e = new Date(startMs + 6 * 86400000);
  const weekStart = s.toISOString().slice(0, 10), weekEnd = e.toISOString().slice(0, 10);
  const [sy, sm, sd] = weekStart.split("-").map(Number);
  const endDate = new Date(startMs + 7 * 86400000).toISOString().slice(0, 10);
  const [ey, em, ed] = endDate.split("-").map(Number);
  return { weekStart, weekEnd, startUtc: localMidnightUtc(sy, sm, sd, timeZone), endUtc: localMidnightUtc(ey, em, ed, timeZone) };
}

// ── guards (avoid malformed/injected queries) ───────────────────────────────────
function validateGroupBy(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) { console.error(`Invalid groupBy column name: ${name}`); process.exit(2); }
}
function validateSnippet(snippet) {
  // Strip // line comments first so a ';' inside a comment doesn't trip the guard;
  // we only forbid a statement-terminating ';' (or backtick) in actual code.
  const code = snippet.replace(/\/\/[^\n]*/g, "");
  if (code.includes(";") || code.includes("`")) { console.error("categoryKql must be a single pipeline (no ';' or backtick in code)."); process.exit(2); }
}
// Escape a JS string for use inside a KQL single-quoted literal.
function kqlStr(s) { return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
