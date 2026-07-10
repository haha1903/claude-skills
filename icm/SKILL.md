---
name: icm
description: Use when the user wants to read or act on a Microsoft IcM incident programmatically — get incident details, mitigate, acknowledge, resolve, assign to a person, update fields (severity/title/etc), transfer to a team, add a discussion comment, or look up incident metadata from an icm.ad.msft.net / portal.microsofticm.com URL or incident ID.
---

# IcM REST API

Operate on Microsoft IcM incidents via OData REST at `https://prod.microsofticm.com/api/user/...`.

Auth uses the **Betbot** AAD app (`8c2cd91e-48e2-4b0c-80a6-f752d877b693`, AME tenant `33e01921-...`) via Workload Identity. The Betbot SP must have the **User** role on the IcM service that owns the incident. Already granted for services Hai owns; for new services, ask the admin to add `Type: Azure managed service identity (MSI)` with the App ID + tenant, role User.

## Helper scripts (use these, don't paste curl)

Located in `~/.claude/skills/icm/bin/` — all executable, no args parsing needed.

| Script | What it does |
|---|---|
| `icm-token` | Print an IcM API access token. Cached 23h in `/tmp/icm-token.cache`. |
| `icm-call METHOD PATH [BODY]` | Generic OData call. `PATH` is appended to `…/api/user/`. |
| `icm-mitigate ID "REASON"` | Mitigate an incident. Defaults: `HowFixed=ByDesign`, `MitigateContactAlias=` current user (override with `$ICM_CONTACT_ALIAS`). |
| `icm-assign ID ALIAS` | Assign to an individual (sets `OwningContactAlias`; verifies with a GET). `ALIAS=""` unassigns. |
| `icm-assign-many ALIAS ID [ID …]` | Bulk-assign many incidents to one person; concurrent, per-incident GET verify. `ALIAS -` reads ids from stdin. |
| `icm-ack-many CONTACT ID [ID …]` | Bulk-acknowledge (ack auto-sets owner to CONTACT); concurrent, per-incident GET verify. `CONTACT -` reads ids from stdin. |

Examples:

```bash
# Get incident details
icm-call GET 'incidents(800736577)'

# Mitigate
icm-mitigate 800736577 "Policy Acknowledged - SFI advance-notice IcM, no action needed."

# Acknowledge
icm-call POST 'incidents(800736577)/AcknowledgeIncident' \
  '{"AcknowledgementParameters":{"AcknowledgeContactAlias":"haichang"}}'

# Resolve
icm-call POST 'incidents(800736577)/ResolveIncident' \
  '{"ResolveParameters":{"ResolveContactAlias":"haichang"}}'

# Assign to a person (sets OwningContactAlias)
icm-assign 800736577 lingc
# equivalently, the raw PATCH:
icm-call PATCH 'incidents(800736577)' '{"OwningContactAlias":"lingc"}'

# Bulk assign / ack (client-side concurrency — IcM has NO $batch endpoint)
icm-assign-many lingc 828738586 828738619 828738701
icm-ack-many haichang 827735814 827735820          # ack auto-assigns owner to haichang
icm-pending --owner unassigned | jq -r '.[].IncidentId' | icm-ack-many haichang -

# Update writable fields (severity, title, flags, …)
icm-call PATCH 'incidents(800736577)' '{"Severity":2,"IsCustomerImpacting":true}'

# Transfer to another TEAM (team-level, not a person)
icm-call POST 'incidents(800736577)/TransferIncident' \
  '{"TransferParameters":{"OwningTenantPublicId":"<tenant-guid>","OwningTeamPublicId":"<team-id>"}}'

# Discover any available action
icm-call GET '$metadata' | grep -oE '<FunctionImport Name="[^"]*"' | sort -u
```

Body schemas live in `<ComplexType Name="Incident<X>Parameters">` in the same metadata doc.

## Assign / update / transfer (the operations that are NOT actions)

IcM supports **partial update via OData PATCH** on the incident entity — this is
distinct from the POST `*Incident` actions. Two gotchas that cost time if unknown:

- **Assigning to a person is a PATCH of `OwningContactAlias`, NOT an action.** There
  is no `AssignIncident` FunctionImport — searching the metadata for one finds
  nothing and misleads you into thinking API assign is impossible. It is a plain
  `PATCH incidents(ID) {"OwningContactAlias":"alias"}`. Use `icm-assign`.
- **Team ownership (`OwningTeamId`/`OwningTenantId`) changes ONLY via
  `TransferIncident`** (team-level, no contact field). PATCHing those directly
  won't stick — the Get-Incident doc marks them "modified only when transferred".

Writable via PATCH: `OwningContactAlias, Severity, Title, Keywords, Summary,
IsCustomerImpacting, IsNoise, IsSecurityRisk, Component, CommitDate`. Read-only:
`Id, CreateDate, ModifiedDate, HitCount`. PATCH returns 204/empty on success —
verify with a follow-up GET (icm-assign does this automatically). Ref:
eng.ms/docs/products/icm/developers (Get Incident → property table + Supported
operations).

## Endpoint pattern

OData with parens, NOT path-style: `incidents(123)/Action`, never `incidents/123/action` (returns 404).

## Inputs

Accept either an IcM URL or a bare ID. Parse `(\d{6,})` to extract. URL forms:
- `https://portal.microsofticm.com/imp/v5/incidents/details/<ID>/summary`
- `https://icm.ad.msft.net/imp/v3/...?id=<ID>`

## Common errors

| HTTP | Cause | Fix |
|---|---|---|
| 401 | Token expired / cache stale | `rm /tmp/icm-token.cache && icm-token` |
| 403 on POST (GET works) | Betbot not in target service Role Members | Ask service admin to add Betbot (MSI type, App ID `8c2cd91e-...`, tenant `33e01921-...`, role User) |
| 403 still after role just added | IcM role propagation lag (5–15 min) + token cache stores old denial | Wait ~10 min, then `rm /tmp/icm-token.cache` (token itself is fine, but always re-mint after role changes) and retry. Do NOT keep hammering. |
| 404 on action | Wrong endpoint form | Use parens `incidents(123)/Action` |
| `Forbidden` on GET | Concurrent/stale token | Delete cache, retry |

## Notes

- IcM alert payload for SFI/AzurePolicy alerts is easier to inspect via the SCUBA Kusto table `cluster('scuba.centralus.kusto.windows.net').database('ICMPublisherPROD').ICMPublisherIncidents` (see `kusto-query` skill).
- `MitigateContactAlias` must be a valid IcM user. `haichang` works for his own incidents.
- Mitigate sets `Status=Mitigated` and stops Sev escalation but does not close. Use `ResolveIncident` to fully close.
