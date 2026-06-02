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

## Command

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
