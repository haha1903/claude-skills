---
name: geneva-execution-logs
description: Read Geneva Actions and ACIS execution Audit and Tracing logs for a known operation key or Geneva ActivityId. Use when a Lionrock incident needs the corresponding execution outcome or dependency-side diagnostic evidence.
summary: Correlate a known Geneva execution with bounded audit and trace records
---

# Geneva execution logs

Read `kb-data-sources` and its [Geneva logs card](../kb-data-sources/references/geneva-logs.md). This capability is read-only. It does not execute or retry an action and does not post to IcM.

1. Obtain the complete ACIS operation URL or execution key from the incident or Lionrock `FormattedMessage`. Use a time window around that attempt. Lionrock `ActivityTraceId` is a different identifier, and its all-zero `ActivityId` is not a join key.
2. Run the Iris-backed helper. An execution can have different ActivityIds for submission, execution and status polling. The helper discovers these before querying both tables.

```bash
node ~/.claude/skills/geneva-execution-logs/bin/read.mjs \
  --cluster https://genevaactions.kusto.windows.net --database Production \
  --start 2026-09-15T17:20:00Z --end 2026-09-15T17:35:00Z \
  --operation-url '<complete ACIS operation URL>'
```

Use `--execution '<complete execution key>'` or `--activity '<verified Geneva GUID>'` instead of `--operation-url`. Supply exactly one selector. Dates and identifiers must come from the incident, not the example. Optional `--rows` defaults to 60 per table and cannot exceed 200. Windows cannot exceed seven days.

3. Read `audit`, `tracing`, `activityIds`, `discovery` and `gaps`. `DiagnosticMatch` only prioritizes messages containing diagnostic terms and does not prove failure. Verify the operation name, extension, attempt and actual text before drawing a conclusion. A status-poll trace can establish Failed without explaining the underlying cause.
4. Preserve unavailable reads, empty results and truncation as distinct outcomes. Narrow the window or run a returned query if needed. Do not infer recovery from missing errors or claim a full timeline from limited output.
5. Return relevant facts through the existing resolver and adapter. In internal replies, place a clickable cluster/database link immediately above every KQL block, following `kusto-query`. Keep internal diagnostics out of customer replies and confidence mechanics in shadow.
