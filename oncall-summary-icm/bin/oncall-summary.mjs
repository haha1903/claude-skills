#!/usr/bin/env node
/**
 * Weekly IcM on-call summary. Incident activity (New/Resolved/Mitigated/
 * Transferred) from the IcM warehouse time-series, grouped by configurable row
 * dimensions, plus that week's primary/secondary roster. Thin CLI over
 * iris icm.oncallSummary; classification lives in config/dimensions.json.
 *
 *   oncall-summary.mjs [--week N] [--config path] [--out dir]
 *     --week N    0 = current on-call week, 1 = last week (default 1), ...
 *     --config    dimensions config (default ../config/dimensions.json)
 *     --out       output dir for the .md (default cwd)
 *
 * Writes OnCall_IcM_Summary_<start>_to_<end>.md and prints its path.
 * Needs VPN + az login (IcM warehouse + on-call API).
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { icm } from "../../_iris-shared/index.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : def; };
const weekOffset = Number(arg("--week", "1"));
const configPath = arg("--config", path.join(__dir, "..", "config", "dimensions.json"));
const outDir = arg("--out", process.cwd());

const cfg = JSON.parse(await fs.readFile(configPath, "utf8"));

const summary = await icm.oncallSummary(cfg.team, cfg.owningTenantId, {
  dimensions: cfg.dimensions,
  weekOffset,
  timeZone: cfg.timeZone ?? "Australia/Sydney",
  daytime: cfg.daytime ?? undefined,
});

const md = render(summary);
const out = path.join(outDir, `OnCall_IcM_Summary_${summary.window.weekStart}_to_${summary.window.weekEnd}.md`);
await fs.writeFile(out, md);
console.log(out);

function render(s) {
  const { window: w, primary, secondary, dimensions, groups, transferredOut } = s;
  const tot = (k) => groups.reduce((n, g) => n + g[k], 0);
  const dimLabels = dimensions.map((d) => d.label ?? d.key);

  let md = `# IcM On-Call Weekly Summary\n\n`;
  md += `**Window:** ${w.weekStart} (Fri) to ${w.weekEnd} (Thu), Sydney time  |  **Source:** IcmDataWarehouse (time-series) + IcM on-call schedule API  |  **Team:** Region Access & Quota (Lionrock, IcM team ${cfg.team})\n\n`;

  md += `## On-Call This Week\n\n| Role | Name | Alias | Shift Hours | Percentage |\n|---|---|---|--:|--:|\n`;
  for (const p of primary) md += `| Primary | ${p.name} | ${p.alias} | ${p.hours} | 100% |\n`;
  for (const p of secondary) md += `| Secondary | ${p.name} | ${p.alias} | ${p.hours} | 100% |\n`;
  md += `\n_Percentage = share of the week spent on on-call; defaults to 100%, adjust to actual (e.g. 50% if split with other duties)._\n\n`;

  md += `## Highlighted IcMs\n\n_Top incidents this week, in priority order (1 = highest). Fill in manually._\n\n1. \n2. \n3. \n\n`;

  md += `## Incident Activity\n\nCounts are **actions during the window**: New = created, Resolved = ResolveDate in window, Mitigated = MitigateDate in window. Transferred Out = created this week and moved to another owning team.\n\n`;
  md += `### Totals\n\n| New | Resolved | Mitigated | Transferred Out |\n|--:|--:|--:|--:|\n| ${tot("New")} | ${tot("Resolved")} | ${tot("Mitigated")} | ${transferredOut} |\n\n`;

  md += `### By ${dimLabels.join(" / ")}\n\n`;
  md += `| ${dimLabels.map(cap).join(" | ")} | New | Resolved | Mitigated |\n`;
  md += `|${dimLabels.map(() => "---").join("|")}|--:|--:|--:|\n`;
  // Sort by New desc (busiest category first); tie-break by group path.
  const rowsSorted = [...groups].sort((a, b) => b.New - a.New || a.groups.join(" ").localeCompare(b.groups.join(" ")));
  // Collapse repeated leading group cells (only show a top-level value once).
  let prevTop = null;
  for (const g of rowsSorted) {
    const cells = g.groups.map((v, i) => (i === 0 && v === prevTop ? "" : v));
    prevTop = g.groups[0];
    md += `| ${cells.join(" | ")} | ${g.New} | ${g.Resolved} | ${g.Mitigated} |\n`;
  }
  return md;
}

function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
