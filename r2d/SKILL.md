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
r2d                           # prompts for pipeline + build, then creates AND SUBMITS
r2d --dry-run                 # resolve everything, print the plan, create nothing
r2d --draft                   # create and fill, but stop before submitting
r2d --pipeline "Lionrock-OfficialBuild+Release" --build 176777580
r2d --latest                  # skip the build prompt, take the newest succeeded build
```

**Submitting is the default.** A bare `r2d` puts a production deployment in front
of approvers with no further confirmation, so `--dry-run` first is worth it: it
exercises every read and prints the exact title, service group, regions and
answers before anything exists.

With no `--pipeline` / `--build` it prompts:

```
Select pipeline:
  1. BET-OfficialBuild+Release
  2. Lionrock-OfficialBuild+Release
  3. Ev2Extensions-Incremental-Prod
> 2

Select build for Lionrock-OfficialBuild+Release:
  1. 1.0.03513.467   2026-08-15  id=176777580
  2. 1.0.03512.466   2026-08-14  id=176667793
> 1
```

Prompts read `/dev/tty`, so a piped stdin does not swallow the answer. With no
terminal at all (cron, CI) the build defaults to newest-succeeded and a missing
`--pipeline` is a hard error listing the options.

## What it does

| Step | Source |
|---|---|
| 1. Pick the build to deploy | ADO, prompted (or `--build` / `--latest`) |
| 2. Find what shipped last | **SafeFly**: newest approved request's `buildVersion` |
| 3. EV2 service group + regions | **ABH** `/release/.../context` (parses the rollout spec) |
| 4. Change title + description | **ABH** `/release/.../summary` (Copilot, with real PR links) |
| 5. Resolve the covering lease | SafeFly lease list + `findCompatibleLease` |
| 6. Create draft, save answers, attach lease | SafeFly `saveRequest` |
| 7. Submit | SafeFly `submitRequest`, unless `--draft` |

Step 2 uses the approval system as the source of truth rather than scanning ADO
pipeline timelines, so the comparison build cannot drift from what reviewers
actually let through. BET, Lionrock and Ev2Extensions all share one serviceId and
a request does not record its pipeline, so the approved requests are walked
newest-first until one is found whose build number exists in this pipeline's runs.

Step 3 falls back to `ev2ServiceGroupFallback` / `regionsFallback` from the config
when ABH returns no deployment units. That happens for build-only pipelines like
Lionrock, whose 419796 merely emits EV2 artifacts ("Binplace Ev2 files") while the
rollout runs elsewhere, leaving ABH nothing to parse. Every fallback run warns
twice, because those values are trusted without verification.

## Prerequisites

**`az login`** — every API here (SafeFly V2 GraphQL, ABH, ADO) runs on your own
user token. No service principal, no IcM onboarding request.

**The pipeline must be onboarded to Azure Build Health**, and its release view's
`releaseId` recorded in `config/services.json` as `abhReleaseId`. Without it ABH
cannot scope the Build Test Maturity evaluation and SafeFly receives no test
signal. To onboard: ADO → Pipelines → Azure Build Health → Settings → save the
suggested release view.

**Do not read `releaseId` off the browser URL.** A service can hold several views
over the same pipeline (419796 has two) and the URL carries whichever was opened
last. List them instead:

```bash
TOK=$(az account get-access-token --resource 1b3d0fbc-ab49-4526-a4b4-18eaa1844d6e \
        --query accessToken -o tsv)
curl -s -H "Authorization: Bearer $TOK" \
  https://azurebuildhealthapi.azurefd.net/releaseIndex/<serviceTreeId> | jq .
```

All three configured pipelines are onboarded. `Ev2Extensions-Incremental-Prod`
still stops early for a different reason: it has no approved V2 request yet, so
there is no comparison build for ABH to diff against. Its first request has to be
made in the portal.

**An approved lease** must cover the service. See below.

## Leases

Leases are reusable: `15.1295` has covered 4 requests
(`changesUsingThisExceptionCount`) and is still valid.

Do not read a lease's state off the `status` field of a single-lease query. That
is the workflow node position, and `End` there only means the approval workflow
finished. `displayStatus` (aliased to `currentState` in iris) is the real state.

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

**The lease title goes in `requestProperties`, not `requestTitle`.** Despite its
name, the `requestTitle` argument is not fed into property-binding evaluation:
SafeFly answers `QUESTION_BINDING_ERROR` / "Property 'Change Request Title' was
not provided", and `findCompatibleLease` reports that as a plain "no lease found".
`leaseCompatibility()` is the function to reach for when a lease is rejected and
the reason matters.

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
