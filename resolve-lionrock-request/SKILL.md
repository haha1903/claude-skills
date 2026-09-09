---
name: resolve-lionrock-request
description: Use when someone asks for the status of a Lionrock On-demand or Planned Quota fulfillment request, why it is stuck, or why it failed. Explain the blocker or verified error and identify a dependent plan when needed. On-demand approval questions use resolve-lionrock-on-demand-approval; Execution Plan lifecycle and CCO questions use resolve-lionrock-plan-approval. Read-only.
summary: Explain a Lionrock request state, blocker or failure
handles: [Ask.RequestStatus, Ask.RequestError]
---

# Resolve a Lionrock request question

Return an answer about the identified request: its current state, the affected
sub-request or plan, and what explains the wait or failure. Status and error
questions share this investigation; an error answer additionally needs the actual
exception and causal evidence. A state name alone does not explain a failure.

Use [oncall-reply](../oncall-reply/SKILL.md) for reading the original item/thread
and the caller's reply contract. For a regional Execution Plan itself, pass its
identity and evidence to [resolve-lionrock-plan-approval](../resolve-lionrock-plan-approval/SKILL.md)
and let it complete the plan diagnosis. This resolver owns On-demand and Planned
Quota fulfillment requests, including finding the plan on which a request depends.

## Establish the live state

1. Extract the request link or ID and environment from the original item. A combined
   ID such as `11282636-1` identifies parent and sub-request. With only a parent ID,
   inspect its relevant children; never assume sub-request 1. If no usable ID is
   available, request exactly that in the reply. Missing input is not missing
   resolver coverage.
2. Use [lionrock-mcp](../lionrock-mcp/SKILL.md). Read its tool schemas, then use
   `get_request_status` for on-demand requests, or
   `get_planned_quota_request_status` and relevant history for planned quota.
   When a request depends on a regional Execution Plan, resolve that plan's
   identifiers from the supplied link or returned lookup and pass the plan
   diagnosis to `resolve-lionrock-plan-approval`.
3. Name the affected sub-request and quote its actual status, fulfillment channel,
   relevant notes and timing. Parent completion does not establish every child
   succeeded. `Notes` may describe admin cancellation or a replacement request.
4. For pending On-demand approvals, use
   [resolve-lionrock-on-demand-approval](../resolve-lionrock-on-demand-approval/SKILL.md).
   If a Planned Quota request is blocked on its Execution Plan, use
   [resolve-lionrock-plan-approval](../resolve-lionrock-plan-approval/SKILL.md) with the
   established plan identity. Preserve already-read evidence. If approval is
   complete, continue the request's execution investigation without routing back
   to the approval resolver for the same completed gate.

## Explain a failure or an unexplained wait

When the API state does not establish the cause and internal reads are permitted,
use [runtime evidence](references/runtime-evidence.md) with the existing
[kusto-query](../kusto-query/SKILL.md) capability. The reference retains the log
schemas, `OperationLog` lookup, fulfillment-ticket links and environment traps.

- Read `OperationLog.Content` for the exception before falling back to the app
  `Log`. Empty `SubRequest.Notes` and a quiet app log do not mean there was no cause.
- Match the ID, region, environment and failing attempt. Follow the inner error
  across dependency boundaries before blaming Lionrock. Historical failures may
  differ from the current one.
- When a comparable successful request is available, check the relevant difference
  before declaring the SKU or region unsupported everywhere.
- Use [wiki-query](../wiki-query/SKILL.md) for the observed error's discriminator
  or TSG, then verify that condition against this request. A matching page title
  alone is not evidence.

A restricted role must not invoke denied Kusto/IcM capabilities, run their scripts
indirectly, or reconstruct those reads through another API. Answer from permitted
state and say exactly what could not be verified. If the missing capability prevents
an adequate answer, use the caller's `resolver_unavailable` operator-log contract.

## Finish the item

For a status question, give the live state and blocker with the relevant request
link and the next step supported by that state. For an error question, give the
actual exception and the explanation it supports, with internal details adapted
to the caller's audience. Never infer an ETA or recommend a blind retry.

Return the answer through the caller; do not send a second message, retry, approve,
change quota, or update an incident. A request to perform an action belongs to an
action resolver. An unreadable source, unidentified cause or missing input remains
an explicit gap in the answer or operator log, never a claim that the request is fine.

When another resolver requested this investigation, give it the evidence and gaps;
that outer resolver produces the single final result in its caller's format.
