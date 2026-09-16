---
name: geneva-monitor
description: Use when the user wants to back up, inspect, or modify Geneva Health monitors AND their metric configs (the rules that auto-open IcM incidents from logs/metrics, plus the metric dimensions/preaggregates they depend on) for the Lionrock `agboa` account — e.g. suppressing a noisy error-log alert, or taking a full snapshot before a change. Handles V1 + V2 monitors and metric configurations.
---

# Geneva Monitor (backup / inspect / restore)

Manage Geneva monitors (**V1 and V2**) **and metric configurations** on the `agboa`
(prod5) monitoring account via the stamp config REST API. Mirrors the Windows
`MdmConfigUtility` `/Download` + `/Upload` model so there is always a full snapshot before
any change.

These monitors are what auto-open the `[Region Access] Error occurred <EventId>:<EventName>`
IcM incidents for Lionrock. To read/operate on the incidents themselves, use the `icm`
skill; this skill manages the **monitor rules that create them** and the **metric configs**
(dimensions + preaggregates) those rules depend on.

> ⚠️ **On 2026-09-16, agboa had 17 monitors: 11 V1 + 6 V2.** The V1 and V2 lists come from *different*
> API endpoints. Always back up both (the helper does). A V2-only snapshot is NOT a full
> backup.

## Auth

Client certificate (mTLS), registered on the `agboa` Machine Access list.
- Default cert: `~/.bet/certs/int/geneva-log.{crt,key}`
  (subject `geneva.bet.lionrock-dev.azure.com`, role `Administrator` on agboa, verified 2026-09-16).
- ⚠️ **This cert expires 2026-11-04.** After that, register a fresh cert on agboa Machine
  Access (role `MonitorEditor` or higher) and point `--cert/--key` (or the env vars) at it.
- `haichang` is an Administrator on agboa (prod5), so cert registration can be self-served
  in the portal: Account → Metrics Account Settings → Machine Access.

For incident evidence, use [geneva-metric-evidence](../geneva-metric-evidence/SKILL.md). The Bot certificate `geneva.bet.agboa.azure.com` has ReadOnly access and is separate from this host administration certificate.

## Backup file format

A backup is one JSON object holding monitors **and** metric configs:

```json
{
  "v1": [ ...V1 monitors... ],
  "v2": [ ...V2 monitors... ],
  "metrics": { "Lionrock/Event": {...}, "BET/Event": {...}, ... }
}
```

(The tool also accepts a bare list as a legacy V2-only file.)

**Metric configs** (`metrics`) are the "matrix" — each metric's `dimensionConfigurations`
and `preAggregations`. A monitor's conditions (EventName/Level/EventId…) reference
dimensions defined here, so the metric config is part of the monitor's dependency surface.
By default the tool backs up metrics in these namespaces (override with
`GENEVA_MONITOR_METRIC_NAMESPACES`): `Lionrock,LionrockTest,LionrockUat,BET,SubMgmtEV2Extension`
(~46 metrics). Geneva-platform namespaces like `MdmQos` / `Monitoring Agent` are skipped.
Downloading metrics adds ~1–2 min (one GET per metric).

## Helper

| Command | What it does |
|---|---|
| `geneva-monitor which-monitor <EventName>` | **Start here for a noisy IcM.** Lists the active monitors that would open an IcM for that EventName. Read-only. Ignores monitors pinned to specific EventIds. |
| `geneva-monitor suppress <EventName[,…]> [--commit]` | **The fix.** Adds the EventName(s) to the matching monitor's exclusion. Dry-run unless `--commit`; on commit it snapshots first, writes, then verifies. `--remove` to undo, `--component <NS>` to scope. |
| `geneva-monitor download [--out P] [--no-metrics]` | GET all V1+V2 monitors (+ metric configs) → backup JSON. Default output dir is the **current directory**; `--out` a dir or `*.json`. `--no-metrics` = fast (monitors only, ~2 s vs ~1.5 min). Never writes the service. |
| `geneva-monitor show <file>` | Summary table (kind / name / state / namespace / key conditions, with EventName exclusions) + metric config summary. |
| `geneva-monitor get <file> <name>` | Print full JSON of monitor(s)/metric(s) matching name/id. **V1 names repeat** (Event, Ping…) — expect multiple hits; disambiguate by `component`. Metrics match as `Namespace/Metric` (e.g. `Lionrock/Event`). |
| `geneva-monitor diff <a> <b>` | Show which monitors changed between two backups. |
| `geneva-monitor upload <file> [--commit]` | Restore/overwrite from a backup (e.g. roll back). **DRY-RUN unless `--commit`.** |

Also linked as `~/bin/geneva-monitor` (on PATH); same file lives at `bin/geneva-monitor` in this skill.

## Safe-by-design

- `download` / `show` / `get` / `diff` never modify the service.
- `upload` is **dry-run unless `--commit`**; before committing it auto-saves a fresh live
  snapshot (`*-prePUT.json`) and prints the add/update diff vs live.
- Neither write deletes monitors absent from the file (flagged `! NOT-IN-UPLOAD` in the
  dry-run). So a full-list upload is safe.
  - V2 write: single upsert `PUT` of the whole V2 list.
  - V1 write: `POST` grouped by `EventIdentifier` (tenant/component/event), `operation=AddOrUpdate`.

## V1 vs V2 — important structural difference

- **V1** monitor: `eventIdentifier{tenant,component,id}` keys the *metric*; the monitor's
  own name is the **top-level `id`** (e.g. `Event`, `WebJobDaily`). Conditions are a list of
  `[dimension, value, ""]` triples, e.g. `["EventName","*",""]`, `["Level","4,5",""]`.
  Multiple V1 monitors share the name `Event` — they differ by `component`.
- **V2** monitor: has `schemaVersion`, `timeSeries`, `targetDimensions`, `alertConditions`.
  EventName filtering is an `exclusion` array under `targetDimensions`.
- V1 is being **deprecated** (UI create disabled 2026-06; processing stops 2027-03). New
  work should prefer V2, but existing alerts (incl. the noisy one below) are still V1.

## The noisy-IcM culprit (identified) & exclusion syntax

The alerts `[Region Access] Error occurred <id>:ToolCallError` /
`...RenewMessageLockExceptionCore` come from a **V1 monitor**:

- **monitor.id `Event`, metric `Lionrock/Event`** (NOT the BET/Event one), active.
- conditions: `EventId=*`, **`EventName=*`**, `Level=4,5` → fires on *any* Error/Critical
  `Lionrock/Event` log regardless of EventName.
- Confirmed by: `customTitle = "[Region Access] Error occurred {EventId}:{EventName}"` and
  `Icm.CorrelationId = resource://{Tenant}/{EventName}_{Component}:{Event}` → expands to the
  exact CorrelationId on the incidents.

**EventName exclusion syntax (confirmed):**
- **V1**: each `conditions` entry is a `[dimension, include, exclude]` triple. The **3rd
  element is a comma-separated exclude list** (the 2nd is the include, `*` = all). This
  monitor already excludes EFCore + several ServiceBus EventNames there — `suppress` just
  appends to that list.
- **V2**: `targetDimensions[].exclusion = [{filterType:0, values:[...]}]` for the EventName
  dimension.

`geneva-monitor suppress <EventName> --commit` handles both forms automatically — prefer it
over hand-editing. (Already applied for `ToolCallError`,
`RenewMessageLockExceptionCore`, `ProcessorRenewMessageLockExceptionCore` on Event/Lionrock.)

## End-to-end runbook — a noisy IcM was opened, suppress it

This is the full path from "I got a junk IcM" to "it won't happen again", with the
mechanical steps automated by the helper.

**1. Understand the incident** (use the `icm` skill). Pull the incident; note the title
`[Region Access] Error occurred <EventId>:<EventName>` and `CorrelationId
resource://agboa/<EventName>_<Component>:Event`. The `<EventName>` is what you'll suppress.

**2. Confirm it's benign** (use the `kusto-query` skill against Lionrock Log,
`agboa.westus2 / lionrock.Log`). Find the `EventName` at `Level>=4` and confirm it's a
transient/3rd-party-SDK error with no customer impact — e.g.:
```kql
Log | where PreciseTimeStamp >= ago(7d) | where EventName == "<EventName>"
    | summarize count(), any(FormattedMessage) by LoggerName, Level
```

**3. Find which monitor opens the IcM** (one command — don't guess; there are 11 V1 + 5 V2
monitors and names repeat):
```bash
geneva-monitor which-monitor <EventName>
```
It lists only the **active** monitors that would actually fire (EventName matches, not
already excluded, and not pinned to specific EventIds).

**4. Suppress it** — dry-run, eyeball, commit:
```bash
geneva-monitor suppress <EventName>            # dry-run: shows which monitors get the exclusion
geneva-monitor suppress <EventName> --commit   # snapshots, writes, re-reads & verifies
```
For several names at once: `geneva-monitor suppress "NameA,NameB,NameC" --commit`.
The commit auto-saves `*-preSuppress.json` (rollback point), writes V1 (per
EventIdentifier POST) and V2 (PUT), then verifies the exclusion landed. Effect applies on
the monitor's next evaluation (≤ its frequency, typically 15 min).

**5. Resolve the incident** (use the `icm` skill — mitigate then resolve, noting the fix).

### Undo / rollback

```bash
geneva-monitor suppress <EventName> --remove --commit    # just drop that exclusion
# or restore a whole pre-change snapshot:
geneva-monitor upload <…-preSuppress.json> --commit
```

### Manual edit (when suppress's heuristics don't fit)

```bash
geneva-monitor download                       # full snapshot (rollback point)
geneva-monitor get <backup> Event             # inspect; Lionrock/Event V1 is the usual culprit
# edit a copy: V1 → conditions ["EventName","*", "<csv excludes>"] (3rd element = exclude list)
#              V2 → targetDimensions[EventName].exclusion[0].values[]
geneva-monitor upload <edited.json>           # dry-run diff vs live
geneva-monitor upload <edited.json> --commit  # writes
```

## Defaults & overrides

| Flag | Env var | Default |
|---|---|---|
| `--account` | `GENEVA_MONITOR_ACCOUNT` | `agboa` |
| `--stamp` | `GENEVA_MONITOR_STAMP` | `https://prod5.prod.microsoftmetrics.com` |
| `--cert` | `GENEVA_MONITOR_CERT` | `~/.bet/certs/int/geneva-log.crt` |
| `--key` | `GENEVA_MONITOR_KEY` | `~/.bet/certs/int/geneva-log.key` |
| `--out` (download) | — | current directory |
| (backup/snapshot dir) | `GENEVA_MONITOR_BACKUP_DIR` | current directory (`.`) |
| metric namespaces | `GENEVA_MONITOR_METRIC_NAMESPACES` | `Lionrock,LionrockTest,LionrockUat,BET,SubMgmtEV2Extension` |

## Notes / gotchas

- **Always send `Accept: application/json`** (the helper does). Without it the API falls
  back to XML and returns HTTP 500 (`JToken ... recursive collection`).
- Uses the `requests` package; shebang `#!/usr/bin/env python3`. Run from a python that has
  `requests` (the `~/.venv` does); it prints a clear hint if not.
- Endpoints (all cert-authenticated; note the `/api/` prefix — without it you get a 302 to AAD login):
  - V2 monitors list `GET /api/v1/config/monitor/tenant/{account}/configurations`;
    write `PUT /api/v1/config/monitor/tenant/{account}/configuration` (body `MonitorConfigurationV2[]`).
  - V1 monitors list `GET /api/v1/config/metrics/tenant/{account}/component/COMPONENT/event/EVENT/monitors/MONITOR?component=.%2A&event=.%2A&monitor=.%2A`;
    write `POST /api/v1/config/metrics/tenant/{account}/component/{c}/event/{e}/monitor/skipVersionCheck/{bool}/operation/AddOrUpdate` (body `MonitorConfiguration[]`).
  - Metric config get/write `GET|POST /api/v1/config/metrics/monitoringAccount/{account}/metricNamespace/{ns}/metric/{name}` (path segments **double-encoded**).
  - Metric list `GET /api/v1/hint/monitoringAccount/{account}/metricNamespace` and `.../metricNamespace/{ns}/metric`.
  - ⚠️ The metric endpoints **only** accept the cert under the `/api/` prefix. The
    bare `/v1/config/metrics/...` (no `/api/`) is the AAD-user path and 302-redirects to login.
- Occasional TLS handshake timeouts on the stamp endpoint — just retry.
- Full background (auth options, V1 vs V2, deprecation timeline) is in the SOP:
  `~/Projects/s360-docs/s360/geneva-monitor-management-sop.md`.
