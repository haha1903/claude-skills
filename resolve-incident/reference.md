# IcM Investigate — Reference (repos, error map, wiki TSG, msapi/kusto)

Lookup tables for `SKILL.md`. Everything path-precise so an agent can grep/read
directly.

## Repos (local paths)

| Repo | Path | What's in it |
|---|---|---|
| **Lionrock** (main) | `~/Projects/Lionrock` | Quota/buildout RP, WebApi, WebJobs, OnDemand, PlannedQuota, GenevaActions |
| **CIS platform** | `~/Projects/Azure-CIS-Platform` | CIS tenant/workflow definitions (`ExistingWorkflows.txt`, `TenantOverrideManager`, allowlists) |
| **Ev2 Bridge** | `~/Projects/AzureGlobal-BuildoutAutomation-CIS/src/Workflow/CisEv2BridgeWorkflow/` | CIS-Ev2 Bridge workflow (`CisEv2BridgeWorkflow.xaml`, `Ev2ClientHelper.cs`, `Ev2BridgeSignalEventActivity.cs`) |
| **BET** (Billing) | `~/Projects/BET` | Billing meter, bet-bot |
| **Wiki** | `~/Projects/AzureGlobal-BuildOutAutomation-Wiki` | TSGs, runbooks, on-call docs |

> Note: `AzureGlobal-BuildoutAutomation-CIS` is mostly the Ev2 Bridge workflow.
> The broader CIS platform code (tenant names like `cisrepaves`/`newcloudbuildout`,
> workflows like `TenantBasedOnDemandProvisioning`) lives in `Azure-CIS-Platform`.

## Error token → repo heuristic

From the IcM `Title` (e.g. `[Region Access] Error occurred 500365:...@FulfillPlannedQuotaRequestError`),
take the token after `@` or the error name:

- **PascalCase `*Error`/`*Exception`, no dots** → **Lionrock**. Two-step grep:
  ```bash
  grep -n "<Token>" ~/Projects/Lionrock/src/Lionrock/service/Lib/Lionrock.Common/LionrockEventIds.cs   # confirm + get numeric id
  grep -rn "LionrockEventIds.<Token>" ~/Projects/Lionrock/src --include="*.cs" | grep -viE "Test|Spec" # throw/log site
  ```
  `LionrockEventIds.cs` is the canonical registry of every Lionrock event id+name.
- **Dotted or lowercase** (`cisrepaves`, `newcloudbuildout`, `OnDemandProvision.TenantBasedOnDemandProvisioning`) → **CIS**:
  ```bash
  grep -rn "<Token>" ~/Projects/Azure-CIS-Platform/src | grep -viE "\.git|Test"
  ```
  Check `ExistingWorkflows.txt` (workflow registration), `TenantOverrideManager.cs` /
  `LegacyTenantImpersonationCutoffDateAllowList.cs` (tenant names).
- **CIS-Ev2 Bridge** titles (`Task Microsoft.Lionrock.Ev2Bridge.*`, `Service <guid>`, owning team `CIS-Ev2Bridge`) → the Ev2 Bridge path above.
- **Billing / Invoice / BET** → `~/Projects/BET/src`.

Owning-team → repo shortcut (from IcM `OwningTeamName`): `Whitelist&Quota` /
`Lionrock*` → Lionrock; `SubscriptionWhitelisting` / `CIS*` → Azure-CIS-Platform;
`CIS-Ev2Bridge` → Ev2 Bridge; `Billing`/`BET` → BET.

## Known error → throw site (seed table)

| Error token | id | Repo · file | Context |
|---|---|---|---|
| GenevaActionsOperationsError | 500499 | Lionrock · `WebApi/Lionrock.GenevaActions/GenevaActionsClient.cs` (L176/213) | `ExecuteOperationAsync` / `QueryExecuteResultAsync` catch → `LionrockGenevaActionsException` |
| FulfillPlannedQuotaRequestError | 500365 | Lionrock · `Lionrock.Declarative.ARM/PlannedQuotaFulfillmentProvider.cs` (L338) | `FulfillRequestWithPlanAsync` |
| InvalidWebApiResponse | 400133 | Lionrock · `Lionrock.WebApi.Client/WebApiHttpClient.cs` (L119) | `LionrockWebApiException` when a called WebApi returns non-2xx — often GenevaActions via `ProcessNewPlannedQuotaRequestsJob`; can **wrap an inner 500499** (see triage rules) |
| BuildoutRegionHasNoPsl | 500583 | Lionrock · `Lionrock.WebJobs/Triggered/SyncRegionPropertiesJob/PslHandler.cs` (L80/88) | logged (no throw) in PSL validation |
| GetSqlRegionalFeatureError | 500318 | Lionrock · `Lionrock.WebJobs/Triggered/ServiceAvailabilityCheckJob/ServiceAvailabilityCheckJob.cs` (L729) | LogError in availability check |
| CheckAlreadyDoneError | 500250 | Lionrock · `Lionrock.OnDemandRequest/FulfillmentProvider.cs` (L155-162) | LogWarning + ErrorContent note |
| FulfillSubRequestError | 500223 | Lionrock · `Lionrock.OnDemandRequest/RequestProvider.cs` (L338-366) | `TryFulfillSubRequestAsync` |

Registry: `~/Projects/Lionrock/src/Lionrock/service/Lib/Lionrock.Common/LionrockEventIds.cs`.
Extend this table as you investigate new tokens.

## Wiki TSG routing

Wiki root `~/Projects/AzureGlobal-BuildOutAutomation-Wiki`. TSG pages are `.md`
with YAML frontmatter `tags:` and a `## Symptom / ## Detection / ## Cause /
## Mitigation / ## Escalation` structure. Search order:

```bash
W=~/Projects/AzureGlobal-BuildOutAutomation-Wiki
grep -rn "tags:" $W/troubleshooting --include="*.md" -A5 | grep -i "<term>"      # curated tag index
grep -rli "<ErrorCode|ErrorString>" $W/troubleshooting $W/internal/troubleshooting --include="*.md"  # symptom match
```

| Component / keyword | Start here |
|---|---|
| Any IcM filing / queue question | `troubleshooting/icm_queue.md`, `troubleshooting/overview.md` |
| PlannedQuota / FulfillPlannedQuota | `troubleshooting/planned-quota/fulfillment.md` → sub-TSGs |
| OnDemand Quota | `troubleshooting/ondemand_quota.md` |
| CIS-Ev2 Bridge, buildout dependency, SG | `cis/cisev2bridge/operation/operation-tsg.md` (quick-find case index) |
| AzRetrofit / AFEC / DCMT / Geneva Actions | `cis/azretrofit/operation/operation-playbook.md`, `cis/azretrofit/index.md` |
| Subscription not associated / binding / whitelist | `troubleshooting/planned-quota/fulfillment/subscription-not-associated-with-service-tree.md`, `internal/lionrock-support/faq.md` |
| PSL scope / blueprint assignment | `internal/lionrock-support/faq.md` |
| ARM deployment error codes | `troubleshooting/common/arm-deployment-error-codes.md` |
| Geneva Actions claims / DSTS SCI | `internal/troubleshooting/DSTSClaims/required.md` |
| BET / Billing Meter | `internal/troubleshooting/BET/tsg.md`, `troubleshooting/billing-meter.md` |
| Internal on-call runbooks | `internal/troubleshooting/ICM/tsg.md` (search `internal/` separately — not linked from public pages) |

> Many specific error codes (e.g. 400133) have **no dedicated TSG**. If the tag/symptom
> search returns nothing, route by component above, then rely on the code throw site +
> the DescriptionEntries snippet — don't keep grepping the wiki for the exact code.

## msapi / icm actions

Import `from msapi import icm`. Reads use `az` token; **writes use Betbot WIC**
(bet-prod pod, via the `icm` skill's `icm-token`).

| Op | Call |
|---|---|
| Full detail | `icm.get_incident(id)` |
| **Runtime log snippet (no VPN)** | `icm.odata("GET", f"incidents({id})?$expand=DescriptionEntries")` → the `healthmanagesvc` entry is a DGrep snippet with the real inner error + `ActivityTraceId`. Use when Kusto is off-net |
| Comment (1 / bulk) | `icm.add_comment(id, text)` / `icm.comment_many({id: text})` |
| Resolve (1 / bulk) | `icm.resolve(id)` / `icm.resolve_many(ids, reason=..., is_noise=True)` |
| Ack (1 / bulk) | `icm.ack(id, "haichang")` / `icm.ack_many(ids, "haichang")` |
| Assign person (1 / bulk) | `icm.assign(id, alias)` / `icm.assign_many({id: alias})` |
| Mitigate | `icm.mitigate(id, reason, is_noise=False)` |
| Update fields | `icm.update(id, {"Severity": 2, ...})` |
| Transfer team | `icm.transfer(id, owning_team_id, owning_tenant_id)` |
| List pending (warehouse) | `icm.pending_actions(owner="unassigned")` |

`resolve_many` mitigates (with `reason`, `is_noise`) then resolves then verifies
`Status=="Resolved"`. `icm` skill bin equivalents: `icm-call`, `icm-comment`,
`icm-mitigate`, `icm-assign`, `icm-ack-many`, etc. under `~/.claude/skills/icm/bin/`.

## Kusto quick-ref

`from msapi.kusto import query_kusto` (returns `(cols, rows)`, `az` token).
**⚠ All three clusters need corporate network / VPN — off-net the TLS handshake
fails (`SSL_UNEXPECTED_EOF`). If Kusto is unreachable, fall back to the IcM
`$expand=DescriptionEntries` snippet (see msapi actions above) for the inner error.**

| Cluster | DB | Use |
|---|---|---|
| `https://icmcluster.kusto.windows.net` | `IcmDataWarehouse` | IcM report/aggregate; BET tenant `OwningTenantId==25998`; dedup `arg_max(Lens_IngestionTime,*) by IncidentId` |
| `https://agboa.westus2.kusto.windows.net` | `lionrock` | App logs, table `Log`. **Level>=4 = error** (.NET ILogger). `FormattedMessage` (not `EventMessage`). `ActivityTraceId` chains a request across loggers. Always `PreciseTimeStamp >= ago(...)` first (~300M rows) |
| `https://betprod.westus2.kusto.windows.net` | `Lionrock` | Business data as **external tables** (`external_table('SubRequest'|'Request'|'PlannedQuotaRequest'|'PlanRegion'|'CapacityOrder')`). Don't project `CapacityOrder.ExpiryDate` (breaks the view) |

Lionrock log example (root-cause a token or a request id):
```python
kql = f'''Log
| where PreciseTimeStamp >= ago(2d)
| where FormattedMessage has "{token_or_id}"
| project PreciseTimeStamp, LoggerName, Level, ActivityTraceId, FormattedMessage
| order by PreciseTimeStamp desc | take 30'''
cols, rows = query_kusto("https://agboa.westus2.kusto.windows.net", "lionrock", kql)
```
Then chain the full request with `where ActivityTraceId == "<id>"`.

## Historical triage examples (verify against the current incident)

- **GenevaActionsOperationsError** (500499) → a previously verified transient condition. Verify the exact inner error,
  region and affected request state before using a benign disposition. Root cause: ACIS returns HTTP 500 `OperationExecutionActiveEntity
  does not exist` polling an already-terminal operation during new-region buildout;
  monitor 500499 opens one Sev4 per hit. Cosmetic fix — real fix is handling that
  500 in `GenevaActionsClient.QueryExecuteResultAsync`.
- **InvalidWebApiResponse** (400133) is often the **outer wrapper of an inner
  GenevaActionsOperationsError** (500499): `ProcessNewPlannedQuotaRequestsJob` →
  `GenevaActionsClient` → `WebApiHttpClient` re-throws the platform 500 as 400133, so
  the monitor fires on 400133 instead of 500499. If the DescriptionEntries body shows
  `OperationExecutionActiveEntity does not exist`, it's the same transient noise —
  but **Confirm** (propose resolve), don't auto-resolve, because the surface event id
  differs from the established-noise token.
- **CIS task** (SubscriptionWhitelisting / TenantBasedOnDemandProvisioning / cisrepaves /
  newcloudbuildout) → propose `assign lingc` (owns the sibling queue).
- **Lionrock real fulfill failure** (FulfillPlannedQuotaRequestError etc., tied to a
  live request) → ack to self + comment the root cause; often the SW US / SE US 5
  new-region buildout thread (shared with rolling-test / UAT failures).

## Root-cause-before-close methodology (learned 2026-07-08)

Techniques that worked when investigating a large batch of pending IcMs, so you
can determine the *why* (never close on frequency alone — see the cardinal rule):

**1. Match by `EventId` / `EventName`, NOT `FormattedMessage has "<token>"`.**
The IcM title token (e.g. `500318` / `GetSqlRegionalFeatureError`) is the log's
`EventId` / `EventName` column — NOT text in `FormattedMessage`. A
`FormattedMessage has "GetSqlRegionalFeatureError"` search returns 0 (the message
body is worded differently) → a **false all-clear**. Use `where EventId == 500318`
or `where EventName == "..."`.

**2. app-log `Level` — bigger = more severe.** Info=2 (the bulk, ~1.6M/3h),
Warn=3, **Error=4**, Critical=5. Real errors = `Level >= 4`. (Do NOT confuse with
IcM **Severity**, which is the opposite: smaller = more severe.)

**3. "Did the root cause actually stop?" — bin by time, don't trust a 1d count.**
A `count(ago(1d))` can still be huge because the window straddles the pre-fix
spike. Bin it: `summarize c=count() by bin(PreciseTimeStamp, 2h)`. The 2026-07
GA poll-TTL noise (`OperationExecutionActiveEntity does not exist`) stopped at
**~07-07 20:00** — that's the real GA-fix cutoff. This historical cutoff applies only to that verified fix and region. Zero hits
alone never establishes recovery or authorizes incident closure.

**4. Region-scoped events: check the specific region, not the EventId overall.**
An EventId (e.g. SyncSku 500282) can still fire post-fix for OTHER regions
(sovereign clouds — China/Delos/Bleu/Singapore/Fairfax — whose GA is a separate
stamp not covered by the public fix) while your incident's region has stopped —
or vice-versa. Filter `EventName has "<region>"` to confirm YOUR incident's cause
is gone. Sovereign/national-cloud SyncSku + Batch-CRP failures are a KNOWN
separate ongoing issue, not the resolved public GA noise.

**5. Kusto access + the flaky-cp workaround.** Betbot federated identity can query
all three clusters once granted viewer (betprod `Lionrock`, icmcluster
`IcmDataWarehouse`, agboa `lionrock`) — mint the token in-pod, same pattern as
`icm-token`. `kubectl cp` into the bet-prod azure-cli pod **silently fails** under
network flakiness (reports success, file absent). Pipe the script via
`kubectl exec -i ... -- python3 - <<'PY'` instead of cp. Heavy `FormattedMessage has`
scans over 14d+ hit the query limit (400 General_BadRequest) — narrow the window
or use `EventId ==` (indexed, cheap).

**6. A single incident returning `Forbidden` is NOT an auth/token failure. First
suspect a WRONG INCIDENT ID (a typo), then a foreign-tenant incident.** The IcM
OData token (`icm-token`, aud `icmapi-prod`) is an **app-only token with
`roles: None` / `scp: None` — that is NORMAL**; IcM does not gate on those claims.
So do NOT diagnose a `{"odata.error":{"value":"Forbidden"}}` as "the Betbot
app-role was revoked / downgraded".

**Order of suspicion when ONE id is Forbidden while others work:**
1. **Did I copy the id correctly?** IcM ids differ by one digit all the time
   (`829669369` vs `829669663`). Re-derive the id from the source query, don't
   hand-retype it. Then re-check against the warehouse by TITLE/EventId, not by
   the id you typed.
2. **Is it even ours?** `Incidents | where IncidentId==<id> | summarize
   arg_max(Lens_IngestionTime,*) by IncidentId | project OwningTeamName,
   OwningTenantId`. A non-25998 tenant = not ours, can't touch it, drop it.
3. Only after 1 & 2 both clear should auth even be considered — and it almost
   never is. Prove the token is fine by reading a DIFFERENT incident you know is
   ours; if that works, the token is fine.

(Seen 2026-07-10: I mistyped the Batch incident as `829669663` — that id is a real
but foreign incident (`MESSAGINGPUBSUBSERVICE\Triage`, tenant 22936), so GET
returned Forbidden and I wrongly blamed the token. The real id was `829669369`,
ours, and read/wrote fine. Root cause = my typo, not auth.)
