---
name: resolve-lionrock-plan-approval
description: Use when someone asks about a Lionrock Execution Plan or regional plan's approval, Action Required, CCO capacity orders, readiness, rejection or processing error. Determine the blocker and whether the next action belongs to an approver, requester, CCO or execution. On-demand sub-request approvals use resolve-lionrock-on-demand-approval. Read-only.
summary: Explain Execution Plan approvals, CCO communication and readiness
handles: [Ask.PlanApproval, Ask.RequestStatus, Ask.RequestError]
---

# Resolve Execution Plan approvals and blockers

Explain the specified plan's state, each remaining blocker, who can act, and the
supported next step. Read [execution-plan-rules.md](references/execution-plan-rules.md)
when diagnosing a plan; it contains the distinct approval, CCO, communication,
readiness and validity rules derived from the backend implementation.
Use [oncall-reply](../oncall-reply/SKILL.md) for original support context and the
caller's reply contract, and [lionrock-mcp](../lionrock-mcp/SKILL.md) for live reads.

## Identify the exact plan

In general explanations, `Action Required` is the portal display for an
`Approvable` plan with a stored CCO order in `CommunicationNeeded`; the synthetic
MCP CCO row also uses `ActionRequired`. The label alone proves neither an
outstanding reviewer question nor that the requester owes the next reply.
Explain both requester-response and pending-CCO-review possibilities until
the actual sub-order messages establish which applies.

An Execution Plan is keyed by `serviceTreeId + region + blueprint + version`.
Preserve all four fields, including blueprint suffixes and the region's friendly
name. Extract them from the supplied detail/review link. Regional `/all` and
`/approvable` pages are lists, not a particular plan. Resolve from the supplied
service/region context or request the missing identifier.

Use `get_execution_plan_status` for discovery when blueprint/version is absent;
its exact lookup requires both fields together. Compare the requested version
with the latest assigned version before recommending approval, but label both
and never silently replace the requested version with the latest one.

Planned Quota request IDs identify fulfillment requests, not plans. If starting
there, read `get_planned_quota_request_status` and relevant history to establish
the linked service, region, plan version and blueprint. Do not default a missing
blueprint to `GA`. A published Service Blueprint also needs a regional assignment
before this plan approval workflow applies.

## Establish all blockers

Call `get_execution_plan_approvals` for the exact four-part key. Read its
`planRegion`, every approval row, CCO order/sub-order details and comments together.

1. Establish the lifecycle state and whether this version is current. Terminal or
   processing states take precedence over stale pending approval rows.
2. For internal approvals, select `status: Pending` and give all returned eligible
   approvers in their returned order, grouped by type. Keep completed gates as
   history. Eligible aliases are alternatives, not assigned owners.
3. Inspect every associated CCO order. Completed GCT does not establish capacity
   approval. The synthetic CCO row is not a Lionrock role with approver aliases.
   `Accepted` / `InProgress` remains pending CCO processing. Without a reviewer
   question, say no customer reply is currently indicated; do not say the order
   needs no action or is complete. A submitter is not proof of the current owner:
   keep submitter aliases out of next-actor recommendations unless separate
   evidence explicitly identifies that person as responsible. Otherwise name
   only the verified role (requester/service team or CCO reviewer), with the
   specific person unverified.
4. For `CommunicationNeeded` / `ActionRequired`, inspect each affected sub-order's
   latest message and author. Quote the outstanding question and returned
   `replyPath` when a customer response is needed. If the latest author is
   `CapacityOrderCustomer`, report that the customer has replied and CCO review
   is pending. Do not infer the next actor from aggregate status alone.
5. When approval is no longer the blocker, check readiness, validity, cloud push
   and any identified fulfillment request separately. `Approved`, `Ready` and
   `isPushedToCloud` do not prove resources were fulfilled.

The MCP summary and detailed CCO states can differ because they come from
different reads. Preserve the discrepancy and use the returned detail to describe
that order; do not claim the persisted plan has advanced. An order-level `error`,
missing messages or unknown actor leaves a specific gap. Empty approvals or
unavailable CCO details do not establish completion.
Only give a sub-order reply link when its identifier and complete path are
present. An entry without a sub-order ID stays unidentified; do not link to an
incomplete `/subOrders/` path.

## Explain causes and finish

For demands or a processing error, use `get_plan_region` and select the exact
version. `get_latest_regional_plan_detail` is suitable only when the target is
that latest version. Compact status/approval tools do not expose every error,
readiness reason, rule setting or expiry decision. Missing fields are not negative
findings. Name an invalid field, auto-approval reason or waiting date only when
current evidence establishes it.

If internal investigation is permitted and still needed, use the existing
[runtime evidence reference](../resolve-lionrock-request/references/runtime-evidence.md)
with the relevant data-source skill, matching environment and the full plan key.
Do not route back to the generic request resolver for the same plan diagnosis.
Respect denied capabilities and report unavailable evidence explicitly.

Return the plan identity, current outcome, remaining internal gates, CCO action
and verified next step with the plan or sub-order link. Account for every CCO
entry in the answer, including entries without an ID or messages. For each,
state its status, what remains pending and whether a customer reply is indicated.
An `Accepted` / `InProgress` entry must explicitly remain **pending CCO
processing; no customer reply currently indicated** when no question is present.
Do not summarize it as unblocked or omit it after listing communication blockers.
Mixed blockers stay separate. The caller owns delivery and outcome recording. This skill does not
approve, reply to CCO, reprocess, reassign, retry, push a plan or send another message.
