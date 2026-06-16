---
name: wf-release
description: Check ADO build / release pipeline status for tasks-gateway workflow tasks — buddy build and test release. Pass a buildId or the build-results URL found in the notification email. Returns overall status/result plus per-stage results. Use when a workflow needs to know whether a build or test release succeeded. ev2 rollout completion arrives by email (not polled here). Always use bin/release.mjs.
---

# wf-release

Pipeline status via `az pipelines`. After a PR merges, ADO auto-triggers a
buddy build and a test release; the emails carry the build-results URL. Feed
that URL (or the buildId) here to check progress.

## Prerequisite

Same az devops auth as wf-pr (dev.azure.com/msazure).

## Commands

### status — one build's detail
```
bin/release.mjs status <buildId | build-results-URL>
```
Accepts either form — the URL from the email works directly:
```
bin/release.mjs status "https://dev.azure.com/msazure/One/_build/results?buildId=166228506&view=results"
```
→ `{ buildId, definition, buildNumber, status, result, branch, finishTime, url, stages:[{name,state,result}] }`
- `status`: notStarted | inProgress | completed
- `result`: succeeded | partiallySucceeded | failed | canceled (null while running)
- `stages`: per-stage breakdown so you can see how far a running/failed release got.

### runs — list recent runs of a pipeline (candidates)
```
bin/release.mjs runs <pipelineId>
```
→ `{ pipelineId, count, runs: [{ id, buildNumber, status, result, reason, branch, queueTime }] }`
sorted newest-first, with any `inProgress` runs merged in.

Use this when you only know the **pipeline id** and need to find a specific run
— e.g. "did someone trigger the release-enabled run yet?". It does NOT guess
which run is the one you want: scheduled (build-only) and manual
(release-enabled) runs interleave, so the newest run is often NOT the release.
**You** pick the right one using task context (when you/the user triggered it,
`reason: manual` vs `schedule`, whether it's still `inProgress`).

**NEVER hand-roll `az pipelines runs list` (with or without `--top N`).** Its
default ordering isn't reliably newest-first, and `--top N` truncates
in-progress runs right off the list — silently hiding a build that was already
triggered. This bug has bitten real workflow tasks. Always use `runs`, which
merges inProgress explicitly and sorts by queueTime.

To confirm a candidate is actually **release-enabled** (not build-only), feed
its id to `status` and check the Prod/Release stage: a build-only run shows that
stage as `result: skipped`; a release run runs it.

## ev2 rollout — NOT polled here

ev2 rollout completion does not appear as a pipeline stage. It arrives as a
separate email (with the rollout link + status) that gets routed into the task
inbox. The workflow combines the two:
- `wf-release status <buildUrl>` → buddy build / test release succeeded?
- the rollout email in the task inbox → ev2 rollout complete?

The workflow is done only when BOTH the test release `result: succeeded` AND
the ev2 rollout email reports completion.

## Typical workflow use

1. On the buddy-build / test-release email: `release.mjs status <url>`.
   - `result: succeeded` → release stage done.
   - `result: failed` → send a Teams alert (wf-notify), surface the failed stage.
2. Wait for the ev2 rollout email in the inbox; when it reports complete AND
   the test release succeeded, the workflow ends — send a final Teams summary.
