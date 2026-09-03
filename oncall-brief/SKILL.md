---
name: oncall-brief
description: Use when the user (on the Lionrock / Region Access & Quota on-call rotation) wants a daily on-call inspection brief — e.g. "oncall brief", "/oncall-brief", "collect today's on-call status". Walks the team's OneNote daily checklist, auto-collects every reachable source (IcM, ADO pipelines, Lionrock Geneva log, support mail/Teams), writes an English report to Obsidian + ~/Tasks/Scrum/, and after user review posts it to the team Teams meeting chat.
summary: Both halves of the rotation in one daily report
---

# OnCall Daily Brief

Generate a daily on-call inspection report for the Lionrock / Region Access &
Quota rotation, following the team's OneNote "On-Call duties" checklist.

**All output is English** (the report is posted to a Teams chat — outbound
messages are always English). Never put Chinese in the report or the files.

`reference.md` holds the verbatim checklist, the item→source table, every
hard-coded id/link, and all TODOs. Read it at the start of every run.

## Window

- Date = today in Sydney (`TZ=Australia/Sydney date +%F`), or the `YYYY-MM-DD`
  the user passed as an argument.
- "Today's status" = current state of each source (active IcM, latest pipeline
  runs, errors in the last ~24h). Not a historical range.

## Steps

### 1. Collect — run the collector, don't hand-run commands

**Run ONE script and read its JSON. Do NOT re-derive or hand-run the individual
az / kusto / node commands** — they are all fixed inside the collector, which runs
them in parallel (~15-20s) and returns a single structured blob. This keeps the
run fast and identical every day.

```bash
node ~/.claude/skills/oncall-brief/bin/collect.mjs "$(TZ=Australia/Sydney date +%F)" > /tmp/oncall-collect.json
```

Then read `/tmp/oncall-collect.json`. Shape:
- `icm` — `{count, groups:[…], flagged:[…]}`. **Groups are the 5 IcM "Pending Action"
  shared queries** (By Monitor / CIS RP / CIS-Ev2 Bridge / PlannedQuotas / Other),
  classified by MonitorId + OwningTeamId (By Monitor wins first). Each group:
  `{query, count, queryUrl, assignees:{alias:count}, families:[{family,count,unassigned,sample:{IncidentId,Title,Severity,OwningTeamName,OwningContactAlias,NextActionTime,portalUrl,comment}}]}`.
  `queryUrl` is the shared-query link → put it on the bucket heading. **`sample.Title`**
  is the full incident title (the family name is only its short error-type token —
  use the Title + `comment` to explain WHAT the family means, one human sentence
  per family). `comment` prefers an incident carrying a real diagnosis over the
  "Incident created" / "Acknowledging incident" boilerplate. `families` is
  the title/monitor sub-grouping (so a ~100 bucket collapses to categories); each
  family's `sample` is a representative incident with `portalUrl`. `assignees` is
  the who-owns tally. `flagged` = Sev≤2 / owned by haichang / **unassigned** / **overdue**
  (each has a `reason` + `overdue` bool). (item 1 / c)
- `pipelines.rolling|plannedQuotaArm|releaseIncremental` — each `{item, name, defId, pipelineUrl, latest, runs, lastCompleted, ev2RolloutUrl?, failedRun?, inProgressRollout?}`.
  - **`ev2RolloutUrl`**: the run's EV2 rollout portal link (`ra.ev2portal.azure.net/...`),
    present whether the run **succeeded or failed** — always surface it next to the
    pipeline (the on-call wants the rollout link regardless of outcome).
  - `failedRun` (if a run failed) → `{num, runUrl, failedTasks:[{name, logFailures:[…named tests + assertions]}]}`, already drilled + cleaned. Summarize logFailures into ROOT CAUSES (group asserts/timeouts), don't just list raw lines.
  - **`inProgressRollout` (CRITICAL)**: present when the latest run is still
    `inProgress` and stuck on an EV2 rollout. Holds the rollout's **real EV2 status**
    (`{status, failedActions:[{name,step,errorCode,errorReason}], runUrl, portalUrl}`).
    A run can sit `inProgress` for **up to 7 days** on a failed rollout — the ADO run
    never flips to `failed`, so "last completed run succeeded" is a FALSE all-clear.
    Rule: if `inProgressRollout.status == "Failed"` or `failedActions` non-empty →
    **report it as a failure** (with the errorReason), even though ADO shows inProgress.
    If `status == "Running"` → it's genuinely in flight; report on `lastCompleted`
    but note "latest run's EV2 rollout still in progress". `lastCompleted` = the run
    to trust when the latest is in flight. (items d/f/g)
- `pipelines.ev2` — `{item:e, releaseUrl, latestRelease, environments:[{name,status}], failures?}`.
  `rejected`/`failed`/`partiallySucceeded` env = attention. When not clean, **`failures`**
  is drilled: `[{env, task, issues:[…], logFailures:[named tests + asserts]}]`. **Report
  the real cause from `failures`, not just "rejected".** Item e is a UAT *test* release —
  a rejection is usually a failing test (e.g. an `Ev2Extension` test asserting
  `RolloutStatus.Succeeded` but getting `Failed`, with the failing `rolloutID` in the
  log line), NOT necessarily an infra redeploy. Give the release link + the failing
  test name + the assert. (item e = Daily UAT)
- `requestErrors.{subRequest,parentRequest,plannedQuotaRequest,planRegion,capacityOrder}` —
  each `{item, table, new24h, total, rows?, byRegion24h?}`. **Non-zero buckets include
  `rows`** (the actual 24h error records) — each row has the key fields + a link:
  `requestUrl` (`/quota/requests/<id>`) for sub/parent/planned-quota, `planUrl`
  (`/quota/plans/services/<ServiceTreeId>/<Blueprint>/editor`) for planRegion.
  **planRegion rows also carry `genevaError:{rootCause,contributing}`** — the error
  message drilled from the Geneva log (item k's "check error message via geneva log").
  Report **new24h** with the row detail (totals are historical). (items h/i/j/k/l)
- `mail` — bowloper@ recent threads `[{received,from,subject}]`. (item b)
- `channels.{askForSupport,featureRequests,agcSupport}` — recent posts `[{time,from,text}]`. (items a/m)
- `errors` — any source that failed (per-source; the run never aborts). Note these in the report as "could not collect".

The collector mirrors the **BET scrum skill** logic (same pending-action KQL,
same pipeline ids, EV2 release drill). If you need to **act on** a single IcM
(read full detail / mitigate / ack / resolve), that is a separate manual step via
the **`icm` skill** (`icm-call` / `icm-mitigate`, Betbot WIC) — the collector only
lists/aggregates, it never mutates.

Legacy note (only if collect.mjs is unavailable): the raw per-source commands are
in `reference.md`. Prefer the collector.

**Manual items the collector does NOT cover** (report under their checklist item):
- item l follow-up — CCO board query for failed Capacity Orders (link still TODO).

The collector already records per-source failures in `errors` and never aborts;
surface any as "could not collect: <reason>" under the relevant item.

### 2. Generate the report (English)

**One report, skimmed on screen and read aloud at the checkpoint.** Not a table
for looking at plus a separate summary for saying. This skill used to emit both,
and that was the wrong shape twice over: it conceded the report itself could not
be read, and it made two things to keep in sync.

Those two goals are the same goal, and **tables serve both** — they are the
backbone. A short table is the easiest thing to skim, and it reads aloud fine
because you say the cells, not the separators: "Queue, forty-one, all owned.
Rolling Test, red, four days." What breaks aloud is not the table, it is what gets
stuffed into it.

### Table rules

- **Two columns.** Subject and verdict. Three only if the third is a phrase.
- **A cell is a phrase**, six words or so. Longer goes in a line under the table.
- **Same rows every day, same order**, so reading down the verdict column tells the
  whole story and a missing row means something was skipped.
- **No id columns, no build numbers, no assertions, no totals** beside the new
  counts. "four days running" is the readable form of four run ids.
- **One marker at most per row** (🔴 for red). Emoji everywhere is emoji nowhere.

### Shape

Two short tables and a few lines. Aim for a minute, whichever way it is consumed.

```markdown
OnCall Brief, <date>

<One line verdict: queue size, whether anything is unowned or overdue, what is red.>

| Area | Status |
|---|---|
| Incident queue | <count, owned/unowned, top cause as a phrase> |
| Support + Feature Requests | <what came in, what needs an answer> |
| AGC Support | <same, or why unavailable> |
| bowloper mail | <same> |
| Sub / parent / quota errors | <new in 24h, or "none"> |
| Regional plans | <new + Geneva cause as a phrase, or "none"> |
| Capacity orders | <new, or "none"> |

| Pipeline | Status |
|---|---|
| [Rolling Test](<url>) | <verdict + how long> |
| [Daily UAT](<url>) | <verdict> |
| [Planned Quota ARM](<url>) | <verdict> |
| [Release Incremental](<url>) | <verdict> |
| [WebJobs](https://portal.azure.com/#@microsoft.onmicrosoft.com/resource/subscriptions/c9e275b8-def5-4853-b8e3-47b4255228cc/resourceGroups/lionrock-uat/providers/Microsoft.Web/sites/lionrock-webjob-uat/webJobs) | <verdict: what is failing, and for how long> |

<One short line per red row: what is broken in plain words, what you did, with the
 PR or bug linked. Skip anything the tables already say.>

<Known ongoing: one line per item carried forward, only while still true.>

<Only if something needs a person: one line saying what and who.>
```

**The full incident list lives in the file, not in the report.** The team did ask
(scrum decision) to be able to see every raw incident, and that still holds — but a
122-row dump defeats both reading and skimming, so it goes at the end of the local
`.md` from step 3, under a `## Full incident list` heading, grouped into the same 5
buckets the collector uses. The report above stays the readable part and links the
queries; anyone who wants the rows opens the file or the query.

**Links go on words, never on their own.** A link should disappear when spoken: put
it on the noun you were going to say anyway.

- good: "the [planned-quota cluster](queryUrl) is most of it"
- bad: "FulfillPlannedQuota: 26. Query: https://portal.microsofticm.com/..."

Link the shared query, the pipeline, a request or plan you single out, a PR or bug.
**Do not link every incident** in the report — that is what the file is for. Never
a bare id, never a naked URL.

### 3. Persist (both, immediately — don't wait for review)

- **Obsidian**: append to `journals/YYYY-MM-DD.md` (hyphen-separated) under a top block
  `- [[OnCall]] daily brief #oncall` (keep the `#oncall` tag; nest the sections
  under it). Obsidian vault root:
  `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes`.
  Do not commit.
- **Local**: write `~/Tasks/Scrum/OnCall_YYYY-MM-DD.md` — the report, then the
  `## Full incident list` section (every incident, grouped by the 5 buckets). This
  file is where the raw rows live, which is what keeps the report itself readable.

### 4. Send to the user's Notes to self

Send the report to the user's **Notes to self** (Teams `48:notes`). This is a
self-send, not an outbound message, so **no confirmation gate** — do it as part
of the run. Build an HTML body (Teams ignores markdown; use `<b>`, `<a href>`, and
real `<table>` for the two tables — they are the backbone of the report, so they
must render as tables and not as bullets). Send the report exactly as written: the
full incident list stays in the local `.md` and never goes in the message. Then:

```bash
cat /tmp/oncall-brief.html | node ~/.claude/skills/o-teams-digest/bin/send-to-self.mjs --html -
```

Use `send-to-self.mjs`, NOT `send-to-user.mjs` with your own UPN (that fails —
"OneOnOne chat requires 2 members"). The skill does **not** post to the team
meeting chat — the user reviews it in Notes to self and forwards it to the team
by hand. If the send fails, tell the user and leave the two files.

### 5. Show

Also print the report inline in the conversation so the user can read/tweak it
immediately. If they edit, keep the two files in sync.

## Notes

- Outbound-English is mandatory: the report, the files, and the Teams message are
  all English even though the user speaks Chinese.
- No cron / unattended runs — manual only.
- Filling a TODO in `reference.md` (pipeline id, Lionrock DB table, Teams channel
  id) automatically upgrades that item from 📋 Manual to 🔴 auto-pulled next run.
- Related skills: `icm-query`, `kusto-query`, `geneva-monitor`, `o-find-mail`,
  `o-teams-digest`.
