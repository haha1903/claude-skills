---
name: icm
description: Use when the user wants to read or act on a Microsoft IcM incident programmatically — get incident details, mitigate, acknowledge, resolve, assign to a person, update fields (severity/title/etc), transfer to a team, add a discussion comment, or look up incident metadata from an icm.ad.msft.net / portal.microsofticm.com URL or incident ID.
summary: Read or act on one IcM incident: details, comment, tag, mitigate, resolve
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
| `icm-route-by-history [--json] [--owner ALIAS]` | **Run this BEFORE assigning anything.** Suggests an owner per family by reading who closed the same signature before. Read-only. `--owner` reads one person's active backlog instead of the pending queue. See "Who owns this?" below. |
| `icm-assign ID ALIAS` | Assign to an individual (sets `OwningContactAlias`; verifies with a GET). `ALIAS=""` unassigns. |
| `icm-assign-many ALIAS ID [ID …]` | Bulk-assign many incidents to one person; concurrent, per-incident GET verify. `ALIAS -` reads ids from stdin. |
| `icm-ack-many CONTACT ID [ID …]` | Bulk-acknowledge (ack auto-sets owner to CONTACT); concurrent, per-incident GET verify. `CONTACT -` reads ids from stdin. |
| `icm-tag ID [KEYWORD]` | Append a keyword to `Keywords` (read-modify-write, deduped; verifies with a GET). Default `KEYWORD=oncall-bot-handled`. See the two on-call tags below. **`Keywords`, not `Tags` — see below.** |
| `icm-untag ID KEYWORD` | Remove a keyword from `Keywords` (inverse of `icm-tag`; verifies with a GET). Used to clear the awaiting marker when an incident goes terminal. |
| `icm-set-tag ID TAG` | Add a tag to the `Tags` collection (read-modify-write; verifies with a GET). **This is the field program dashboards read** (AzRF etc.). |
| `icm-unset-tag ID TAG` | Remove a tag from `Tags` (inverse of `icm-set-tag`; verifies with a GET). |
| `icm-saved-query <sl\|url> [--filter-only]` | Resolve a portal Advanced-Search share link (`?sl=<id>`, bare id or full URL) to its saved query and list the incidents it selects. `--filter-only` prints just the name + compiled OData filter. |
| `icm-shared-queries [--folder F] [--run NAME]` | List the portal "Shared Queries" tree for the configured contact (name/folder/queryId). `--folder` narrows to one folder (e.g. `'Pending Action'`); `--run NAME` runs that query and lists its incidents. |

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
icm-route-by-history                                # FIRST: who does history say owns each family?
icm-assign-many lingc 828738586 828738619 828738701

# ACK SETS THE OWNER, so acking is claiming. Only ack what is genuinely yours to work.
icm-ack-many haichang 827735814 827735820
# Acking every unowned incident is NOT the same as triaging them, and it is how 20
# sovereign-cloud mirrors ended up under one person: the work lives in another IcM
# instance, so claiming them achieved nothing except moving them onto his queue.
# Route by history and assign; ack only where the work is actually ours.

# On-call drain markers (two tags, different snapshot semantics):
icm-tag 800736577                                  # oncall-bot-handled (terminal) — dropped from the next snapshot
icm-tag 800736577 oncall-bot-awaiting-decision     # awaiting a human decision — STAYS in the snapshot (flagged), not re-investigated
icm-untag 800736577 oncall-bot-awaiting-decision   # clear awaiting once the decision is executed (then icm-tag it handled)

# Program tags live in Tags, NOT Keywords — icm-tag would write a field AzRF never reads.
icm-set-tag 854368170 AzRF.HasETA.2026-08-28        # read-modify-write: keeps AzRF.SME already there
icm-unset-tag 854368170 AzRF.HasETA.2026-08-28      # e.g. to correct a slipped ETA date

# Update writable fields (severity, title, flags, …)
icm-call PATCH 'incidents(800736577)' '{"Severity":2,"IsCustomerImpacting":true}'

# Transfer to another TEAM (team-level, not a person)
icm-call POST 'incidents(800736577)/TransferIncident' \
  '{"TransferParameters":{"OwningTenantPublicId":"<tenant-guid>","OwningTeamPublicId":"<team-id>"}}'

# Discover any available action
icm-call GET '$metadata' | grep -oE '<FunctionImport Name="[^"]*"' | sort -u
```

Body schemas live in `<ComplexType Name="Incident<X>Parameters">` in the same metadata doc.

## Who owns this? Ask history, do not read the title

**Before any assign, run `icm-route-by-history`.** It groups the queue by title
signature, looks up who closed each family's RESOLVED/MITIGATED siblings, and prints
the histogram behind its suggestion.

Do not work this out by reading titles. It went wrong four ways in one pass, and every
wrong answer looked right, because the failure mode is an **empty result**: "nobody has
closed one of these" and "my query was wrong" are the same output. Two traps in
particular, both of which produced a confident "no history" for a family that had
plenty:

- **Querying the pending queue for a historical owner.** Everything in it is unowned by
  definition, so it returns nothing. Query the CLOSED siblings.
- **Searching on a truncated or normalised title.** A fixed-length prefix ends
  mid-token and matches zero rows; so does collapsing whitespace, because IcM really
  does send `[%(ClusterName)]  Task` with two spaces.

Three things the tool will not decide: an alias that has **left the company** (it cannot
know, and off the on-call roster is not the same as gone -- ask), a **`tie`** where the
top alias leads by one, and **`no-history`** where nothing has ever matched. And note
`--owner ALIAS` reads a person's ACTIVE backlog, which no pending query can see: one
departed colleague was holding 64 incidents that were invisible precisely because they
were owned.

Full rules, the exact OData filter and each failure mode: on-call wiki,
`concepts/icm-ownership-routing-by-history.md`.

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

Writable via PATCH: `OwningContactAlias, Severity, Title, Keywords, Tags, Summary,
IsCustomerImpacting, IsNoise, IsSecurityRisk, Component, CommitDate`. Read-only:
`Id, CreateDate, ModifiedDate, HitCount`. PATCH returns 204/empty on success —
verify with a follow-up GET (icm-assign does this automatically). The authoritative
field list is `documentation/developers/EditIncident.md` in the ADO repo
`msazure/One/EngSys-OneIM-IcmDocs` — the rendered eng.ms page for it 404s.

### `Keywords` and `Tags` are different fields. Both are writable.

This skill used to state that `Tags` was system-managed and read-only. That was
never verified and is wrong: `EditIncident` lists `Tags` as an optional field and
its sample body sets `"Tags": ["demo tag"]`.

The distinction is load-bearing because **program dashboards read `Tags`**. AzRF
(MountainPass SR15) tracks `AzRF.HasETA.YYYY-MM-DD` / `AzRF.OK2Enforce` /
`AzRF.SDPInProgress` in `Tags`, and its Kusto tracking table selects the `Tags`
column. Tagging with `icm-tag` writes `Keywords`, which that program never reads,
so the incident goes on counting as untagged while the portal shows nothing — and
for AzRF a missing ETA tag is itself the EVP-escalation trigger.

- `Keywords` — `Edm.String`, `;`-joined. Our own marker space (on-call drain). `icm-tag` / `icm-untag`.
- `Tags` — `Collection(Edm.String)`. What programs read. `icm-set-tag` / `icm-unset-tag`.

**`Tags` PATCH replaces the whole collection**, so it is always
read-modify-write. `PATCH {"Tags":["mine"]}` silently drops every tag already on
the incident, including ones set by other people. Both helpers read first;
a hand-written `icm-call PATCH` must too.

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
