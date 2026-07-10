---
name: icm-query
description: Use when the user wants to read or summarize IcM incidents for the BET tenant from the IcM Kusto warehouse (icmcluster / IcmDataWarehouse) — e.g. pending-action incidents for daily scrum, or any ad-hoc KQL over Incidents/IncidentDescriptions/IncidentCustomFieldEntries.
---

# IcM Query (Kusto warehouse)

Query the IcM Kusto warehouse (`icmcluster.kusto.windows.net` / `IcmDataWarehouse`)
for incident reports. Auth is local `az login` — the cluster honours your AAD user
token, no MSI / workload identity needed.

To operate on a specific incident (mitigate / ack / resolve / read details), use the
sibling `icm` skill which calls the IcM REST API.

## Helpers

| Script | What it does |
|---|---|
| `bin/icm-pending` | Run the pending-action KQL (tenant `25998`) and print JSON to stdout. |

The script is a thin Node wrapper over iris `icm.pendingActions` (which queries the
IcM Kusto warehouse via iris `kusto.queryKusto`; az cli token + fetch, no SDK).
Token is minted on demand via `az account get-access-token --resource
https://icmcluster.kusto.windows.net`.

## Run

```bash
~/.claude/skills/icm-query/bin/icm-pending                   # all tenant-25998 incidents
~/.claude/skills/icm-query/bin/icm-pending --owner me        # just mine (resolves to $USER)
~/.claude/skills/icm-query/bin/icm-pending --owner <alias>   # specific alias
~/.claude/skills/icm-query/bin/icm-pending --owner unassigned  # team-owned, no individual alias
~/.claude/skills/icm-query/bin/icm-pending --owner all       # same as no flag
~/.claude/skills/icm-query/bin/icm-pending | jq '.count'
~/.claude/skills/icm-query/bin/icm-pending --owner me \
  | jq '.incidents[] | {IncidentId, Title, Severity, OwningTeamName, NextActionTime}'
```

`--owner` matches `Incidents.OwningContactAlias` exactly. `me` resolves to the
current unix user; `unassigned` matches the empty-string alias (incident is owned by
a team but no individual is on the hook); `all` / omitted returns everything. You
can also set `ICM_QUERY_OWNER=me` in the environment if you always want your own.

Each incident row includes a `PortalUrl` field
(`https://portal.microsofticm.com/imp/v5/incidents/details/<id>/summary`) for direct
linking in a report.

## Pending-action filter (what the KQL does)

Direct port of the BET `scrum.ts` query
(`/Users/haichang/Projects/BET/src/bet-bot/gateway/skills/scrum.ts`):

- `OwningTenantId == 25998` (BET tenant, hard-coded in `bin/icm-pending`)
- `Status == "ACTIVE"`, not noise, not purged, not a child incident
- Drops sovereign-cloud noise: title without `"USSec HS"` / `"USNat HS"`
- `NextActionTime` from `IncidentCustomFieldEntries` where `CustomFieldId == 11`
- Keeps incident if **overdue** OR **not tagged `Blocked`**
- Joins latest non-bot comment (`ChangedBy not in ("healthmanagesvc","aesvc")`),
  strips HTML, collapses whitespace into `CleanComment`

## Ad-hoc queries

For one-off questions ("incidents from monitor X last week", "all sev2 since
yesterday"), use the `kusto-query` bin directly with the same cluster/database:

```bash
node ~/.claude/skills/kusto-query/bin/query.mjs \
  https://icmcluster.kusto.windows.net IcmDataWarehouse \
  "Incidents | where OwningTenantId == 25998 | where CreateDate > ago(7d) | take 50"
```

Don't reinvent the cleanup pipeline — copy the `replace_regex` chain from
`bin/icm-pending` if a query also reads `IncidentDescriptions.Text`.

## Reporting (scrum use)

After running `icm-pending`, summarize into a short markdown block:

- One line per incident: `[<IncidentId>](<PortalUrl>) Sev<N> <Title> — <OwningTeamName>`
- Group by `OwningTeamName` if list is long (>10).
- Include `NextActionTime` (or "no next action set") and the trimmed `CleanComment`
  first sentence when it adds context.
- Flag overdue rows (`NextActionTime < now()`) explicitly.

Keep it short — this lands in a Teams message.

## Common errors

| Symptom | Fix |
|---|---|
| `az: command not found` or 401 from Kusto | `az login` (the AME tenant user) |
| Empty `incidents` array | Real result for healthy tenant; sanity-check by dropping the `Status == "ACTIVE"` filter |
| `Forbidden` on the cluster | Need IcM warehouse access — request via IcM Kusto onboarding |
