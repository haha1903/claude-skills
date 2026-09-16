---
name: rollout-status
description: Use when asked whether an EV2 rollout succeeded, failed, or is still running, or how to recover a stopped-slot swap failure, from a ra.ev2portal.azure.net URL or a rolloutId plus its service group. Reports per-action status and ARM error text, walks child ring rollouts, and links the verified action-retry procedure. Says plainly when EV2 credentials are absent rather than reporting nothing found. Not specific to any repo or service. For the pipeline stage that triggered the rollout use release-status.
summary: Whether an EV2 rollout is done, and which action failed
---

# Rollout status

```bash
bin/rollout-status.mjs <portalUrl> [--tree] [--json]
bin/rollout-status.mjs <rolloutId> --service-group=NAME [--infra=int|prod] [--tree] [--json]
```

A portal URL carries the infra, service group and rolloutId, so prefer it — get one with
`release-status ev2-url <buildId>`.

Exit codes are meant to be read: **0** read succeeded with no observed failure (the rollout may still be running), **1** a rollout or action failed, **3** a read was unavailable, including a child rollout.

## EV2 is a different system from the pipeline

The rollout is triggered by an `Ev2RARollout` task inside the release stage, but it runs in EV2, not in
Azure DevOps. Consequences that matter:

- **A green release stage does not mean the rollout landed.** The stage can finish, or report
  `inProgress`, while the rollout underneath is still going or has already failed.
- **A rollout outlives its pipeline run.** A rollout can take days; the ADO run does not wait, and
  does not flip to failed if the rollout later does.
- **Separate EV2 authentication.** This status helper uses the EV2 certificate
  configuration. The retry reference below records a separately verified workload
  identity path. Successful status reads do not establish permission to retry.

## When it cannot look, it says so

If there is no EV2 credential this exits **3** and prints:

```
EV2 rollout status is NOT AVAILABLE in this environment.
  no EV2 credentials: /home/app/.ev2/config.yaml does not exist
  This is NOT "the rollout is fine" and NOT "no failures found".
  The rollout state is UNKNOWN from here. Report it as unknown, with the link:
```

Pass that on as written. "Could not check" and "checked, nothing wrong" are different answers, and the
second one is what gets a failed deployment left in place. The credential is probed with a file check
*before* calling EV2, so this can never be confused with a rollout that fetched cleanly.

`--json` still exits 3 here rather than printing an empty result, for the same reason.

## Ring orchestrations: `--tree`

A ring orchestration's top-level `ResourceGroups` is empty, so a flat read of it reports **0 actions**
for a rollout that is busy or broken several rings down. That reads exactly like success.

```bash
bin/rollout-status.mjs <portalUrl> --tree
```

recurses `StageInfos[].RingRolloutId` and prints each ring with its own actions and errors. Without
`--tree`, a rollout that has child rings and no actions of its own says so explicitly instead of
printing a clean-looking zero.

## Nested failure evidence

The helper reads `ResourceOperations[].StatusMessage`, including JSON-encoded
`Shells[].Log`, when action-level `ErrorInfo` is empty. Use `--tree --json` for
investigations so child rollout IDs, resource/action provenance, correlation IDs,
execution times and evidence source paths stay attached to the diagnostics.
An action contains at most 12 evidence entries, each with at most 4,000 message
characters. Long Shell logs keep diagnostic context and their completion tail.
`truncated` and `evidenceTruncated` explicitly mark incomplete excerpts. The
compatible `errorReason` remains a short summary, not the complete log.

A Shell exit code proves the script failed. A SQL execution timeout proves that
operation timed out. Neither establishes an underlying infrastructure cause or
current recovery. Keep those gaps explicit and correlate the same attempt with
its runtime logs when needed. Diagnostic output is internal evidence and must
follow the caller's disclosure and shadow-reply rules.

## No service-group default

A rolloutId without `--service-group` is an error rather than a guess. Defaulting it (an earlier
version of this tooling defaulted to a BET bootstrap group) means quietly reporting on a different
service's rollout whenever the caller forgets the flag — an answer that looks right and is not.

## Recovering a stopped-slot swap failure

Read [EV2 action retry](references/ev2-action-retry.md) for the verified start,
action-retry and verification sequence, including API-version and tenant traps.
The status helper remains read-only. Executing remediation requires authorization
for the affected scope and must follow the caller's execution rules.
