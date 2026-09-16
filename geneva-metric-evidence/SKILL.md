---
name: geneva-metric-evidence
description: Read Geneva monitor configuration and matching metric time series for Lionrock incident evidence. Use to verify the actual monitor dimensions, sampling, threshold and evaluation window, without treating missing metric points as zero or recovery.
summary: Read monitor rules and observed metric points for an incident
---

# Geneva metric evidence

Read `kb-data-sources` first. This is a read-only capability. It does not edit monitors, retry operations, change incident status or publish replies. The existing resolver interprets evidence and the caller controls disclosure and delivery.

1. Read both V1 and V2 monitor configurations through Iris. Locate the incident's account, namespace, metric and monitor. Retain its version, last update, dimensions, includes/excludes, sampling, threshold, lookback, evaluation frequency, ingestion delay and mitigation duration. Configuration observed now is not automatically the configuration that triggered an older alert.

```bash
node ~/.claude/skills/geneva-metric-evidence/bin/read.mjs monitors
```

2. Query the actual metric with the incident's dimension combination and an absolute UTC window covering the evaluation period. For example, replace all sample values using the incident and monitor configuration:

```bash
node ~/.claude/skills/geneva-metric-evidence/bin/read.mjs series \
  --namespace Lionrock --metric Event --dimensions EventId,EventName,Level \
  --filters '{"EventId":["500532"],"EventName":["CheckCosmosDBAccessError"],"Level":["4","5"]}' \
  --sampling Count --start 2026-09-15T17:20:00Z --end 2026-09-15T17:40:00Z
```

3. Read `status`, `sets`, `messages`, `truncated`, `observedPoints`, `missingPoints` and `zeroPoints`. Values align with each set's start time and data resolution. `null` means a missing or nonfinite value, not zero. `empty`, `unavailable` and `incomplete` are different outcomes. Run a retained positive control before interpreting absence. A quiet metric alone does not prove recovery or justify closing an IcM.
4. Match the monitor's exact dimensions, aggregation and full evaluation window. Preserve exclusions and any unresolved time-aggregation semantics. Do not reduce a complex V2 monitor to one scalar threshold. Prefer reporting observed points and the configured rule when an exact monitor evaluation cannot be reproduced.
5. Correlate the metric timestamp with request and execution logs. The metric confirms the measured event or trend. It does not identify the cause by itself. Internal findings retain diagnostic evidence. Customer replies exclude internal diagnostics and confidence mechanics remain in shadow.

The default account is `agboa`. Override `--account` and `--stamp` only for a verified source. Certificate paths use `GENEVA_METRICS_CERT` / `GENEVA_METRICS_KEY` or `--cert` / `--key`. The host defaults to its existing Geneva certificate. Build Iris's official .NET SDK helper with `npm run build:metrics` before using a new checkout. The container builds and ships that helper and uses its mounted ReadOnly certificate. No private key is copied into Git or the image.

Verified 2026-09-16: Bot ReadOnly access reads 11 V1 and 6 V2 monitors, a known periodic metric with 6 observed points, and the `CheckCosmosDBAccessError` point at 2026-09-15 17:29 UTC. The configured Event monitor uses Count, levels 4/5, threshold greater than 0, a 20-minute lookback and 15-minute frequency. Its configured mitigation duration is 2h15m. Missing points do not establish that duration of health.

The official SDK discovers the metric data endpoint separately from the configuration home stamp. On agboa it returned port 9201. A successful 443 configuration read does not validate the data route. These certificate-based reads do not explain or repair the separate AME Kusto plugin 400.
