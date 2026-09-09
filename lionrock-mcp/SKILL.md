---
name: lionrock-mcp
description: Use when a caller needs live Lionrock request, sub-request, planned-quota, execution-plan, approver or regional service-status data. Provides read tools, schemas and field semantics to business resolvers and direct API lookups. Read-only.
summary: Read live Lionrock request, quota and plan state

---

# Lionrock MCP

A read capability used by business resolvers and direct API lookups. It declares
no business categories and does not decide that an item has been resolved. Prefer it over Kusto for a
question about ONE request, plan or blueprint. On-demand approvers are read through
the deployed native `get_request_approvers` MCP tool, using the same delegated identity.

Kusto is still the right tool for the error *behind* a state, for aggregates, and for
anything over a time window.

## Run

```bash
node "$HOME/.claude/skills/lionrock-mcp/bin/lionrock-mcp" tools
node "$HOME/.claude/skills/lionrock-mcp/bin/lionrock-mcp" call get_request_status '{"id":"11253549"}'
node "$HOME/.claude/skills/lionrock-mcp/bin/lionrock-mcp" call get_request_approvers '{"id":"11282636","subRequestId":1}'
```

`tools` lists every tool with its input schema. **Read it before guessing an argument
name**: they are not uniform, and a wrong name comes back as the unhelpful
`An error occurred invoking '<tool>'` rather than a validation message. `get_request_status`
takes `id`; `get_planned_quota_request_history` takes `requestId`.

## What is there

`tools` lists the deployed server tools and their actual input schemas:

| Question | Tool |
|---|---|
| On-demand request state, with its sub-requests | `get_request_status` |
| Current pending approvers for an on-demand sub-request | `get_request_approvers` |
| Planned-quota request state / audit trail | `get_planned_quota_request_status`, `get_planned_quota_request_history`, `list_planned_quota_requests` |
| Execution plans in a region, or for a blueprint | `get_regional_plans`, `get_region_plan_status`, `get_latest_regional_plan_detail`, `get_plan_regions_by_service`, `get_plan_region` |
| Plan approval and execution state | `get_execution_plan_approvals`, `get_execution_plan_status` |
| Is a service type open in a region | `get_service_type_status` |
| Planned-quota subscription bindings | `get_subscription_bindings` |

## Who can approve now

Return live approval rows to the calling resolver. Business matching, pending-gate
interpretation and the user-facing answer belong to
[resolve-lionrock-approval](../resolve-lionrock-approval/SKILL.md). This capability
does not invoke a resolver back while it is servicing a read.

For an on-demand sub-request, always pass both `id` and the positive integer
`subRequestId`. A combined `id` such as `11282636-1` still requires `subRequestId: 1`;
the server rejects conflicting IDs. It returns recorded approvals plus any missing
required types, using the portal's ranked approver resolver for the sub-request's region.

Read `result.approvals` and select rows with `pending: true`. Use each pending row's
`type` and `approvers` in the answer. Approved rows also contain eligible aliases, so
an alias list alone does not mean approval is pending. An empty alias list does not
clear a pending gate. The native tool does not return `pendingApprovalTypes` or a
`contact` address; do not invent either a contact or an assigned owner.

Approved rows retain `by`, `at`, and `comments`. Pending follows an empty `By`, not
an empty `At`. Preserve completed rows when explaining which gates have passed.
`found: false` is a missing request or parameter error; read its `message` and never
interpret it as all approvals complete.

An `AutoApprove` operation can approve only one type. **AG approved does not mean GCT
approved.** A Created status, ApprovedBy summary, or OperationLog alone cannot establish
that all required approvals are complete. `PrevApprovals` is historical and is deliberately
excluded from this tool's current approver results.

For Planned Quota / Service Blueprint plans, `get_execution_plan_approvals` already returns
eligible approvers alongside each approval status. Read the pending rows' `approvers`;
`by` / `approvedBy` are past actors, not the people who can approve now. Use the status
lookup first if the serviceTreeId, region, blueprint, or version is not yet known.

## Auth, and what a failure means

MCP uses the delegated user token from iris's MSAL cache
(on the PVC in loop). Use the named `mcp/user_impersonation` scope configured in iris,
not an AME workload-identity token. A 403 from that different identity does not establish
that the portal API is unavailable to the delegated user.

If silent authentication fails with:

```
no usable token for https://lionrock-prod... and IRIS_TOKEN_REFILL=none
```

That means re-import from a machine that can log in interactively:
`node ~/Projects/iris/bin/import-mcp-token.mjs lionrock`, then copy the cache file onto the
PVC. Report it as "cannot read live Lionrock state right now" and answer from the wiki and
Kusto for other status evidence instead. **Never** present a failed read as "no pending
approver". HTTP errors, login pages, and incomplete approval responses fail the command;
a 403 needs an identity/permission check, and an expired token needs re-authentication.

## Scope

Read-only, and that is a hard rule: there is no tool here that changes anything, and a
request that needs retrying belongs to `lionrock-request-retry` with a human deciding.
