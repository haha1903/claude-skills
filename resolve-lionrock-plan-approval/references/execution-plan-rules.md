# Execution Plan decision rules

Source checked on 2026-09-09 against AzureGlobal-DCValidation commit `420a76b5b`.
These are code paths, not proof of an environment's enabled flags or team settings.
Live records decide the outcome; verify configuration/history before naming a cause.

## 1. Objects and approval requirements

The regional plan key is service, region, blueprint and version.
`PlanRegionApproval` stores a type's status for that key. On-demand `Approval`
belongs to a request/sub-request. Planned Quota requests are fulfillment requests
that may depend on an approved plan.

`ProcessNewPlansJob` parses blueprint demands into `PlanDetail.RequiredApproval`,
creates the corresponding approval rows and tries automatic approval. Different
units of one service can require different gates. Use the returned rows rather
than reconstructing requirements from the service name.

For resource rows routed through the basic regional approval:

| Region/cloud condition | Basic approval |
|---|---|
| WAEAP-managed region (EUAP or STG suffix) | WAEAP |
| Public cloud, Jio India Central or Jio India West | AG and GCT |
| Other regions/clouds | GCT |

Other resource rows use service-specific gates such as SQL, DNS, AppService,
HDInsight, VMDisk or InternalVM. Some access-only rows have no approval requirement.
The source applies these rules per resource/unit, not one universal plan-level type.

## 2. When manual approval remains

A required gate stays Pending until a user or applicable automatic rule completes it.
The main automatic paths are:

- **History:** prior approved amounts cover the demand, with a non-positive quota
  difference and compatible approved SKU alternatives.
- **Thresholds:** resource/unit/SKU quotas meet built-in or regional/cloud thresholds.
  A type completes when all its relevant resources qualify, not just one small row.
- **Air-gap:** a dedicated path auto-approves eligible non-GCT resource rows.
- **Buildout:** Buildout regions excluding SLV; Ring0 qualifies, while other teams
  can qualify through `AutoApproveRegionalPlansForBuildout` or regional PSL membership.
- **AZ Retrofit:** feature-gated, in-scope `ZoneExpansion` plans have a separate
  automatic path and dynamic `AzRetrofitScope` validity. Not every expansion qualifies.
- **UAT:** an environment-specific automatic path; do not apply it to production.

Special whole-plan automatic paths can bypass the ordinary CCO check. Do not say
every approved plan had a manually approved order. `System` in an approval row
does not identify which rule fired.

## 3. Who can approve

Internal approval requires an Approver/ApproverAdmin role covering the type and
region; Administrator is privileged. The endpoint also requires `Approvable`
and the latest assigned version. One action completes only the pending types
covered by the user's permissions.

The ranked alias list is a recommendation, not an assignment or the full authorization
policy. Preference: exact type/region, all types in that region, that type across
regions, then Administrator fallback when no non-admin candidates match. All selected
candidates are returned. Omitting an admin from recommendations does not remove the
admin's backend permission. `by` / `approvedBy` are historical actors.

## 4. CCO is a separate approval dependency

Creation requires Public cloud, a live post-MA region, regional CCO support, a
non-WAEAP region and `EnableCapacityOrder`. Supported resource rows must require
GCT and not be auto-approved. Further filtering considers readiness/plan flags,
remaining subscription allocations and plan kind. Orders may be reused, and Hobo
and non-Hobo orders may coexist.

When an order is established for the current version, the job can record internal
GCT as approved by System. The ordinary path requires **all internal gates and all
associated CCO orders** to be approved before the plan becomes Approved. No
associated orders means no CCO gate in that check.

| Observation | Interpretation and next step |
|---|---|
| Internal type Pending | Give that type's eligible Lionrock approvers. |
| GCT Approved, CCO Accepted/InProgress | Capacity review remains; do not ask for another GCT click. |
| CCO CommunicationNeeded | Inspect sub-order messages to determine whose response is next. |
| All CCO orders Approved, another internal type Pending | The internal gate still blocks the plan. |
| CCO Failed/Rejected or another non-approved terminal state | Report the actual order outcome and reason, not an ordinary approval queue. |
| All gates complete, plan still Approvable | Report the discrepancy or pending synchronization; do not invent another approver. |

Portal `GetPlanRegionApprovals` displays GCT as `Waiting for Capacity Order` while
any associated order is not Approved, even if its stored internal row is Approved.
MCP returns that row and a separate synthetic CCO row: `ActionRequired` if any
stored order is CommunicationNeeded, `Approved` if all are Approved, otherwise
`Pending`. This last bucket also includes failed/rejected orders: inspect details.

The CCO summary uses stored statuses; individual order details are fetched from
CCO and can differ. A failed fetch returns an order-level `error`. Neither that
failure nor an absent message proves completed approval.

## 5. Action Required and who owes a response

The plan detail page displays `Action Required` when the stored plan is
`Approvable` and an associated stored order is `CommunicationNeeded`. This is a
display condition, not another `PlanRegionStatus` value. MCP's `planRegion.status`
can still be `Approvable` for that same plan.

For each affected sub-order, sort messages by `createdTime` and inspect the latest:

- A recognizable reviewer question without a later customer response: quote the
  required information and give the returned Lionrock `replyPath`.
- Latest author `CapacityOrderCustomer`: the customer has replied; CCO review is
  next. Do not ask them to repeat it because aggregate status has not changed.
- Missing messages, uncertain author or ambiguous ordering: explicitly say the
  next actor is unverified. Do not manufacture a question, approver or owner.

`EvaluatePlanRegionPendingCcoAsync` uses this customer-author marker to distinguish
waiting on CCO from waiting on the requester. Its non-customer branch is not a
directory lookup. Do not infer an assigned human from an arbitrary author string.
Assess multiple sub-orders independently: different parties can owe different actions.

The portal offers `Unblock Action` / discussion navigation and sub-order reply
pages. Ordinary plan comments do not approve gates. A reply link is a read-only
next step; posting the response is a separate action.

## 6. Lifecycle, validity and execution

| Persisted state or field | Meaning and diagnostic boundary |
|---|---|
| Created | Initial processing; inspect evidence before saying it waits for an approver. |
| NeedSignOff | Service-team sign-off in the enum. Verify the applicable path: the current processing job moves Created/Error to Approvable directly. |
| Approvable | Approval phase; inspect internal gates and CCO, not the label alone. |
| Approved | Plan approval completed under the applicable path. Special whole-plan auto-approval can bypass CCO, so this status alone does not prove an associated order is Approved. Readiness and fulfillment remain separate. |
| Ready | Approved and required dependencies are ready. Portal text is `Ready to Fulfill`. |
| Error | Processing failed. Get the exact version's error; do not guess a field or recommend blind retry. |
| Rejected | Give actor/time/comment when available. Stale pending rows do not make this version approvable. |
| Removed | Assignment removed. Verify whether a newer version replaced it. |
| FulfillmentStarted | Obsolete legacy enum; not a required step in the modern flow. |
| isPushedToCloud | Plan pushed to the target cloud, not resources provisioned. |

Validity is separate from the status enum; `PlanRegionStatus` has no `Expired`
value. `Custom` uses a date; `NeverExpire` has no fixed expiry; `GA` is rendered
as MA in the UI and depends on region lifecycle; `AzRetrofitScope` depends on
current project/PSL membership. Backend validity call sites have different boundary
semantics: use the current decision/error and context rather than reimplementing
expiry from the label or assuming Approved is still valid.

`startDate` / `Need By Date` is not an approval deadline, guaranteed capacity ETA
or by itself proof of a scheduling blocker. To say "waiting until date X", verify
the actual execution/fulfillment gate. To say "fulfilled", read the associated
request/bindings or other fulfillment evidence. Ready or pushed is insufficient.

## 7. Source map and evidence limits

Paths below are relative to `src/Lionrock/service/` in
[AzureGlobal-DCValidation](https://dev.azure.com/msazure/One/_git/AzureGlobal-DCValidation).

| Concern | Source / method |
|---|---|
| Requirements and auto-approval | `Lionrock.WebJobs/Continuous/ProcessNewPlansJob/ProcessNewPlansJob.cs`: `ExtractPlanDetailEntitiesAsync`, `TryAutoApprovePlanRegionApprovalsAsync`, `TryAutoApprovePlanRegionAsync` |
| Region mapping and thresholds | `Lionrock.Declarative.ARM/PlanRegionApproval.cs` |
| Approval authorization | `Lionrock.DataProvider/ApprovalsProvider.cs`; `Lionrock.WebApp/Controllers/PlannedQuotaController.cs`: `ApprovePlanRegion` |
| Partial internal approvals | `Lionrock.Declarative.ARM/PlanRegionApprovalsProvider.cs`: `SetPlanRegionApprovalsAsync` |
| CCO eligibility | `Lionrock.Declarative.ARM/CapacityOrderProvider.cs`: `AllowToCreateOrUpdateCapacityOrder`, `GetCapacityOrderRelatedPlanDetails` |
| Gates, communication and validity | `Lionrock.Declarative.ARM/PlanProvider.cs`: `ApprovePlanRegionAsync`, `CheckPlanRegionAutoApprovedAsync`, `GetPlanRegionDetailPayloadAsync`, `EvaluatePlanRegionPendingCcoAsync`, `IsPlanRegionApprovedStatusValidAsync`, `EnsureApprovalNotExpiredAsync` |
| Readiness and cloud push | `Lionrock.Declarative.ARM/ExecutionPlanManager.cs`: `UpdatePlanStatusIfReadyAsync`, `PushExecutionPlanInCloudAsync` |
| MCP shape and stored/live split | `Lionrock.WebApp/Mcp/LionrockMcpTools.cs`: `GetExecutionPlanApprovalsAsync`, `BuildCcoEntryAsync`, `BuildCcoOrderDetailAsync` |
| UI labels | `Lionrock.WebApp/ClientApp/src/app/quota/plans/plan-detail.component.ts` and `.html` |

Compact MCP tools omit some errors, rule settings and readiness reasons.
`get_plan_region` provides versioned payloads; `get_latest_regional_plan_detail`
is latest-only. Use the exact version and permitted diagnostics for missing
evidence. An absent field does not show that a rule, blocker or error is absent.
