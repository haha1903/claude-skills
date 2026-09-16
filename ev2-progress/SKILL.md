---
name: ev2-progress
description: Recursively drill into an EV2 rollout and its child ring rollouts to show the real running/failed actions. Use when a rollout is a ring orchestration (Lionrock Prod, region buildouts) whose top-level ResourceGroups is empty and plain ev2-rollout reports "0 actions".
---

# EV2 Progress — recursive ring drill-down

For new investigations, use [rollout-status](../rollout-status/SKILL.md) with
`--tree --json`. That Iris path preserves nested resource errors and Shell logs.
This older Python helper does not include the same evidence extraction.

## When to use

A **ring-orchestration** EV2 rollout (Lionrock Prod, region buildouts) has an
**empty top-level `ResourceGroups`** — it is only an orchestrator. The real
deploy actions live in **child ring rollouts** referenced by
`StageInfos[].RingRolloutId`.

Plain `ev2-rollout` (the `ev2` skill) queries a single rollout, so for these it
prints "Running, 0 actions" and hides all the progress. `ev2-progress` walks
every child ring recursively and reports each level's running/failed actions.

Use it when:
- Watching a Lionrock (or any ring-orchestrated) prod rollout and `ev2-rollout`
  shows a running rollout with no actions.
- A build pipeline is stuck in the EV2 stage and you need the actual per-ring
  deploy state, not just the ADO task status.

## Usage

```bash
# By rollout id + service group
~/.claude/skills/ev2-progress/bin/ev2-progress <ROLLOUT_ID> \
  --infra=<int|prod> --service-group=<SERVICE_GROUP>

# By portal URL (infra + service group parsed from the URL)
~/.claude/skills/ev2-progress/bin/ev2-progress \
  "https://ra.ev2portal.azure.net/#/rollouts/Prod/<svcId>/<svcGrp>/<rolloutId>"

# Full progress tree as JSON (for looping / notifications)
~/.claude/skills/ev2-progress/bin/ev2-progress <ROLLOUT_ID> --infra=prod -g <SG> --json
```

Exit code is `1` if any action in any ring has failed, else `0` — handy in a
watch loop.

## Output

```
root  [Running]  (no direct actions)
root/294bd642  [Running]  Pending=1 Succeeded=15
    RUN  Deploy / DeployWebJob-westus2-1
```

Each line is one rollout level: `<path>  [<Status>]  <action counts>`, with
`RUN`/`FAIL` lines underneath. `path` is the ring chain (`root/<childId8>`).
`FAIL` lines include the `ErrorCode` and the full `ErrorReason` (same text as the
portal Log tab).

## How it works

Thin wrapper over `msapi.ev2.rollout_progress()` — see
`~/Projects/msapi/docs/API.md`. The msapi library handles cert auth, token
caching, the `embed-detail=True` flag, PascalCase parsing, and the recursion
into `StageInfos[].RingRolloutId`. This skill only formats the tree.

## Common workflow: watch a Lionrock prod build's EV2 stage

1. From the build's `Ev2 RA - Deploy` task log, grab the portal URL
   (`##[warning]Ev2 portal link - https://ra.ev2portal.azure.net/#/rollouts/...`).
2. Feed that URL (or the parsed rollout id + service group) to `ev2-progress`.
3. In a `/loop`, re-run every 90s; on a non-zero exit (a ring action failed),
   send a Teams notification with the FAIL lines and continue until the
   top-level status is terminal (`Succeeded`/`Failed`/`Canceled`).

Lionrock prod service group: `Microsoft.AzureGlobal.BuildoutAutomation.Prod.Incremental`, `--infra=prod`.
