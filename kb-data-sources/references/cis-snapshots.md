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

A retained on-demand mapping for request 11020748 has `SubRequestId = 0`, while its actual child is 11020748-1. Zero denotes a parent association. When a child-specific lookup has no exact match, return the parent associations, as `CisJobContext.GetCisJobEntityByRequestIdAsync` does. Preserve exact legacy child associations when present.

Code and direct SQL checks on 2026-09-17 established the mapping scope:

- `PublicApiController.CreateRequestForCISAsync` writes `CisJob` for incoming CIS RP tasks with `SubRequestId=0`. The controller documents the former outgoing CIS fulfillment channel as deprecated. `CisTaskEntity` and its mapping are obsolete.
- Public `dbo.CisJob` has 11,297 rows, newest CreatedTime 2026-01-20. The newest `dbo.Request` with `RequestSource=CIS` is the same request 11020748 at the same time. Direct SQL and the external function agree. `dbo.CisTask` has 1,254 legacy rows with maximum RequestId 5120807. It is not a newer mapping source.
- Requests created from September 1 through the read came from LionrockUI, PublicApi, EV2 and FieldForm. Their children use Lionrock, RDQuota, AutoComplete and pending channels. `RequestProvider.FulfillSubRequestAsync` routes automation through Lionrock and otherwise creates tickets. Check the request source, child channel and operation log instead of requiring a CIS job for every on-demand request.
- `CisJobEntity.State` and `TaskState` are obsolete fields. An empty value is not a failed or missing CIS execution. Use actual snapshots when a CIS association exists.

A real comparison for IcM 866508814 found that auto-mitigation after job start did not imply completion. The job snapshot at 2026-09-17 00:18:24 UTC was InProgress with one blocked task. Task snapshots from September 16 showed a pre-buildout task blocked by incident 772792189 and a post-buildout task NotStarted. Keep their different observation times and do not infer the underlying cause or later recovery.

Hai confirmed on 2026-09-17 that the former on-demand fulfillment flow has migrated to FRP in-cloud. Missing legacy Lionrock fulfill jobs are expected for that migrated flow, not evidence of a failed mapping or missing fulfillment. FRP may still run as a CIS workflow with JobType `OnDemandProvision`. Start with the real FRP job/task and cloud, without requiring an old Lionrock request association.

The CIS source corroborates the in-cloud design: `ReceiveLionrockPlan` uploads plans to the in-cloud Cosmos ExecutionPlanStore, `PlannedQuota/ResourceBalanceManager` reads that store, and `LionrockE2ETest` documents FRP through TenantBasedOnDemandProvisioning with consumption checks. These source reads establish the design, not current deployment or access in every cloud. Existing Public SQL external tables must not be described as a complete source for in-cloud FRP balances and consumption. Track their actual read/query surfaces separately.
