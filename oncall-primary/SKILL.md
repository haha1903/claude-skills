---
name: oncall-primary
description: Use when the user is the Primary OCE on the Lionrock / Region Access & Quota rotation - e.g. "oncall primary", "/oncall-primary", "run the primary oncall duties", "what do I take to the IcM checkpoint". WORKS the pending-action queue rather than just reading it: investigates each family, comments on the incident, and assigns it an owner (the user himself when no other owner is identifiable), then covers the nine checkpoint items - Support / Feature Requests / AGC channels, bowloper mail, the ticket query, and the sub / parent / planned-quota / regional-plan / capacity-order error views. Asks only for an external transfer, mitigating a human-raised incident, or a production write.
summary: Primary OCE duties: work the IcM queue to owned, then the nine checkpoint items
---

# On-call Primary (Primary OCE daily duties)

The Primary OCE owns **incoming human requests and production data state**, and
**leads the daily IcM checkpoint meeting**. Test and deploy pipelines belong to
the Backup OCE (`oncall-backup` skill): if the user asks about those, point them
there rather than half-doing it here.

**All output is English** (it is read at the checkpoint and forwarded to the
team). Never put Chinese in the report.

## The duties

**1. Process active IcM tickets** (the daily on-call process).

**2. Organize and lead the daily IcM checkpoint meeting**, covering:

| # | Item | Source | Auto? |
|---|---|---|---|
| a | New posts to **Support** channel + **Feature Requests** channel | Teams | yes |
| b | Posts on **AGC Support (Internal)** | Teams | yes |
| c | Support emails to **bowloper@microsoft.com** - redirect to the Support channel where possible | Outlook | yes |
| d | All new + old tickets with progress (the saved query) | IcM | yes (same data as duty 1) |
| e | Sub requests in **Error** - "Active Sub Requests" | `external_table('SubRequest')` | yes |
| f | Parent requests in **Error** - "Error Parent Requests" | `external_table('Request')`, `Status == "CompletedWithError"` | yes |
| g | Planned quota requests in **Error** | `external_table('PlannedQuotaRequest')` | yes |
| h | Regional plans in **Error** - check the error message via Geneva log | `external_table('PlanRegion')` | yes |
| i | Capacity orders in **Failed** - "Capacity Order View" | `external_table('CapacityOrder')`, `Status == "Failed"` | yes |

Item i has two follow-ups:
- **i.i** Check the CCO board query for how many CCO tickets exist; if there is an
  issue, reach out to CCO or open an IcM. The query lives in a different ADO
  organisation (`CapacityRequest`, not `msazure`):
  <https://dev.azure.com/CapacityRequest/Quota/_queries/query-edit/?tempQueryId=92885eca-e260-4886-8c07-eac41d4ebfba>

  Still a manual step: it is a saved query in someone else's org and the collector does
  not read it. Report it as checked only if you actually opened it.
- **i.ii** A **newer version of the plan may already have a CCO ticket attached**;
  if so, the older version can be ignored. So before escalating a failed capacity
  order, check for a newer plan version.

## Step 1. Collect

One command, ~1-2min. Do NOT hand-run the individual az / kusto commands: the
collector has the channel ids, the exact `external_table` filters and the Geneva
drill-down already.

```bash
node "~/.claude/skills/oncall-brief/bin/collect.mjs" --scope=primary "$(TZ=Australia/Sydney date +%F)" > /tmp/oncall-primary.json
```

`--scope=primary` skips the Backup pipelines. Read
`~/.claude/skills/oncall-brief/reference.md` for the ids, the exact status
literals and the TODOs.

**All nine items collect, in both environments**, through iris's Agent365 facade with a
delegated token from the cache on the PVC. Verified: three channels and the mailbox, zero
errors.

Two things a/b/c were quietly getting wrong until 2026-08-22, both worth knowing because
neither produced an error -- they produced a plausible number:

- **`replyCount` does not exist** on a channel message, so "has anyone answered?" was always
  undefined and the report could only count posts.
- **Item c counted the personal inbox.** The mail tool reads `/me/messages` and cannot be
  aimed at a shared mailbox, so it was reporting Azure DevOps notifications as support mail.

Both are fixed, and the shapes below reflect the fix. The lesson generalises: a source that
returns a number is not necessarily returning YOUR number.

**Item c returns counts only, and that is deliberate.** The mailbox may be read to work
out what is happening; its contents must not be repeated. A support mailbox holds other
people's words and business detail, sent to a person rather than to a channel, so the
collector requests only `receivedDateTime` and `isRead` -- no subject or body is fetched
at all. **Report what the mail means, never what it says**: "four support mails, two
unanswered, redirect to the Support channel" is the shape. Anyone needing the words opens
Outlook.

`mail.atLeast` means the page limit was hit, so `threads7d` is a floor rather than a
count. Say "at least N". And check `mail.mailbox` names bowloper@ -- if it names something
else, the figure is not item c at all.

Shape:

- `icm` - `{count, portalCount, handledStillActive, allCount, reconciled, folder, groups, flagged}`.
  **`count` is not what the portal shows, and the gap is not small.** `count` excludes
  everything tagged `oncall-bot-handled`, which is what stops a drained family reappearing
  tomorrow -- but the tag is permanent while the incident is not. Measured 2026-08-21:
  `count` 42, `portalCount` 108, and **all 65 of the hidden ones still ACTIVE**, some tagged
  three weeks earlier.

  So **report both**, always, and lead with the portal number for the queue total:
  "108 open, 42 needing work, 65 previously triaged and still open". Reporting `count` alone
  is what made an earlier report say "By Monitor: 11" while the portal showed 48, and
  "CIS-Ev2 Bridge: clear" while it held an open incident. `handledStillActive` is the size
  of that gap; per-query it is on `groups[].portalCount`.

  If `handledStillActive` is large and growing, say so -- it means earlier passes tagged
  things they did not finish, and the tag is hiding them from every run since.
  **`reconciled: false` means the numbers do not add up** -- the sum of the families
  differs from the "Pending Action - All" query, so one has drifted. Report the total as
  suspect rather than as fact.
  Each incident carries `hitCount` (a burst versus N problems), `customerImpacting`,
  `acknowledged`, and **`oncallState`**: `new` means never triaged by us,
  `awaiting-decision` means a previous run already proposed something and is waiting on a
  human -- do NOT re-investigate those, and say they are waiting.
  Groups ARE the 5 saved queries under the `Pending Action` folder (By Monitor / CIS RP /
  CIS-Ev2 Bridge / Other / PlannedQuotas), each with its `queryId`, `queryUrl` for the
  heading, `assignees`, and `families` -- title sub-grouping, so a 36-incident query
  collapses to 5 categories, each with `hits` and a representative `sample.portalUrl`.
  **A group with `count: 0` is a result, not an absence**: that query was run and is
  clear, so say so rather than omitting it.
  `flagged` = Sev<=2 / customer-impacting / mine / unassigned, worst first, each with a
  `reason`. Covers duties 1 and d.
- `channels.{askForSupport,featureRequests,agcSupport}` - recent posts, each with
  **`answered`** and `replies`. Items a/b. **Report the unanswered ones**, not the post count:
  "8 posts" was never the question. `answered: undefined` means the reply lookup failed for
  that post, so say "could not check", never "unanswered".
  This used to be unanswerable: the collector read `replyCount`, which does not exist on these
  messages, so it was always undefined and every report could only say how many posts existed.
  Measured after the fix: 24 posts across the three channels, **4 unanswered** -- and
  `askForSupport` had a 100% reply rate, while the open ones in Feature Requests and AGC go
  back to 2026-07 and 2026-05.
- `mail` - counts for the **shared** mailbox, named in `mail.mailbox`. Item c.
  Until 2026-08-22 this silently counted the PERSONAL inbox (the mail tool reads `/me/messages`
  and cannot be aimed elsewhere), so a report of "at least 50 threads, 6 unread" was Azure
  DevOps notifications and newsletters. It now searches by participant: measured 46 threads,
  **0 unread** on bowloper@ for the same week. If `mail.mailbox` is not the address you expect,
  the number is not item c.
- `requestErrors.{subRequest,parentRequest,plannedQuotaRequest,planRegion,capacityOrder}`
  - each `{table, new24h, total, rows?, byRegion24h?}`. Items e-i.
- `errors` - any source that failed. Report as "could not collect: <reason>",
  never as green.

## Step 2. Read it correctly

### Report new-in-24h, not the historical total

Every error view carries both `new24h` and `total`. **`total` is historical** and
mostly noise at the checkpoint. Lead with `new24h` and its `rows` detail; mention
`total` only as context ("3 new, 412 total").

### A family is one investigation, not N

One root cause fanning out into 200 incidents is **one** line in the report.
Group by `families`, use the `sample` for the representative link, and explain in
one human sentence what the family means - the family name is only a short error
token, so use `sample.Title` plus `comment` to say what it actually is.

### There is no `comment` in the snapshot -- go and read the incident

The queue now comes from the team's live saved queries, which return incident state but
not the discussion. So a cause is never in the snapshot, and the title is not a cause
either: `[Region Access] Error occurred 500250:...@CheckAlreadyDoneError` names a symptom.

To explain a family, read one real incident (`icm-call GET`, or the portal link on
`sample.portalUrl`) and take the exception from its first DescriptionEntry. `hits` on the
family tells you whether it is a burst worth one investigation or several distinct
problems.

Never write a cause you did not read.

### Item h needs the Geneva error, not just the row

`planRegion` rows carry `genevaError:{rootCause,contributing}`, already drilled
from the Geneva log. That IS item h's "check error message via geneva log" - so
report `rootCause`, not just "N plans in Error".

### Item i - check for a newer plan version before escalating

Per i.ii, a failed capacity order whose plan has a newer version with a CCO
ticket attached can be ignored. Say which ones you ruled out that way.

**A query gotcha:** on `CapacityOrder`, do **not** project `ExpiryDate`. That
column makes the backend view return a single placeholder row `{'Id':'OneApiErrors'}`.
Any other column set is fine. The collector already avoids it; this matters only
if you hand-write a query.

## Step 3. Act on the queue — do not come back with a list of options

**The highest-priority thing this skill does is get every incident owned.** An unassigned
incident is nobody's, and a report saying "21 unassigned" has moved nothing. Finish the
whole pass before replying: investigate, tag, assign, and comment only where a comment earns
its place. The reply describes what was DONE, in the past tense.

**Do not end on a question.** Not "want me to dig into X or set up Y?", not "say the word".
If a family needs digging, dig it. If four checks in a row flagged the same cluster and
nobody has looked, that IS the signal to look, now. Ask only when something is genuinely
outside what you can decide -- see "When to actually ask" below.

### A comment is an outbound message. Most findings do not deserve one

**The default is to tag, not to comment.** `oncall-bot-handled` already says "we looked at
this"; that is what the tag is for, and it costs nobody anything. A comment is different in
kind: it is written on a ticket other people read, often a ticket someone else owns, it
cannot be recalled, and a low-confidence one actively **damages** their judgement. Someone
reading "probably an FRP problem" now has to work out whether to trust it, which is worse
than having found nothing there at all.

So a comment needs a reason. Exactly two qualify:

| Write a comment when | Because |
|---|---|
| You have a **concrete next action or fix** the owner could not get elsewhere | It saves them the work you already did |
| **A PR is open** for it, or the disposition is settled (confirmed transient with log evidence, definitively another team's with the evidence) | It records a decision, not a hunch |

Everything else -- a suspicion, a narrowed-down guess, "the cause is somewhere we cannot
see", a name you inferred rather than read -- goes to **your own Teams**, not onto the
incident. Tag it, and put the finding where only you will read it:

```bash
# pipe on stdin, so a multi-line finding with ids and links survives intact
printf '%s\n' "22x FRP cluster: InvalidRequestUri, one CIS job id 2516152542168115721.
Root cause inside CIS, not visible to us. Owner lingc. Tagged, wiki page written." \
  | ~/.claude/skills/o-teams-digest/bin/send-to-self.mjs -
```

`--html` if you want the portal links clickable. This is the same `sendToSelf` the outbound
guard redirects to, so it is the one destination that is never someone else's.

A real case, from the pass on 2026-08-21. 22 incidents owned by `lingc`, and the work done
on them was genuine: the wiki discriminator was confirmed, the inner code was read as
`InvalidRequestUri`, and all 22 shared one CIS job id, so it was one fault and not 22.
**That still did not earn a comment.** The conclusion was "the root cause is inside CIS,
which we cannot see" -- no fix, no PR, nothing actionable that `lingc` would not find on
opening the ticket. Correct handling was: tag all 22, note the finding in my own Teams, keep
the wiki page so the next run recognises it in seconds. What actually happened was 22
comments on another person's tickets saying, in effect, "we could not determine this".

The asymmetry to hold on to: **an untagged incident with no comment is a small loss** (the
next run repeats some work). **A speculative comment on someone else's ticket is an
unbounded one** -- it misleads a colleague, permanently, in a place you cannot edit.

### Never claim a comment you did not write

A run has already gone wrong this way: 20 incidents were assigned, the report said
"commented root cause + wiki ref, assigned, tagged", and the incidents had **no comment on
them at all**. Only the assign had happened. That is worse than skipping the comment,
because the report is then a false record and the next person trusts it.

So the order is fixed, and every step has output you can check:

```bash
icm-comment <id> "<the fix, or the settled disposition>"  # ONLY if it earns it, per above
icm-ack-many haichang <id> [<id> …]                       # UNOWNED ones only. prints {ok:[…], failed:[]}
icm-assign <id> <alias>                                    # only to hand it to someone else
icm-tag <id>                                               # last -- it hides the incident
```

The comment is first **when there is one**, because a comment after the tag is a comment on
something already hidden. But skipping it is the normal case: on most passes the sequence is
ack (if unowned), assign, tag, and the finding goes to your own Teams.

**Ack what you are taking on. Never ack someone else's incident.**

`icm-ack` sets `OwningContactAlias` to the ack contact, so acking is claiming. On an
unowned incident that is exactly right: it says a human has seen this, silences the paging,
and puts your name on it in one call. On an incident already owned by someone else it is
theft -- it takes the incident off their queue, notifies them of an owner change they did
not make, and the ack still reads as YOUR acknowledgement of work that is not yours.

So:

| The incident is | Do |
|---|---|
| unowned | **ack it** -- claims and silences it in one call |
| owned by you already | **ack it** if `AcknowledgementData.IsAcknowledged` is false |
| owned by someone else | **leave it alone.** Not the ack, not the owner. Their acknowledgement is theirs to give |

Measured on a real queue: all 36 pending incidents were already owned -- 24 by `lingc`, 5 by
`jtong`, the rest spread -- and none were acknowledged. The correct action there was to touch
none of them. A pass that acked all 36 would have moved every one onto the on-call's own
queue for the sake of a signal that was not theirs to send.

**Verifying an ack has a trap.** The top-level `AcknowledgeDate` and `AcknowledgedBy` are
ALWAYS null, even on a freshly acknowledged incident -- the real state is
`AcknowledgementData.IsAcknowledged`. Reading the top-level fields will tell you the ack
failed when it succeeded.

`icm-comment` prints `added comment to <id> (N chars)`. **If you did not see that line, the
comment did not happen** -- do not write "commented" in the report.

**`icm-comment-many` will lie to you if the ids arrive as one argument.** Passing them as a
shell variable produced `{"ok":["854157083 854157016 ..."], "failed":[]}` -- a single entry
holding the whole string. It reported success, wrote the comment to the FIRST id only, and
left 20 incidents untouched. Caught by spot-checking two of them.

So: **pipe the ids on stdin**, which is parsed per line, and check that `ok` has as many
entries as you had ids:

```bash
printf '%s\n' <id> <id> <id> | icm-comment-many "<text>" -
# ok: 21 | failed: 0     <- a count, not one long string
```

Then spot-check a couple with `icm-call GET "incidents(<id>)/DescriptionEntries"`. A bulk
write that silently covers one item is exactly the shape that produces a report claiming
work that did not happen.

One thing tagging silently costs you: the incident drops out of the next snapshot, so
whatever you worked out is gone unless it is written down somewhere. That somewhere is the
wiki page and your own Teams, not necessarily the incident -- see the comment rule above.
What must not happen is tagging with the finding recorded nowhere at all.

**Reading a comment back has a trap.** `GET incidents(<id>)/DescriptionEntries` works;
adding `$orderby=SubmitDate desc` makes IcM return an EMPTY list with no error, which reads
exactly like "the comment was never written". Query without `$orderby` and sort locally.

### Who to assign to: run the tool, do not work it out

**Do not reason about ownership from the title.** Run this first:

```bash
icm-route-by-history                 # suggested owner per family, read-only
icm-route-by-history --json          # to pipe into icm-assign-many
icm-route-by-history --owner <alias> # one person's active backlog instead of the queue
```

It reads who closed the same thing before and prints the histogram behind each
suggestion. Doing this by hand went wrong four separate ways in one pass, and every
wrong answer looked right -- the failure mode is an empty result, which reads as "this
family has no history" rather than as "the query was wrong". The rules, the exact
query, and each way it misleads are in the wiki:
**`concepts/icm-ownership-routing-by-history.md`** (`wiki-query` finds it). Read that
before overriding the tool.

Three things it will not decide for you:

| It says | Do |
|---|---|
| a settled owner | `icm-assign-many <alias> <id> …` -- one call per person, not per incident |
| `tie` (top alias leads by only 1) | assign to the top alias anyway; an owner who can re-route beats unowned |
| `no-history` | assign to `haichang`. Nothing closed has ever matched, so there is no answer to find |

**Verify the alias is still current.** The tool cannot know who has left, and a
departed colleague's alias still accepts an assign: one was holding 64 active
incidents, invisible to every pending run because they were owned. Off the on-call
roster is NOT the same as gone -- someone can be employed and simply not on rotation,
so **ask** rather than infer. Route a departed person's backlog by each family's own
history, not by "X left, so give it to Y".

Then three exclusions the routing table cannot see. Skip **Sev <= 2** (someone is
working it right now; Sev 2.5 is stored as `25`), skip anything **already owned by the
person history picked** (a no-op that still sends a notification), and skip anything
**owned by someone else** -- report the disagreement instead of moving it, same rule as
the ack. On a real pass these removed 53 of 134.

`icm-assign haichang` is not a failure state: a real person's queue, re-routable in one
click. **Unassigned is the only wrong answer.**

An EXTERNAL team, outside our IcM, is still **ask** -- a transfer crosses our boundary
and cannot be undone quietly.

### What may be done without asking

Taken from the source-based rule: how aggressive to be depends on who raised the incident.
A monitor-raised incident (it has a raising monitor id) is a system alert; a human-raised or
transferred-in one has a person behind it. **When the source is unclear, treat it as
human-raised.**

| Action | Monitor-raised | Human-raised / transferred in |
|---|---|---|
| Investigate | **do it** | **do it** |
| Comment a fix or a settled disposition | **do it** | **do it** |
| Comment a suspicion | **no** -- own Teams | **no** -- own Teams |
| Assign to an internal owner (incl. `haichang`) | **do it** | **do it** |
| Tag `oncall-bot-handled` | **do it** | **do it** |
| Write a root-cause wiki page | **do it** | **do it** |
| Resolve confirmed transient noise | do it, with log evidence | **ask** |
| Mitigate | do it, with log evidence | **ask** |
| Transfer to an external team | **ask** | **ask** |
| Open a fix PR | ask (`lionrock-fix-pr`) | ask |

**Never resolve an incident whose cause you do not know.** "It has not fired lately" is not
evidence: a quiet log window only means eliminated when paired with a fix that actually
shipped to the regions the incident covers.

**Resolve is not a direct transition.** `ResolveIncident` on an `Active` incident fails with
`cannot transition Active→Resolved` -- mitigate first, then resolve. The mitigate call
carries the root-cause text, so it doubles as the comment.

### When to actually ask

Four things, and they are all "a decision that is not mine":

1. **An external transfer** -- out of our IcM to another org.
2. **Mitigating or resolving something a human raised** -- a person is waiting on it.
3. **A production write** -- retrying a request, changing config (`lionrock-request-retry`).
4. **A genuine anomaly**: `reconciled: false` and the counts are far apart, a Sev 1, a
   customer-impacting incident with no owner anywhere, an auth failure that stops the pass.

Everything else: decide and do it. If you are unsure who owns something, that is not an
anomaly -- that is case 2 in the assign table, and the answer is `haichang`.

### Already-handled work

An incident whose `oncallState` is `awaiting-decision` has a proposal out and is waiting on
a person. **Do not re-investigate it.** Check this task's `./inbox/` for a reply naming it;
if one arrived, execute it, comment the outcome, then `icm-tag <id>` and
`icm-untag <id> oncall-bot-awaiting-decision`. If not, leave it and move on -- and say in
the report that it is still waiting, so it does not look forgotten.

### Making a finding stick: tag, wiki page, and a comment only if it earns one

Reporting a family and moving on means the next run investigates it again from scratch. Two
writes stop that, and a third is conditional.

**1. Tag it `oncall-bot-handled`.** This is the deduplication and the default record that we
looked: `pendingByFamily` excludes tagged incidents, so a family dealt with today does not
reappear tomorrow.

**2. Write the root cause to the `oncall` wiki**, if it is a cause worth recognising again.
This is where a finding belongs when it is not comment-worthy -- it survives, it is
searchable by the next run via `wiki-query`, and it is not written on someone else's ticket.

**3. Comment, only per the rule in "A comment is an outbound message"**: a concrete next
action or fix, or a settled disposition. A suspicion goes to your own Teams instead. When
there IS a comment, write it before the tag, since a comment after the tag lands on
something already hidden.

**The tag hides, it does not resolve, and that is a trap worth naming.** It is permanent
while the incident is not: 65 tagged incidents were found still ACTIVE, the oldest tagged
three weeks earlier, invisible to every run in between. So tag only what genuinely needs no
further action from us -- handed to the right owner, confirmed benign, or blocked on someone
else with that recorded. **Do not tag something merely because you looked at it.** If it
still needs work but not from you, leave it untagged and say who it is waiting on; the
`oncall-bot-awaiting-decision` tag exists for the case where a proposal is out.

### The root-cause page format

The **Discriminator is mandatory**. It is the field that earns the page its keep: without a
cheap way to confirm THIS incident is the same cause, the page invites assuming a match
rather than checking one, and an incident with the same signature but a different cause
gets the wrong disposition.

```markdown
---
type: root-cause
family: <error-family-slug>
signature: "<EventId + LoggerName + surface pattern>"
status: active | eliminated | mitigating | known-issue | triage-router
---
### Symptom
What the IcM looks like: EventId, title pattern, affected surface.

### Root cause
The actual cause. **If the cause is not visible to us** -- inside CIS or an FRP, behind a
portal Job Link, on a sovereign stamp -- say that plainly: "cause is in X, not in our
Kusto, hand to <team>". A family with several inner causes is a `triage-router`, not a
single invented cause.

### Discriminator
A CHEAP check confirming this incident is that cause. Two shapes:
- a log family: one Kusto query, with the query written out
- a mixed family: read the first DescriptionEntry and branch on the inner error code. The
  branch table IS the discriminator.

### Disposition
What to do once confirmed: resolve as transient / hand to <team> / retry via
`lionrock-request-retry` / open a PR (`lionrock-fix-pr`). One per branch, for a router.
```

Set `status: eliminated` when a fix has shipped and the discriminator shows the family is
gone; `mitigating` while a workaround holds pending a fix. A wiki that still calls a fixed
thing active sends the next person down a dead path.

**Never invent a cause to fill the page.** A page saying "cause is inside CIS, hand to
them, here is how to tell" is useful. A page with a plausible guess is worse than no page,
because `wiki-query` will find it and it will be believed.

## Step 4. Report what you DID

**Past tense.** By the time you write this, step 3 has happened: incidents are commented and
owned, families are dug or explicitly handed on. So the report says what was done, not what
could be done. "Assigned the 22-incident FRP cluster to haichang with the exception text" is
a report; "the FRP cluster needs an owner" is a to-do list you were supposed to action.

The only forward-looking lines are the ones genuinely waiting on someone else: an external
transfer you asked about, a Support question whose draft is with Hai, an
`awaiting-decision` incident still without a reply.

**One report that works both ways: skimmed on screen, and read aloud at the
checkpoint you are leading.** Not a scannable report with a spoken summary bolted
on. An earlier version of this skill did exactly that, a detail table plus a
separate "speakable summary", and it was the wrong shape twice over: it admitted
the report itself could not be read, and it made two things to keep in sync.

The two goals are the same goal, and **tables serve both** - they are the backbone
of this report, not something to avoid. A short table is the easiest thing there is
to skim, and it reads aloud perfectly well, because you say the cells and not the
separators: "Queue: forty-one, all owned. Channels: two questions, both answered."

What breaks aloud is not the table, it is **what gets stuffed into it**: a wide
table, a cell holding a paragraph, a stack trace, a column of raw ids. So keep the
table and keep the cells short.

### Table rules

- **Two or three columns.** Never more. Subject, status, and at most one detail.
- **A cell is a phrase**, six words or so. If a cell needs a sentence, it belongs
  in the line under the table, not in the cell.
- **Same rows every day, same order.** A reader learns where to look, and you can
  read down the column without thinking.
- **The status column carries the verdict**, so reading only that column tells the
  whole story: "green, green, red, green".
- **No id columns.** Ids are unreadable aloud and useless on screen; link the
  subject instead. The checklist letter is not an id -- it is how the row is matched
  against the OneNote page, and it stays.

### Shape

**The checklist letters lead every row.** This report is read next to the OneNote page,
item by item, and a row labelled "Support + Feature Requests" cannot be matched against
"a" without the reader doing the mapping in their head. Use the letter the page uses, in
the page's order, and include the ones that are clear -- "e ✅ none" is the answer to e,
and omitting it makes the reader wonder whether it was checked.

```markdown
OnCall Primary, <date>

<One line verdict: queue size, anything unowned or above Sev 3, the dominant theme.>

**1 · Incident queue — <count> (<n> unassigned)**

| Query | Count | Top families |
|---|---|---|
| [By Monitor](queryUrl) | <n> | <"22× InvalidOperationException · 9× …" on one line> |
| [CIS RP](queryUrl) | <n> | <same> |
| [CIS-Ev2 Bridge](queryUrl) | <n> | <same> |
| [Other](queryUrl) | <n> | <or "clear"> |
| [PlannedQuotas](queryUrl) | <n> | <or "clear"> |

<A blockquote only for the dominant cluster: what it is, its known root cause if the
 wiki has one, and where it stands. One line.>

**2 · Checklist**

| # | Item | Status |
|---|---|---|
| a | Support + Feature Requests | <what came in, what still needs an answer> |
| b | AGC Support (Internal) | <same> |
| c | bowloper mail | <counts and meaning only — never the contents> |
| d | Ticket query | <covered by the queue above; say so rather than repeating it> |
| e | Sub requests in Error | ✅ none / 🔴 <n> new — <what and where> |
| f | Parent requests in Error | <same> |
| g | Planned quota in Error | <same> |
| h | Regional plans in Error | <same, and the Geneva rootCause when non-zero> |
| i | Capacity orders Failed | <same; note i.i CCO query and i.ii newer-version check> |

**Acted**

| What | Action |
|---|---|
| <family or incident> | <commented / assigned to whom / tagged / wiki page written> |

**Waiting on someone**

<Only what genuinely is: a draft with Hai, an external transfer you asked about, an
 awaiting-decision incident with no reply yet. Nothing here is a good outcome, not a gap.>
```

Mark cells so the eye finds trouble without reading: **🔴** for something failing, **✅**
for clear, **⚠️** for checked-but-odd, **📋** for a manual step you did not do. Bold the
letter of any row needing attention.

`reconciled: false` goes on the "1 ·" heading, not buried: the counts do not add up, so
the total is an estimate.

Read the whole thing aloud and it should still work: "queue, fifty-six, twenty-one
unassigned, mostly the PlannedQuota FRP cluster. a, four support questions, two answered.
e, two new sub-request errors." Which is what you would have said anyway.

### Links go on words, never on their own

A link should disappear when spoken. Put it on the noun you were going to say
anyway:

- good: "the [FulfillPlannedQuota cluster](queryUrl) is still the bulk of it"
- bad: "FulfillPlannedQuota: 26. Query: https://portal.microsofticm.com/..."

Link the shared query, a request you are singling out, a plan you are calling out.
**Do not link every incident** - a paragraph of links is unreadable, and the query
link already gets the listener to all of them.

### A worked example

Built from a real snapshot, so the numbers are the shape you actually get. Read it aloud
once; it should sound like something you would say.

```markdown
OnCall Primary, 21 Aug

Fifty-six pending, 21 unassigned, one Sev 2 still unowned. Mostly the PlannedQuota FRP cluster.

**1 · Incident queue — 56 (21 unassigned)**

| Query | Count | Top families |
|---|---|---|
| [By Monitor](<queryUrl>) | 19 | 15 families, none dominant |
| [CIS RP](<queryUrl>) | 36 | 22× [InvalidOperationException](<portalUrl>) · 9× CheckAlreadyDoneError |
| [CIS-Ev2 Bridge](<queryUrl>) | 1 | InternallyReady |
| [Other](<queryUrl>) | 0 | clear |
| [PlannedQuotas](<queryUrl>) | 0 | clear |

> The 22× [PlannedQuota FRP InvalidOperationException](<portalUrl>) has no wiki page — the one cluster with no known cause, and none of them owned. **[Sev 2](<portalUrl>): AzRel Red Flag, MountainPass SR15**, still unowned; the only thing above Sev 3.

**2 · Checklist**

| # | Item | Status |
|---|---|---|
| a | Support + Feature Requests | ⚠️ 2 unanswered of 16 — oldest from July |
| b | AGC Support (Internal) | ⚠️ 2 unanswered of 8 — usnat claim, GovSG blueprint |
| c | bowloper mail | ✅ 46 threads in 7d, 0 unread |
| d | Ticket query | ✅ same data as the queue above |
| **e** | Sub requests in Error | 🔴 2 new — BatchQuota, InternalVm |
| f | Parent requests in Error | ✅ none |
| **g** | Planned quota in Error | 🔴 1 — [Saudi Arabia East, GA blueprint](<requestUrl>) |
| h | Regional plans in Error | ✅ none |
| i | Capacity orders Failed | ✅ none new; i.i CCO query not opened (📋 manual), i.ii n/a |

**Acted**

| What | Action |
|---|---|
| 22× PlannedQuota FRP `InvalidOperationException` | tagged handled, [wrote the wiki page](<wikiUrl>) — cause is inside CIS, so **no comment**: nothing actionable to tell `lingc`. Detail is in your Teams |
| 9× CheckAlreadyDoneError | known cause (wiki), assigned to `lingc` who owns the others, tagged |
| [Sev 2 AzRel Red Flag](<portalUrl>) | assigned to `haichang`, tagged — monitor-raised, no owning team identifiable |
| [Saudi Arabia East plan](<requestUrl>) | commented: GenevaActions 400149 on `publicsfw` plus no associated capacity order, both read from the log — a settled disposition, so it earns one |

**Waiting on someone**

Five Support questions: drafts are in your chat, they need your eye before they go to the channel. The CIS-Ev2 `InternallyReady` incident would be an external transfer, so it is still ours — say the word.
```

Note what is absent: no incident ids in prose, no historical totals beside the new
counts, no mention of Kusto or which tool ran. The letter plus the marker carries it, and
a cell is six words wherever it can be.

Note also what is present: **e, f, g, h, i all appear, including the clear ones.** A
missing row reads as "not checked", which is the one thing this report must never imply.

## What needs asking, and what does not

An earlier version of this section listed commenting, tagging and assigning as writes
needing confirmation. That was wrong for this duty: it turned every run into a list of
proposals, and the queue stayed unassigned while the report grew longer. See "Act on the
queue" above for the matrix. The short version:

**Do it, no asking:** collect and report, investigate, assign to an internal owner
(`haichang` when the owner is unclear), tag `oncall-bot-handled` or
`oncall-bot-awaiting-decision`, write a root-cause page, send a finding to your own Teams,
and comment when the comment earns it (a fix, a settled disposition).

**Not a matter of asking -- just do not:** comment a suspicion onto an incident. There is no
version of that which needs permission, because the alternative is strictly better: tag it
and tell yourself.

**Ask first**, because each one leaves our boundary or touches production:

- **transferring an IcM to an external team** -- out of our tenant, not quietly undone
- **mitigating or resolving a HUMAN-raised incident** -- someone is waiting on it. Monitor
  raised, with log evidence, is fine to do
- **retrying a request** (`lionrock-request-retry`) -- a production write
- **opening an IcM** for a CCO issue
- **changing code and opening a PR** (`lionrock-fix-pr`) -- a convincing diagnosis is not
  authorisation; the user has to ask for that specific defect

**A reply to anywhere other than the conversation you are in is a DRAFT.** A Support-channel
post, an AGC post, a bowloper email: write the finished English text, name the destination,
leave the pasting to Hai. The bridge enforces this rather than trusting anyone to remember
-- `sendToChannel` / `sendToChat` / `sendToUser` are redirected to his own chat with a
banner. See `oncall-reply`.

Answering a *question* someone asked is the `oncall-reply` skill.

## What you can reach when something needs explaining

The collector gives you counts and rows. Explaining them takes more, and you have
it. **These are yours to use directly; do not wait for a playbook to grant them.**
`WIKI_ROOT` is an environment variable (`/data/Projects/wiki` in the container,
`~/Projects/wiki` on a dev box) and every wiki under it is readable regardless of
what the current task's AGENTS.md happens to list.

| To find out | Use |
|---|---|
| is this a known root cause | **`wiki-query`** against `oncall` (root-cause pages, `searchRaw: true`) |
| how the feature is meant to work | **`wiki-query`** against `s360-docs` |
| why a specific request failed | **`kusto-query`** against `agboa.westus2` / `lionrock` / `Log` |
| the full detail of one incident | **`icm`** (`icm-call GET`) |
| where in the code it breaks | **`icm-investigate`** |
| whether a fix is submittable, and how | **`lionrock-fix-pr`** -- only once the user asks for it |

An error view with a non-zero `new24h` and no explanation is half a report. At
minimum check the `oncall` wiki for the family before presenting it as new.

**Where a finding should land.** For anything red, aim to end on one of four, and
say which:

1. **known root cause** -- the `oncall` wiki has it; link the page
2. **external** -- another team owns it; name them, and the ticket if there is one
3. **fixable here** -- you can point at the code and the real error. Say what you
   would change and offer it; do NOT start (see `lionrock-fix-pr`)
4. **not yet understood** -- say that plainly, with what you ruled out

Four is a legitimate answer and better than a guess dressed as a cause. What is not
acceptable is a count with nothing after it.

## Who is on call

`icm.oncallRoster(67250, ...)` answers it (67250 = Region Access & Quota). The
endpoint returns **every timezone**, which is noise for this team, so filter to
the Sydney day shift:

```js
const weeks = await icm.oncallRoster(67250, {
  days: 14, timeZone: "Australia/Sydney",
  daytime: { fromHour: 9, toHour: 18 },
});
// -> [{ weekStart, weekEnd, primary: [{alias, name, hours}], secondary: [...] }]
```

Without `daytime` the current week lists four primaries and four secondaries
(follow-the-sun); with it, one of each, which is what someone asking "who is on
call" means. Weeks run oldest to newest and start Friday, so the **last** entry is
the current rotation. `primary[0]` / `secondary[0]` are the highest-hours holders.

## Never

- **write "commented" for an incident where `icm-comment` did not print its confirmation**
  -- a report that claims work not done is worse than one that admits a gap
- **ack an incident that already belongs to someone else** -- acking claims it, so that
  takes it off their queue and signs their acknowledgement with your name
- **comment a suspicion onto an incident** -- especially one someone else owns. "Probably an
  FRP problem" makes a colleague weigh whether to trust you, which is worse than silence.
  Tag it and send the finding to your own Teams
- **end the run with a question when you could have acted** -- if a family needs digging,
  dig it; the reply says what was done
- **leave an incident unassigned** -- when the owner is unclear it goes to `haichang`
- resolve an incident whose cause you do not know ("has not fired lately" is not evidence)
- transfer to an external team, or mitigate a human-raised incident, without asking
- report a `total` as if it were new activity
- **report `count` as the queue size without `portalCount`** -- they differed by 66 on the
  day this was found, and only the portal number matches what the team sees
- **tag something as handled that still needs work** -- the tag is permanent and hides it
  from every later run
- present the queue total as solid when `reconciled` is false
- omit a family whose count is 0 -- that query was run and is clear, which is a result
- re-investigate an incident whose `oncallState` is `awaiting-decision`
- state a cause taken from a title: the snapshot has no comment, so read the incident
- tag `oncall-bot-handled` with the finding recorded NOWHERE -- the wiki page or your own
  Teams is enough; the incident itself is only for a fix or a settled disposition
- infer an IcM root cause from its title instead of reading `comment` / the real
  error
- report a collector error as a pass - say "could not collect: <reason>"
- claim i.i was checked without opening the CCO query (it is manual; the link is above)
- put mail subjects, senders or bodies in the report -- item c is counts and meaning only
- escalate a failed capacity order without checking for a newer plan version
- present a count with no explanation when the wiki or the logs could give one
- name every timezone's on-call when asked who is on call - filter to Sydney

## Related

`oncall-backup` (the other half of the rotation), `oncall-brief` (both halves
plus the full report and the Teams send), `oncall-reply` (answering questions),
`icm` / `icm-query` / `icm-investigate` (acting on one incident),
`oncall-summary` (the weekly write-up).
