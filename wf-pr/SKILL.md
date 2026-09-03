---
name: wf-pr
description: Azure DevOps pull-request operations for tasks-gateway workflow tasks — create a PR from the current worktree branch, check PR status (merge state, reviewer votes, policy/PoP evaluations), list unresolved comment threads, and resolve a thread. Run from inside the repo worktree; org/project/repo are inferred from the git remote. Use when a workflow task needs to open a PR, poll whether it's approved/merged, or handle review comments. Always use bin/pr.mjs.
---

# wf-pr

PR operations via `az`, run from **inside the repo worktree** (org/project/repo
are parsed from `git remote get-url origin`). All commands print JSON.

## Prerequisite

`az` must be authenticated for Azure DevOps on dev.azure.com/msazure. If you
get "you need to run the login command", the environment's az is logged into
the wrong tenant or hasn't done devops login. This is an environment setup
issue, not a skill bug — surface it, don't work around it.

**ADO rate limit (HTTP 429).** `wf-pr create` needs the branch pushed first; a
`git push` (or this skill's ADO REST calls) can return **429
`RequestBlockedException` / `exceeding usage of resource 'DBCPU'`**. That's ADO
throttling your identity by TSTU consumption (bucket `TFS/Short`), NOT an auth or
code failure. **Do not loop-retry** — retries keep the quota at 0 and prolong the
block. Honor the **`Retry-After`** header (seconds): wait it out once, then a
single retry. It self-heals after ~5 min of no git activity. Persisting? surface
it and leave the commit unpushed (it's safe on the local branch) rather than
hammering. Details + how to read the headers:
`~/Projects/s360-docs/s360/ado-rate-limit-429.md`.

## Commands

Create a PR from the current branch:
```
bin/pr.mjs create --title "Add SKU validation" [--description "..."] [--target main] \
                  [--draft] [--work-items "12345 67890"] [--no-auto-complete]
```
→ `{ prId, url, status, title, autoComplete, workItems? }`. Keep the prId for the rest of the workflow.

Defaults match `~/bin/cpr` (the canonical workflow):
- `--squash true` (single squash commit on merge)
- `--delete-source-branch true` (clean up the task branch on merge)
- **auto-complete enabled** in a follow-up `pr update` call right after creation
  (ADO doesn't reliably honor `--auto-complete true` at create time, so this is a
  two-step: create with auto-complete off, then update to turn it on with a
  `Merged PR <id>: <title>` commit message).
- Pass `--work-items "id1 id2"` to link work items at creation time and set
  `--transition-work-items true` so they advance to the next state on merge.
  Most repos in this org enforce a "Work item linking" policy — without this
  the PR sits with that policy rejected and auto-complete won't actually merge it.
- Pass `--draft` for a draft PR (auto-complete is skipped for drafts).
- Pass `--no-auto-complete` to keep auto-complete off explicitly.

Check status (poll this to drive the workflow):
```
bin/pr.mjs status <prId>
```
→ `{ status (active|completed|abandoned), isDraft, mergeStatus, reviewers:[{name,vote,required}], policies:[{name,status}] }`
- **PoP** shows up in `policies` (look for the proof-of-presence policy; status
  `approved` = passed, `running`/`queued` = pending, `rejected` = failed).
- reviewer `vote`: 10=approved, 5=approved-with-suggestions, 0=none, -5=waiting, -10=rejected.
- `status: completed` = merged.

List unresolved comment threads:
```
bin/pr.mjs comments <prId>
```
→ `{ openThreads, threads:[{threadId, file, comments:[{author,text}]}] }`.
Includes GitOps PR Assistant comments (they post as commentType 'system' — this
skill does NOT filter those out, unlike naive scrapers).

Resolve a thread (optionally leave a reply first):
```
bin/pr.mjs resolve <prId> <threadId> [--comment "Fixed in latest push"]
```

## Typical workflow use

1. After pushing the branch: `pr.mjs create --title "..."` → save prId.
2. On each PR-comment email: `pr.mjs comments <prId>`. For each open thread —
   if no code change needed, `pr.mjs resolve <prId> <threadId> --comment "..."`;
   otherwise change code, push, then resolve.
3. Poll `pr.mjs status <prId>`: when `status: completed` → merged.
