---
name: icm
description: Use when the user wants to read or act on a Microsoft IcM incident programmatically — get incident details, mitigate, acknowledge, resolve, assign to a person, update fields (severity/title/etc), transfer to a team, add a discussion comment, or look up incident metadata from an icm.ad.msft.net / portal.microsofticm.com URL or incident ID.
summary: Read or act on one IcM incident: details, comment, tag, mitigate, resolve
handles: [Internal.Noise, Internal.ExternalFault]
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
| `icm-assign ID ALIAS` | Assign to an individual **and acknowledge as them** (both states; verifies both). `ALIAS=""` unassigns. |
| `icm-assign-many ALIAS ID [ID …]` | Bulk-assign to one person **and acknowledge as them**; concurrent, per-incident verify of owner AND ack. `ALIAS -` reads ids from stdin. |
| `icm-ack-many CONTACT ID [ID …]` | Bulk-acknowledge **as one person, which also assigns them all to that person**. Use to CLAIM work. `CONTACT -` reads ids from stdin. |
| `icm-ack-as-owner ID [ID …]` | Acknowledge each as **its own current owner**, leaving ownership alone. For repairing assigned-but-unacked incidents. Skips unowned ones rather than claiming them. |
| `icm-tag ID [--family SIG] [--action WHAT]` | Mark handled in the **`Lionrock_Bot` custom field** (ours alone, structured, filterable). `--keyword KW` uses the legacy `Keywords` path, still needed for the awaiting marker. See "Three fields, three purposes" below. |
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

# Assign to a person: sets OwningContactAlias AND acknowledges as them
icm-assign 800736577 lingc
# NOT equivalent -- the raw PATCH sets the owner and leaves it UNACKNOWLEDGED, so it keeps
# paging and still reads as untriaged. Use it only to unassign.
icm-call PATCH 'incidents(800736577)' '{"OwningContactAlias":""}'

# Bulk assign / ack (client-side concurrency — IcM has NO $batch endpoint)
icm-route-by-history                                # FIRST: who does history say owns each family?
icm-assign-many lingc 828738586 828738619 828738701

# ACK SETS THE OWNER to whatever alias you pass. Measured: owner=haichang, ack as
# lingc -> owner becomes lingc. So the alias is not a signature, it is an assignment.
icm-ack-many haichang 827735814 827735820          # claims them for haichang
icm-ack-many lingc 828738586                        # acks AND assigns to lingc
# Two consequences, both learned the hard way:
#   1. Acking every unowned incident is not triaging them. That is how 20 sovereign-cloud
#      mirrors ended up under one person -- the work lives in another IcM instance, so
#      claiming them moved them onto his queue and achieved nothing else.
#   2. Do NOT use icm-ack-many to acknowledge incidents that already have owners: one
#      alias for a mixed batch moves them all onto that person's queue. Use this instead,
#      which acks each as ITS OWN owner and skips unowned ones:
icm-ack-as-owner 854705420 855325468               # ownership untouched, ack filled in
# 37 assigned-but-unacked incidents were repaired this way; one shared alias would have
# pulled all 37 onto a single queue.

# Mark handled. Goes to the Lionrock_Bot custom field, and records the judgement rather
# than just the fact: WHEN, WHICH family, WHAT was done.
icm-tag 854162342 --family '500250@CheckAlreadyDoneError' --action 'assigned:lingc'
icm-tag 854162342                                   # timestamp only, when there is no detail yet

# The awaiting marker still lives in Keywords, because it has the opposite snapshot
# semantics: it must NOT hide the incident, only flag it as waiting on a person.
icm-tag 800736577 --keyword oncall-bot-awaiting-decision
icm-untag 800736577 oncall-bot-awaiting-decision   # clear it once the decision is executed

# Program tags live in Tags — a third field again, and the one AzRF dashboards read.
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

**Assign does NOT acknowledge, and ack is not a signature.** They are separate states and
each needs its own call. `AcknowledgeIncident` writes `OwningContactAlias` to whatever
alias you pass, so:

- to ack something you are taking on, pass **your** alias — that claims it;
- to ack an **already-assigned** incident without stealing it, pass its **current owner**.

Measured: `owner=haichang`, ack as `lingc`, and the owner becomes `lingc`. 37 incidents
were repaired by passing each one's existing owner; passing a single alias for the batch
would have pulled all 37 onto one queue.

### Do not verify a write with a list query

`listByFilter("... and State eq 'Active'")` **omitted an incident whose own `Status` was
`Active`** — 854705420, owner set, returned by a direct GET and absent from the list. The
same face separately reported 251 unowned incidents where a per-incident read found none.

So a list query is fine for finding candidates and **worthless as proof**. Three audits
built on one reported "0 remaining" while 37 were in fact unacked, and the wrong answer
was the confident-looking one. Verify by GETting the ids you wrote to:

```bash
icm-call GET 'incidents(<id>)'   # then read AcknowledgementData.IsAcknowledged
```

Also: `AcknowledgeDate` and `AcknowledgedBy` at the top level are **always null**, even on
an acknowledged incident. The real state is `AcknowledgementData.IsAcknowledged`. Reading
the top-level fields reports every incident as unacked.

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

**`Tags` PATCH replaces the whole collection**, so it is always
read-modify-write. `PATCH {"Tags":["mine"]}` silently drops every tag already on
the incident, including ones set by other people. Both helpers read first;
a hand-written `icm-call PATCH` must too.

### Three fields, three purposes

| Field | Shape | Who writes it | Ours to use for |
|---|---|---|---|
| **`Lionrock_Bot`** (custom field, id 51090) | long string | **only us** | the handled marker. `icm-tag` |
| `Keywords` | `Edm.String`, `;`-joined | **shared** — 254 `NotPortalAlertSource`, 73 `blocked`, 30 `Triaged` against 48 of ours, measured | the awaiting marker only. `icm-tag --keyword` / `icm-untag` |
| `Tags` | `Collection(Edm.String)` | shared with automation (`JobSeverity=`, `IncidentEscalationPolicy=`) | program tags AzRF reads. `icm-set-tag` / `icm-unset-tag` |

**The handled marker moved off `Keywords`** because we are not its only writer, and marking
there is a read-modify-write of a string a colleague's automation may be editing at the same
moment. `blocked` also appearing as `Blocked` is what several independent writers look like.

The custom field is also structured, which `Keywords` could not be:

```
handled=2026-08-24T09:20Z family=500250@CheckAlreadyDoneError action=assigned:lingc
```

so the portal shows the judgement, not just that something touched the incident. Excluding
handled incidents is server-side:

```
not CustomFields/any(a: a/CustomFieldId eq 51090 and a/StringValue ne null)
```

**The `Keywords` clause is still applied alongside it** and must stay: 48 ACTIVE incidents
were tagged before the move, and dropping it flushes them back into the queue looking
untriaged. Check that no active incident carries the keyword before removing it — do not
assume the backlog has drained.

Two things about custom fields that cost a wrong answer each, both in
`iris/docs/CAPABILITIES.md`: the PATCH accepts `BigString` and rejects the `Textarea` that
`GetEditableProperty` advertises, and a long-string field CAN be filtered even though
`customFields.md` says it cannot. A value also **cannot be cleared**, only replaced.

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
