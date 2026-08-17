---
name: r2d
description: Use when creating or submitting a SafeFly R2D (Request to Deploy) change request for a Lionrock/BET Azure incremental deployment. Discovers the build, pulls the ABH Copilot summary and EV2 context, attaches the covering lease, and submits. Triggers on "r2d", "submit r2d", "发个 r2d", "safefly request", "request to deploy", or asking about an R2D's status.
---

# R2D — SafeFly V2 change requests

Creates App deployment change requests in SafeFly V2 end to end. Everything comes
from an API: no browser, no form filling.

SafeFly V1 went read-only on 2026-07-15, so V2 is the only path for new requests.
The V2 portal is an Azure Portal extension with no drivable form, which is why the
old `r2d.sh` browser automation cannot be adapted.

## TL;DR

```bash
r2d --dry-run                 # resolve everything, print the plan, create nothing
r2d                           # create the draft, fill it, attach the lease
r2d --submit                  # ...and submit for approval
r2d --pipeline "Lionrock-OfficialBuild+Release" --build 176777141 --submit
```

`--dry-run` first is worth it: it exercises every read and shows the exact title,
service group, regions and answers before anything is created.

## What it does

| Step | Source |
|---|---|
| 1. Pick the build to deploy | ADO, latest succeeded (or `--build`) |
| 2. Find what shipped last | **SafeFly**: newest approved request's `buildVersion` |
| 3. EV2 service group + regions | **ABH** `/release/.../context` (parses the rollout spec) |
| 4. Change title + description | **ABH** `/release/.../summary` (Copilot, with real PR links) |
| 5. Resolve the covering lease | SafeFly lease list + `findCompatibleLease` |
| 6. Create draft, save answers, attach lease | SafeFly `saveRequest` |
| 7. Submit | SafeFly `submitRequest`, only with `--submit` |

Step 2 uses the approval system as the source of truth rather than scanning ADO
pipeline timelines, so the comparison build cannot drift from what reviewers
actually let through.

## Prerequisites

**`az login`** — every API here (SafeFly V2 GraphQL, ABH, ADO) runs on your own
user token. No service principal, no IcM onboarding request.

**The pipeline must be onboarded to Azure Build Health**, and its release view's
`releaseId` recorded in `config/services.json` as `abhReleaseId`. Without it ABH
cannot scope the Build Test Maturity evaluation and SafeFly receives no test
signal. To onboard: ADO → Pipelines → Azure Build Health → Settings → save the
suggested release view, then copy `releaseId` out of the URL.

Currently onboarded: `BET-OfficialBuild+Release` only. The other two pipelines in
the config have `abhReleaseId: null` and the tool refuses them with instructions.

**A fresh approved lease** must cover the service. See below.

## Leases are consumed

A lease is spent once its change request is approved. `15.1295` covered request
`15.3412` and is now `End`, so the next release needs a new one.

When no usable lease is found the tool stops and does not create anything:

```
ERROR: no approved, unexpired lease covers Azure Build Out Automation
```

This is deliberate. Submitting without a lease silently drops the request into
full manual review, which is slower and easy to miss. Create and get a lease
approved in the SafeFly V2 portal, then re-run.

## The lease title constraint

A lease binds the change request title with a regex, e.g.:

```
propertyBindingKey : CHANGE_REQUEST_TITLE
comparisonOperator : REGEX_MATCH
expectedValues     : ["^Lionrock incremental release"]
```

Submitting a title that does not match fails with "Lease request ... is not
compatible with this change request". This is what the hardcoded
`titlePrefix: "Lionrock incremental release"` in the old `r2d.sh` was really for.

The tool reads the prefix off the lease and composes:

```
<lease prefix> - <ABH Copilot title>
```

so the prefix is never hardcoded and adapts when the lease changes.

## Gotchas encoded in the tool

**`core.regions` is a dynamic choice.** Values must be canonical PascalCase
(`WestUS2`), not display spellings (`West US 2`), or the whole save is rejected.
EV2 reports regions lowercase, so they get mapped through the allowed list.

**`saveRequest` replaces the answer set, it does not merge.** Omitting an existing
answer clears it. All answers are always sent together.

**Only ~10 of the form's 43 questions apply.** The rest are hidden by conditional
rules (`lsm.*` / `pilotfish.*` / `azdeployer.*` / `storage.*` for other
orchestrators, `ccoa.*` for non-CCOA requests, `core.critical_rollout.*` for
Pilotfish only). Hidden questions stay `isRequired: true`, so the rules have to be
evaluated before checking for gaps.

**`findCompatibleLease` needs a `formId`**, which only exists once a draft has been
created. So the lease is picked locally first (to learn the title prefix), then
confirmed against SafeFly after the draft exists.

## Config

`config/services.json` holds stable identity only — franchise, change type,
service ids, `abhReleaseId`, and the fixed answers per pipeline
(`core.sdp`, `core.rollback_strategy`, ...). Build numbers, titles, descriptions,
service groups and regions are all discovered at run time.

To onboard another pipeline: add its `definitionId`, `serviceId` and
`abhReleaseId`. Optionally pin `leaseDisplayId` to skip lease discovery.

## Checking status

```bash
r2d-status 15.3412        # one request
r2d-status --recent       # recent requests for the service
```

## Implementation

All API access lives in iris (`~/Projects/iris/src/safefly.ts` and `src/abh.ts`),
per the project rule that MS-internal API access belongs in the SDK rather than in
each skill. The scripts here are thin wrappers over
`~/.claude/skills/_iris-shared/index.mjs`.

After changing iris, re-bundle so skills pick it up:

```bash
cd ~/Projects/iris && npm run bundle:skills
```
