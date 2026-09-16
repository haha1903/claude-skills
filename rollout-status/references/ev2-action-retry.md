# EV2 action retry after a stopped-slot swap failure

Use when an EV2 App Service slot swap fails with
`Cannot swap site slots because one of the slots is in a stopped state`.
Measured in Lionrock ODT on Test infra on 2026-09-16. Other environments require
their own identity, scope and state checks.

## Mandatory scope and preconditions

1. Confirm the stopped-slot error from the inner resource or ARM deployment error.
   Read both main-site and staging-slot states and record the intended final states.
2. Resolve the service ID, service group, infra and actual child rollout from the
   current rollout tree. Target the failed action in `RegionalRing`, not a
   `CloudPrepRing` placeholder or the root orchestration.
3. Starting apps and retrying actions require an authorized operational request.
   Honor authorization already given for that scope. An investigation or this
   reference alone does not authorize writes. Loop resolver drafts remain subject
   to their caller's execution and delivery rules.

In the verified case both staging slots were already Running and served the
target version through `/ping`. The two main sites were stopped for maintenance.
These commands started them, with explicit subscription and a fresh pod login
before each Azure CLI command:

```bash
kubectl --context bet-prod exec deploy/azure-cli -n default -- bash -c \
  'relogin -f >/dev/null && az webapp start -g lionrock-odt -n lionrock-odt --subscription c9e275b8-def5-4853-b8e3-47b4255228cc'
kubectl --context bet-prod exec deploy/azure-cli -n default -- bash -c \
  'relogin -f >/dev/null && az webapp start -g lionrock-odt -n lionrock-webapi-odt --subscription c9e275b8-def5-4853-b8e3-47b4255228cc'
```

Read the states back independently and confirm readiness before retrying.
These names and IDs describe this case, not defaults for another rollout.

## Real field semantics and the verified retry protocol

Read current state with Iris `ev2.fetchRollout`. EV2 uses PascalCase:
`ResourceGroups[].Resources[].Actions[]`. Match exact names, require `Status ==
"Failed"`, and check `ActionOperationInfo.Mitigation.CurrentActionRetry` against
the observed attempt. It was `0` before this case's first retry. Record accepted
submissions to prevent duplicates. After an ambiguous response or network error,
re-read the action and retry attempt before deciding whether to submit again.

The successful write used Iris `auth.wicToken` with Betbot in AME, matching the
rollout tenant. The Corp identity could read but could not perform this retry.
The verified token request was:

```js
const token = await auth.wicToken('https://test.azureservicedeploy.msft.net', {
  tenant: '33e01921-4d64-4f8c-a055-5bdaffd5e33d',
  client: '8c2cd91e-48e2-4b0c-80a6-f752d877b693',
  timeout: 30,
});
```

Validate the token tenant without logging the token. Encode every path segment
and send an **empty-body POST** to the existing failed action:

```http
POST https://test.azureservicedeploy.msft.net/api/services/{serviceId}/serviceGroups/{serviceGroup}/rollouts/{childRolloutId}/serviceresourcegroups/{resourceGroup}/serviceresources/{resource}/actions/{action}/mitigations/retry?api-version=2022-09-01
Authorization: Bearer <token>
```

Measured: both POSTs returned HTTP `200` with body `null`. The earlier POST using
`api-version=2016-07-01` returned HTTP `400` with an empty body. Keep `2016-07-01`
for the existing GET rollout route, where it works. Do not change all EV2 API
versions together. The successful retry used REST, not a pipeline resubmission
or a manual Azure slot swap. The installed official CLI exposes
`ev2 rollout confirmmitigation --mitigation retry`, but CLI execution was not
verified in this case.

Acceptance is not completion. Follow the retried actions, RegionalRing and root
rollout to completion, then check ADO separately. Verify the main-site `/ping`
version and meaningful authenticated application reads. Preserve the original
pipeline skip flags. Restore intended final site/slot states only after verifying
which slots are active.

Measured case: [EV2 root rollout](https://ra.ev2portal.azure.net/#/rollouts/Test/66fc1dd2-fca0-43fe-a29e-e5019a29e949/Microsoft.AzureGlobal.BuildoutAutomation.ODT.Incremental/af2b37be-028e-4a80-9d6c-f7972d037daf)
and [ADO run 181309982](https://dev.azure.com/msazure/One/_build/results?buildId=181309982).

- Service ID: `66fc1dd2-fca0-43fe-a29e-e5019a29e949`.
- Service group: `Microsoft.AzureGlobal.BuildoutAutomation.ODT.Incremental`.
- Child rollout: `2f79e8b8-769c-4327-b798-874574d33fb2`.
- Resource group: `RegionalRing-eastus-1`.
- Resources: `WebAppSlotsSwap-eastus-1`, `GenevaWebApiSlotsSwap-eastus-1`.
- Action: `Deploy`. Accepted at `04:18:08.929Z` and `04:18:11.092Z` on 2026-09-16.
- Result: EV2 `Succeeded`, ADO `succeeded`, main-site version `1.0.03543.7102`,
  four authenticated API checks passed. Main apps Running, inactive staging slots
  Stopped. Cleanup, Scenario Tests and UI Automation Tests remained Skipped.

## Known false signals

- Measured: successful excluded actions in `CloudPrepRing` did not establish that
  the actual `RegionalRing` swaps had run successfully.
- Measured: an empty `ActionOperationInfo.ErrorInfo` did not mean no error. The
  inner resource/ARM deployment error established the stopped-slot cause.
- Measured: read access through one tenant did not establish retry authorization.
- Measured: HTTP `200` with body `null` acknowledged retry submission. Completion
  and the deployed version required independent follow-up reads.
- Scope limit: this Test/ODT success does not establish Prod retry permissions or
  recovery from a different failure. Diagnose that failure before using a retry.

Documented read route: [EV2 Get rollout status](https://eng.ms/docs/products/ev2/references/api/get-rollout).
