---
name: oncall-summary-icm
description: Use to generate the weekly IcM on-call summary for the Lionrock / Region Access & Quota rotation — incident activity (New/Resolved/Mitigated counts + a Transferred-Out total) pulled from the IcM Kusto warehouse time-series, grouped by configurable row dimensions (owning team, issue type, severity, ...), plus that week's primary/secondary on-call roster. Triggers on "oncall summary", "weekly icm summary", "on-call 周报", "生成 oncall summary". Distinct from oncall-summary (that one recaps chat history); this one is the IcM incident-activity report.
allowed-tools: [Bash, Read, Edit, Write]
---

# On-Call Summary (IcM weekly incident activity)

Generate the weekly on-call summary as **one Markdown file** in the current
directory: incident-activity counts + the week's primary/secondary roster. Pulls
straight from the IcM Kusto warehouse time-series (no OData). **Needs VPN + az
login** (IcM warehouse + on-call schedule API).

## Run it

```bash
node ~/.claude/skills/oncall-summary-icm/bin/oncall-summary.mjs [--week N] [--config path] [--out dir]
```

- `--week N` — `0` = current on-call week, `1` = last full week (**default**), `2` = two weeks ago, ...
- `--config` — dimensions config (default `config/dimensions.json`)
- `--out` — output dir (default cwd)

Writes `OnCall_IcM_Summary_<start>_to_<end>.md` and prints its path. Then show the
user and let them review.

## What it produces

- **On-Call This Week** — primary + secondary (name / alias / shift hours), from
  the IcM on-call schedule API (team 67250, `Position 0`=primary, `1`=secondary).
- **Incident Activity**:
  - **Totals** row: New / Resolved / Mitigated / **Transferred Out**.
  - **Detail table** grouped by the configured row dimensions, columns New /
    Resolved / Mitigated (no Transferred column — a transferred incident's other
    actions still count under its current team).
  - New = `CreateDate` in window; Resolved = `ResolveDate`; Mitigated =
    `MitigateDate`; Transferred Out = created this week and moved to another
    owning team (a window total, not split per team).
  - On-call week = Friday 00:00 → next Friday, in Sydney time.

## Changing the classification (the whole point)

Edit **`config/dimensions.json`** — never the KQL. The query is a pure data layer
(`icm.oncallSummaryKql`); grouping/merging/renaming happens in JS
(`icm.aggregateSummary`) driven by this config.

Each entry in `dimensions` (order = nesting; first is the top-level group):

```json
{
  "key": "issueType",
  "source": "customField",          // or "column"
  "customFieldIds": [45266, 45272],  // customField: first non-empty wins (merges the two IssueType fields)
  "column": "OwningTeamName",        // column: an Incidents column instead
  "label": "issue type",             // used in headers and the "(no <label>)" bucket
  "valueMap": { "BuildOut": "Buildout", "Buildout": "Buildout" }  // merge/rename raw values
}
```

- **`valueMap`** merges + renames: several raw values mapping to the same display
  name collapse into one group. Unmapped values pass through unchanged;
  empty/null → `(no <label>)`.
- **Swap the grouping**: e.g. change the first dimension to
  `{ "key":"sev", "source":"column", "column":"Severity", "label":"severity" }`
  and rerun — the table regroups, no KQL change.
- Candidate custom fields: `45266`/`45272` IssueType, `24897` Region, `45269`
  RPName, `45267` BlueprintName. Candidate columns: `OwningTeamName`, `Severity`,
  `Status`, `IncidentType`, `MonitorId`.

## Fixed ids (in config)

- `team` `67250` = Region Access & Quota (Lionrock on-call queue, IcM team id).
- `owningTenantId` `25998` = the Lionrock owning tenant in the warehouse.

## Notes

- Implemented in iris: `icm.oncallSummary` (orchestration), `oncallSummaryKql`
  (data-layer KQL), `aggregateSummary` + `applyValueMap` (JS grouping/merging),
  `oncallRoster` (primary/secondary). To change the data pulled (new column, new
  action), edit iris + rerun `npm run bundle:skills`; to change the *grouping*,
  just edit the config.
- English-only output (manager-facing). Do not auto-send anywhere — show the user.
- Related: `oncall-summary` (chat-history recap), `oncall-brief` (daily),
  `icm-query` (ad-hoc KQL).
