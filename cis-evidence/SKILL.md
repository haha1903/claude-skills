---
name: cis-evidence
description: Read the Lionrock request to CIS job mapping and bounded azcispub JobSnapshot and TaskSnapshot evidence. Use when a CIS or quota incident needs reported execution state, task blocking details or reporting delay for a known request or job.
summary: Correlate a Lionrock request with CIS job and task snapshots
---

# CIS snapshot evidence

Read `kb-data-sources` and its [CIS source card](../kb-data-sources/references/cis-snapshots.md). This capability only reads. It does not retry, change requests or post replies.

1. If the incident supplies a Lionrock request, read its job mapping first. Choose the request flow from the actual request. Planned quota and on-demand use different sources. A planned-quota record can have CIS JobType `OnDemandProvision`, so do not choose the request flow from JobType alone. Replace sample values using the incident.

```bash
node ~/.claude/skills/cis-evidence/bin/read.mjs lookup \
  --cluster https://betprod.westus2.kusto.windows.net --database Lionrock \
  --cloud Public --kind planned-quota --request 11315072
```

For on-demand requests use `--kind on-demand --request <parent-number>` and, when known, `--sub-request <number>`. The helper returns matching child associations first, falling back to parent associations (`SubRequestId=0`) when no child match exists. Read every relevant mapping row. Match the failing attempt using job type, creation time, sub-request and archived status. A parent can have several jobs or tasks. A missing JobId does not establish that no fulfillment was needed. The planned-quota mapping has no Cloud field. Verify the cloud from the incident or request before the next step.

Check `RequestSource` and `SubRequest.FulfillChannel` before expecting an on-demand CIS association. Current `CisJob` writes record incoming CIS RP tasks. The former outgoing CIS fulfillment channel is deprecated, and `CisTask` is an obsolete table. For UI, Public API or EV2 requests without a CIS mapping, follow `SubRequest()`, `OperationLog()` and the actual fulfillment channel, then correlated Lionrock/Geneva evidence. Do not substitute a similarly numbered planned-quota request. Empty or legacy `State`/`TaskState` fields in the mapping are not live CIS status.

2. Read snapshots for the matching complete JobId, verified cloud and a window around that execution. A GUID fragment is not a complete JobId.

```bash
node ~/.claude/skills/cis-evidence/bin/read.mjs snapshots \
  --cluster https://azcis.westus.kusto.windows.net --database azcispub \
  --cloud Public --job '<complete CIS JobId>' \
  --start 2026-09-15T20:30:00Z --end 2026-09-15T21:00:00Z
```

The helper returns the latest reported job and one latest snapshot per task in that window, with `Timestamp`, `IngestionTime` and `ReportingDelaySeconds`. Optional `--rows` defaults to 60 and is capped at 200. Windows are limited to seven days. `--message-length` bounds task blocking text. Task selection uses latest Timestamp, then limits output. If task output is truncated, use the returned query to inspect the relevant task rather than assuming the missing tasks succeeded.

3. Preserve `ok`, `empty`, `unavailable`, row/message truncation and `gaps`. Empty snapshots can reflect retention, the selected window or cloud, or reporting delay. Verify a positive control before interpreting absence. Job and Task observations can have different timestamps and ingestion delays. These are snapshots, not a full transition history. A Finished job does not prove downstream quota changes or resource access succeeded.
4. This path does not query `azcis` runtime logs. Keep missing runtime diagnostics explicit and use already authorized Lionrock, Geneva or EV2 evidence when relevant. Do not probe the withdrawn azcis application grant or increase confidence solely because a snapshot is present. Restrict claims to what the actual state and blocking text support.
5. Return evidence to the existing resolver and adapter. Keep internal identifiers, diagnostic text and queries out of customer replies. Internal KQL blocks need adjacent clickable links as described in `kusto-query`. Confidence mechanics remain in shadow.

The host uses its signed-in personal Kusto identity. The Bot uses workload identity and needs its own azcispub access. Personal success does not validate Bot access.
