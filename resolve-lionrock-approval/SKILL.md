---
name: resolve-lionrock-approval
description: Use when a support-channel post, support email or direct question asks who can approve a Lionrock request, sub-request, planned quota or execution plan, or why it is still waiting for approval. Look up the current pending gates and eligible approvers, then answer the asker with their aliases and contacts. Handles the approval-specific part of request-status questions; general status and errors use resolve-lionrock-request. Read-only.
summary: Answer who can approve a Lionrock request or plan now
handles: [Ask.PlanApproval, Ask.RequestStatus]
---

# Resolve a Lionrock approval question

The deliverable is an answer to the asker: which approval is still pending, who can
approve it now, and the next step supported by the live state. Classification or a
tool result alone does not finish the item.

Use [oncall-reply](../oncall-reply/SKILL.md) for original item context and the
caller's reply contract. Use [lionrock-mcp](../lionrock-mcp/SKILL.md) for the live reads, tool schemas and
approval-field semantics. This skill owns the support resolution; that skill owns
the API calls. The dependency is read-only and available to ordinary users.

## Identify the request or plan

Read the original question and its supplied links or context. For support mail,
read the original message through the caller's mail binding before classifying
from its content; the event may deliberately omit the subject and body.

- **On-demand request:** obtain the parent request ID and sub-request ID. A combined
  ID such as `11282636-1` identifies both. If only the parent ID is given, read
  `get_request_status` to identify the relevant sub-requests. For a whole-request
  approval question, check each relevant sub-request and label the results; never
  silently assume sub-request 1. If the supplied context cannot distinguish the
  target, ask for the missing ID or region in the reply.
- **Planned quota / execution plan / service blueprint:** resolve the plan's service,
  region, blueprint and version from the supplied link or status lookup, then read
  `get_execution_plan_approvals`. Use the tool's listed schema for the exact arguments.
- **No usable identifier:** ask for the request or plan link. Do not ask again for
  fields already present in the original message or returned by a lookup.

## Read the current approvals

For each on-demand sub-request, call the native `get_request_approvers` with both
`id` and `subRequestId`, even when `id` is combined. Select `approvals` rows whose
`pending` is true; approved rows also carry eligible aliases. The native request tool
does not return a contact address. For plans, use the current pending rows from
`get_execution_plan_approvals`.

The plan tool can also return a synthetic CCO capacity-order entry. If it reports
`CommunicationNeeded`, give the returned question and Lionrock UI reply path as
the next step; do not turn that communication request into an invented approver.

Group eligible aliases and contacts by pending approval type and by sub-request or
plan when there is more than one. Historical `by` / `approvedBy` / `PrevApprovals`
identify past actors, not who can approve now. One completed gate does not complete
the others: AG may be auto-approved while GCT is still pending.

An empty eligible-alias list does not mean approval is complete. Give the returned
contact when available, and state any missing approver information explicitly.
An authentication error, not-found result or incomplete response cannot establish
that no approval is pending; say the current approvers could not be verified.

If approvals are complete, check execution status before explaining the remaining
wait. Give a future fulfillment date or an invalid plan field only when the live
result establishes it. Otherwise report the observed state and the remaining gap;
do not invent an approval deadline or infer completion from an empty result.

## Answer the asker

Lead with the current outcome, then give **all returned eligible aliases and
contacts for each pending gate** and the actionable request or plan link when
available. Say they are eligible approvers, not that every listed person must
approve or that one person has been assigned the request. Do not replace the list
with instructions to click "Who can approve", or offer to look up a list already
retrieved. Keep other prose short so the actionable information fits.

Follow the caller's reply language and format. For a support item, return the
user-addressed answer as the final reply; keep classification and API diagnostics
in the work notes. The existing adapter owns draft, review and delivery behavior.
Do not send a second Teams message or email from this skill, contact approvers,
approve, or retry the request. A request to perform an approval is an action
request, not a lookup. Do not promise a chase or follow-up that was not arranged.

The lookup is resolved when the current pending gates and available approvers have
been given, or the live state establishes that approval is no longer the blocker.
Missing identifiers, unavailable reads and unknown approvers remain explicit gaps;
never record them as a successfully identified approver.

When another resolver requested this lookup, return the approval findings and gaps
to it. The outer resolver owns the single final answer or operator-log outcome.
