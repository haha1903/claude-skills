# CIS reported job and task state

**Kusto:** [azcis / azcispub](https://azcis.westus.kusto.windows.net/azcispub?web=1).

- Scope `JobSnapshot` and `TaskSnapshot` by the complete `JobId`, `Cloud` and absolute `Timestamp` window. Use `Cloud` from verified context. The JobId includes a numeric prefix and GUID. Do not substitute a GUID fragment, TaskId or Lionrock request number.
- `JobSnapshot` has `State`, `CustomState`, `Workflow`, `ParentId`, `RootId` and task counts. `TaskSnapshot` has `StateName`, `CustomState`, `LastBlockedReason` and `TaskId`. States are reported observations, not proof of downstream fulfillment or recovery.
- Keep `Timestamp` and `IngestionTime`. Their difference is observed reporting delay, not a guaranteed pipeline SLA. A bounded query selects the latest snapshots reported within that window, not necessarily the current state. Tasks need individual latest snapshots by JobId, Cloud and TaskId before applying output limits.
- Job and Task snapshots can be reported at different times. A discrepancy between job counts and task output can be due to timestamps or truncation. Investigate it rather than silently choosing one source.
- Do not retrieve or reproduce raw `LogUri`, `ProgressReportLink`, `Arguments`, `Notes` or `ProgressInfo` by default. A historical `LogUri` contained a SAS query. The Iris helper projects only required evidence and bounds blocking text.
- Use `CisJob()` in [betprod / Lionrock](https://betprod.westus2.kusto.windows.net/Lionrock?web=1) for on-demand mapping, with `ParentRequestId`, `SubRequestId` and `Cloud`. Use `PlannedQuotaRequestExecution()` with `RequestId` for planned quota and alias `CisJobId` as JobId. Keep request kinds distinct. A planned-quota request can map to a CIS job whose JobType is `OnDemandProvision`. That job type does not change the request flow. Planned mapping has no Cloud column, so verify it separately. It records current SQL state and does not reconstruct a past retry automatically.
- No matches do not establish no execution. Check exact identifiers, cloud, time window, reporting delay, retention and a retained positive control. A permission failure is `unavailable`, not `empty`.
- Runtime `TraceEvent` and `RuntimeLogEvent` belong to the separate `azcis` database. This helper does not query it. The application access request for that database was withdrawn on 2026-09-17. Missing runtime diagnostics remain an evidence gap.

Measured 2026-09-17 with the personal identity: a retained ReceiveLionrockPlan job had one Finished job snapshot and two Finished tasks. The reported delays were approximately 295 seconds for the job and 168 to 220 seconds for its tasks. This verifies reported state only. Lionrock Bot's azcispub grant is tracked separately as T01.

A second real check followed planned-quota request 11315072 to its TenantBasedOnDemandProvisioning job and one Finished task. The job reporting delay was about 137 seconds and the task delay about 905 seconds. Do not generalize one sample into a fixed reporting-delay bound.

A retained on-demand mapping for request 11020748 has `SubRequestId = 0`. Zero is a valid stored value and must remain selectable. The Public CisJob source contained 11,297 rows with newest CreatedTime at 2026-01-20 during this read. Its lack of recent mappings does not establish that newer requests did not execute through CIS. Use the matching request records and application logs to verify the actual path.
