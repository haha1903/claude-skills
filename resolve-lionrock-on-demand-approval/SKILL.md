---
name: resolve-lionrock-on-demand-approval
description: Use when someone asks who can approve a Lionrock On-demand request or sub-request, or which request approvals are still pending. Identify the required gates and eligible approvers for each affected sub-request. Execution Plan and CCO questions use resolve-lionrock-plan-approval. Read-only.
summary: Explain pending On-demand request approvals and who can approve
handles: [Ask.RequestStatus]
---

# Resolve On-demand request approvals

Answer which approvals are pending, who is eligible for each one, and the next step
supported by the current state. Use [oncall-reply](../oncall-reply/SKILL.md) for
original support context and the caller's reply contract, and
[lionrock-mcp](../lionrock-mcp/SKILL.md) for live reads.

## Identify the sub-request

Obtain the parent request ID and positive sub-request ID. A combined ID such as
`11282636-1` identifies both. With only a parent ID, read `get_request_status` and
inspect every relevant child; do not assume sub-request 1. Ask for missing input
only when available context cannot identify the target. Numeric IDs alone do not
distinguish On-demand from Planned Quota; use the link and returned request type.

A Planned Quota fulfillment request is a different object. Use
[resolve-lionrock-request](../resolve-lionrock-request/SKILL.md) for that request;
use [resolve-lionrock-plan-approval](../resolve-lionrock-plan-approval/SKILL.md)
when its blocker concerns the associated Execution Plan.

## Read and interpret approvals

Call `get_request_approvers` with both `id` and `subRequestId`, after reading the
deployed schema. Use `approvals[].pending`, not a plan-style `status` field.
The tool includes recorded approvals and missing required types. Requirements
depend on request type and region; automatic approval can complete only some gates.

- For every pending type, give all returned `approvers` in their returned order.
  They are eligible alternatives, not assigned owners or people who must all approve.
- Preserve completed gates using `by`, `at` and `comments`. AG approved does not
  establish GCT approval. Pending follows an empty `By`, not an empty timestamp.
- Alias lists can appear on completed gates. Empty approvers do not clear a pending
  gate. The native tool supplies no contact address; do not invent one.
- `PrevApprovals` and historical auto-approval operations do not establish current
  approval. Failed reads and `found: false` are gaps, not completed approvals.

If the request is cancelled, rejected or completed, report that current outcome
before any remaining approval records. If approvals are complete but the request
is waiting, pass existing evidence to
[resolve-lionrock-request](../resolve-lionrock-request/SKILL.md) for execution and
fulfillment-ticket investigation. On-demand `ActionRequired` can reflect a linked
ticket's state; it is not the Execution Plan CCO communication rule.

## Return the result

Lead with the current outcome, then group pending gates and aliases by sub-request.
Include the request link and verified next step. Do not replace a retrieved list
with instructions to click "Who can approve". Return through the caller's reply
or operator-log contract. Missing identifiers, unavailable reads and unknown
approvers remain explicit gaps. This lookup does not approve, retry, contact an
approver, or send a separate Teams/email message.
