# Geneva Actions execution logs

- Public cluster: `https://genevaactions.kusto.windows.net`, database `Production`, tables `Audit` and `Tracing`.
- Always bound `PreciseTimeStamp` before matching an execution. The verified `Audit` sample has `PreciseTimeStamp` values at the end of a minute. Keep `DateTime` when present and do not infer precise event order from equal timestamps.
- `Audit`: `ActivityId`, `OperationName`, `ExtensionName`, `EndpointName`, `AuditEventType`, `Result`. `Tracing`: `ActivityId`, `Operation`, `TraceMessage`, `Exception`, `body`. A `Production` database name alone does not establish the target operation's environment. Validate its extension, endpoint and source operation URL.
- A Lionrock `ActivityTraceId` is not a Geneva `ActivityId`. An ACIS execution key is also not an ActivityId. Match the complete execution key in `Tracing.TraceMessage`/`body` or `Audit.Result`, then read each observed nonzero ActivityId in the same window.
- One execution can have several ActivityIds, including separate status polls. Joining only the first can miss the recorded final status. Never join an all-zero ActivityId, which is shared by unrelated work.
- Blank `Operation` or `Exception` does not mean no failure. The verified Cosmos DB example has its Failed status in `TraceMessage` under a polling ActivityId. Diagnostic keywords alone do not classify an error or establish a cause.
- A read failure is unavailable evidence. A successful empty read is not evidence of absence until retention, reporting delay, filters and a retained positive control have been checked. Preserve row and message limits in reported findings.

Verified 2026-09-16 with personal corp and Lionrock Bot AME identities. ACIS operation-key correlation was verified against the 2026-09-15 `CheckCosmosDBAccessError` incident. The audit identifies `Cosmos DB / TestRegionAccessForInternalCustomer`, while a different polling ActivityId records Failed. This establishes the operation and its result, not why the region-access response was invalid.
