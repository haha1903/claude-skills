---
name: oncall-summary-kql
description: Generate a weekly IcM incident-activity summary (New/Resolved/Mitigated counts + a Transferred-Out total) for a team, grouped by a business category you define in a KQL snippet. Standalone — pulls straight from the IcM Kusto warehouse using your `az login` token, no external SDK. Triggers on "oncall summary", "weekly icm summary", "icm incident summary". The on-call roster (who was primary/secondary) is left as a manual placeholder because that needs IcM service-identity auth this skill does not use.
allowed-tools: [Bash, Read, Edit, Write]
---

# On-Call Summary (IcM incident activity, KQL-only)

Standalone weekly summary of IcM incident activity for a team, straight from the
IcM Kusto warehouse. **Zero external dependencies** — auth is just `az`, the query
is plain KQL, output is one Markdown file.

## Prerequisites

- `az login` as a user with **read access to the IcM Kusto warehouse**
  (`icmcluster.kusto.windows.net` / `IcmDataWarehouse`).
- Network access to that cluster (corp network / VPN).

## Run it

```bash
node <skill>/bin/summary.mjs [--week N] [--config path] [--out dir]
```

- `--week N` — `0` = current on-call week, `1` = last full week (**default**), `2` = two weeks ago, ...
- `--config` — config file (default `config/config.json`)
- `--out` — output dir (default: the enclosing git repo root, else cwd)

Writes `OnCall_IcM_Summary_<start>_to_<end>.md` and prints its path. Review it.

## What it produces

- **On-Call This Week** — a **manual placeholder**. The IcM on-call schedule API
  needs service-identity auth this standalone skill deliberately avoids; fill in
  primary/secondary yourself.
- **Incident Activity**:
  - **Totals**: New / Resolved / Mitigated / **Transferred Out**.
  - **Detail table** grouped by your business `Category`, columns New / Resolved /
    Mitigated.
  - New = `CreateDate` in window; Resolved = `ResolveDate`; Mitigated =
    `MitigateDate`; Transferred Out = created this week and owning team changed.
  - On-call week = Friday 00:00 → next Friday, in the configured time zone.

## Changing the classification (the whole point)

Everything about grouping lives in **`config/config.json` → `categoryKql`**. It is
a KQL pipeline snippet (one or more `| extend ...` steps) that **must produce a
column named by `groupBy`** (default `Category`). The skill wraps it as:

```
<data layer: one row per in-window incident, with the flags + TeamLeaf + cf_<id>>
<your categoryKql>
| summarize New=countif(IsNew), Resolved=countif(IsResolved),
            Mitigated=countif(IsMitigated), TransferredOut=countif(IsTransferred) by <groupBy>
```

Available inputs per incident:
- `TeamLeaf` — `OwningTeamName` after the last backslash (e.g. `Whitelist&Quota`)
- `OwningTeamName`, `Severity`, `Status`, `IncidentType`, `MonitorId`
- `cf_<id>` — one column per id you list in `customFieldIds`
- `IsNew`, `IsResolved`, `IsMitigated`, `IsTransferred`

The default `categoryKql` (first matching branch wins, each on its own commented line):
1. `isnotempty(MonitorId)` → **Monitor** (anything a Geneva monitor raised)
2. `ServiceBlueprint` / `plannedQuotas` teams, or `cf_45269 == 'PlannedQuota'` → **Planned Quota**
3. `isnotempty(cf_45269)` → the RP name itself (e.g. Subscription, PreApprovedQuota)
4. `TeamLeaf == 'BET'` → **Billing Meter**
5. else → **Other**

Editing examples:
- **Rename / merge** → change the string a branch returns; two branches returning
  the same string merge into one row.
- **New bucket by team** → add `TeamLeaf == '<leaf>', '<Name>'` above the `'Other'`.
- **Classify by a different custom field** → add its id to `customFieldIds` and
  branch on `cf_<id>`.
- **Always keep `'Other'` as the final fallback** (no bare-column fallback).

No script edit needed — only `config.json`.

## Config keys

`cluster`, `database`, `owningTenantId`, `teamName`, `timeZone`, `weekStartDay`
(5=Fri), `groupBy`, `categoryLabel`, `customFieldIds`, `categoryKql`. See the
`_howToClassify` / `_cfVocab` / `_auth` notes inside `config.json`.

## Guards

`groupBy` must be a bare identifier; `categoryKql` must be a single pipeline (no
`;` or backtick) since it is concatenated into the query.
