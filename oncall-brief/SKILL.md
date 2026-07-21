---
name: oncall-brief
description: Use when the user (on the Lionrock / Region Access & Quota on-call rotation) wants a daily on-call inspection brief — e.g. "oncall brief", "/oncall-brief", "collect today's on-call status". Walks the team's OneNote daily checklist, auto-collects every reachable source (IcM, ADO pipelines, Lionrock Geneva log, support mail/Teams), writes an English report to Obsidian + ~/Tasks/Scrum/, and after user review posts it to the team Teams meeting chat.
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
- item n — WebJobs status `lionrock-webjob-uat` (needs SAW) — user skips for now.
- item l follow-up — CCO board query for failed Capacity Orders (link still TODO).

The collector already records per-source failures in `errors` and never aborts;
surface any as "could not collect: <reason>" under the relevant item.

### 2. Generate the report (English)

**Table-first, scannable layout.** The report is read at a live checkpoint, so it
must be skimmable in seconds: use TABLES for anything with rows (metrics,
pipelines, checklist, IcM lists) — not walls of bullets. Emit these sections in
this exact order:

```
# OnCall Daily Brief — YYYY-MM-DD

## 📊 At a glance
<A single 2-col table (Area | Status) — the whole day in ~8 rows. Include:
 Active IcM count (+ Sev note); Triage result (e.g. "✅ 0 unassigned (was N →
 X resolved · Y to me · Z to lingc)"); each pipeline d/e/f/g as 🔴/✅ one-liner;
 Request errors new/24h (SubReq/PlannedQuota/Parent/Plan/CapOrder); Dominant theme.>

## 🎤 Speakable summary (read this at the checkpoint)
<2-4 short spoken-English paragraphs the on-call reads aloud. Lead with the IcM
 count + the dominant theme, then the triage result, then pipeline red/green,
 then "nothing overdue / nothing above SevN". Plain speech, no bullet markers.>

## 1. Active IcM — <count> (all triaged / N unassigned)
**Triage actions this run** (N unassigned → M):
<A table: Action | Count | Target | What. Rows for ✅ Resolved (list ids),
 ✳️ Assigned → <alias> (one row per target alias, describe the families).>

**By query** (full raw list in Appendix):
<A table: Query | Count | Top families. One row per shared query (By Monitor /
 CIS RP / CIS-Ev2 Bridge / PlannedQuotas / Other), query name LINKED to queryUrl.
 Top families = "26× FulfillPlannedQuota (500365) · 9× …" condensed on one line.>

> **Root cause of <the dominant cluster>** (…): <one blockquote line tying the
>  biggest family to its known root cause + fix track.>

## 2. Daily checklist
<ONE table for all of a–n: | # | Item | Status |. Each row = the checklist item
 (short name) + its result. Use 🔴 FAILED / ✅ / ⚠️ / 📋 markers. Bold the row's
 # for anything needing attention (failed pipeline, non-zero error view). Green
 items get a terse "✅ 0 new (N total)" or "✅ succeeded — [link]"; attention items
 carry the WHAT + link inline. Pipelines link name→pipelineUrl (+ ev2RolloutUrl),
 failed run→runUrl. Request errors h–l: new-in-24h vs historical total, and for
 non-zero show WHAT (regions/parents/ids); item k include genevaError.rootCause.>

## 📌 Known ongoing (handover)
<A table: Item | Status. Carry context forward. On the FIRST report of the
 rotation seed from the day-1 handover in reference.md; after that, if a prior
 OnCall_*.md exists in ~/Tasks/Scrum/, carry its Known-ongoing table forward.>

## Weekly
<hand-over meeting reminder at end of rotation>

---

## 📋 Appendix — All <count> raw IcM incidents (per query)
`✳️` = assigned this run · `✅resolved` = resolved this run.
<Per shared query, a `### <Query> — <count> incidents` heading + a table:
 | IncidentId | Sev | Owner | Title |. EVERY IncidentId is a clickable link
 [`<id>`](portalUrl). Mark this-run actions in the Owner cell (alias ✳️ / — ✅resolved).
 This is the full raw dump the team asked for — list ALL incidents, do not fold.>
```

**Why the appendix:** the team asked (scrum decision) to see the full raw IcM
list, not just the summary. §1 stays a summary (tables); the Appendix carries
every incident. Build the appendix from the full `icm-pending` JSON (all rows),
grouped into the same 5 buckets the collector uses.

**Links, always.** Never emit a bare id or a naked URL — wrap it:
- IcM incident → `[`<IncidentId>`](portalUrl)`; query name → `[query](queryUrl)`.
- sub/parent/planned-quota request → `[`<RequestId>`](requestUrl)` (`/quota/requests/<id>`).
- regional plan (item k) → link its name/region via `planUrl`.
- pipeline → `[name](pipelineUrl)`, failed run → `[<num>](runUrl)`.

### 3. Persist (both, immediately — don't wait for review)

- **Obsidian**: append to `journals/YYYY-MM-DD.md` (hyphen-separated) under a top block
  `- [[OnCall]] daily brief #oncall` (keep the `#oncall` tag; nest the sections
  under it). Obsidian vault root:
  `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Notes`.
  Do not commit.
- **Local**: write `~/Tasks/Scrum/OnCall_YYYY-MM-DD.md` (full report).

### 4. Send to the user's Notes to self

Send the report to the user's **Notes to self** (Teams `48:notes`). This is a
self-send, not an outbound message, so **no confirmation gate** — do it as part
of the run. Build an HTML body (Teams ignores markdown; use `<b>`, `<a href>`,
and **`<table>` for the At-a-glance / checklist / IcM-by-query tables** — the
report is table-first, so render those as real HTML tables, not bullets). The
full 122-row Appendix can be summarized/omitted in the Teams body (link-heavy
tables are huge) — the local `.md` keeps the full raw list. Then:

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
