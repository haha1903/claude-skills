---
name: resolve-lionrock-request
description: Use when someone asks for the status of a Lionrock On-demand or Planned Quota fulfillment request, whether a previous retry completed, why it is stuck, or why it failed. Explain the blocker or verified error and identify a dependent plan when needed. On-demand approval questions use resolve-lionrock-on-demand-approval; Execution Plan lifecycle and CCO questions use resolve-lionrock-plan-approval. Read-only.
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
3. Read each relevant child's status, fulfillment channel, notes and timing separately.
   Parent completion does not establish every child succeeded. `Notes` can describe
   an earlier auto-completion, cancellation or replacement. After a retry, notes and
   `completedTime` can still describe the original attempt while `fulfillChannel`
   reflects the new one. Preserve the returned channel and resolve the timeline
   before using an old note or timestamp to explain the current outcome.
4. For pending On-demand approvals, use
   [resolve-lionrock-on-demand-approval](../resolve-lionrock-on-demand-approval/SKILL.md).
   If a Planned Quota request is blocked on its Execution Plan, use
   [resolve-lionrock-plan-approval](../resolve-lionrock-plan-approval/SKILL.md) with the
   established plan identity. Preserve already-read evidence. If approval is
   complete, continue the request's execution investigation without routing back
   to the approval resolver for the same completed gate.

## Verify a reported retry or recovery

In Loop, check `LOOP_ROLE` before choosing a source. `user` must use only permitted
MCP and wiki reads, never Kusto or IcM, even when a script is readable or executable.
Only `oncall` and `developer` may use the internal runtime sources below. The host
uses its own access policy. An available credential does not grant the caller access.

When the thread reports a retry, or current fields conflict with an earlier outcome,
read the matching operation history before concluding how that attempt ended.
Use the available MCP history tool for the request type. For On-demand requests,
when internal reads are permitted, read `OperationLog` through
[runtime evidence](references/runtime-evidence.md) and `kusto-query`.

- Match the parent, child and environment. Find the latest relevant `Retry`, then
  its subsequent operations, including any later failure or retry. A `Retry` entry
  alone, an older `Complete`, or the current `Completed` status does not prove that
  the retry succeeded. Incomplete history leaves the outcome unverified.
- A later successful `Complete` establishes completion in Lionrock. Report the
  completion time from that attempt's history, not the old `completedTime` field.
  Registration operations establish the action recorded by the service, not that
  the customer has successfully created a resource.
- A colleague's message is evidence of what they reported. Attribute it when used.
  Their "likely transient" explanation is not a verified cause. If history is
  inaccessible to this role, give the permitted current state and clearly separate
  the reported retry from an independently verified result. Do not bypass permissions.

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
to the caller's audience. Explain an original auto-completion as its recorded
decision reason. It does not establish why that decision disagreed with actual
access. Skipping fulfillment in one attempt does not establish that access was
absent then, that no other process registered it, or that this caused the customer's
failure. Do not call that decision a false positive without evidence of the actual
access state at that time. A later registration or successful retry cannot establish
the earlier access state. It does not prove or disprove a transient fault, stale cache
or stale records. State an unestablished cause plainly without a speculative diagnosis.

Lead with the current result and the requested, verified facts. A verified retry
result remains useful when its original cause is unknown. Do not claim that no
additional access is needed, that propagation takes a particular time, or that
resource creation now works without evidence for that claim. A customer recheck
can be suggested as a check, not described as already successful. Never infer an
ETA or recommend a blind retry.

For a recovered request, use this short answer structure:

1. Link the request using the supplied or returned URL and state the verified current
   result. If the retry was verified, give its completion time and recorded action.
2. Explain any misleading old fields as historical values. Separate the recorded
   decision from the unknown cause of the customer's earlier failure.
3. State the remaining limit and a supported customer check, if needed. Stop there.

Before returning, check every claim against the field, operation or attributed
message supporting it. Remove causal phrases such as "which is why" when no evidence
connects the events. Do not explain an empty lookup by inventing table semantics.
The final response starts at step 1. Do not prepend "I verified", "here is the answer",
"composing the reply", an evidence summary, or a separator before the actual answer.
Omit tool names, query details, confidence claims and promises to investigate later
unless a follow-up was actually arranged. Keep investigation notes outside final text.

Return the answer through the caller; do not send a second message, retry, approve,
change quota, or update an incident. A request to perform an action belongs to an
action resolver. An unreadable source, unidentified cause or missing input remains
an explicit gap in the answer or operator log, never a claim that the request is fine.

When another resolver requested this investigation, give it the evidence and gaps;
that outer resolver produces the single final result in its caller's format.
