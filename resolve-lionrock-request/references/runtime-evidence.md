# Runtime evidence for Lionrock requests

Use only when live API state is insufficient and these reads are permitted.
Execute through the existing Kusto/IcM skills; this reference does not grant access.

## The `Log` table, and the four ways to read it wrong

`agboa.westus2` / db `lionrock` / table `Log`. One provider
(`Microsoft-Extensions-Logging`), ~300M rows, **30-day retention**. Always filter on
`PreciseTimeStamp` FIRST or a query scans the lot and gets killed.

| Column | What it is |
|---|---|
| `PreciseTimeStamp` | event time, UTC. The one to filter and sort on |
| `Tenant` | **`Prod` or `UAT`** — the environment. Not an Azure tenant id |
| `Role` | the **region** (`westus2`, `eastus`, ...). Not a service role |
| `Level` | .NET ILogger: 1=Debug 2=Info 3=Warning **4=Error 5=Critical** |
| `LoggerName` | the C# class. The main filter, e.g. `Lionrock.Icm.IcmConnector` |
| `FormattedMessage` | **the text. Read this one** |
| `ActivityTraceId` | W3C trace id — how to follow ONE request across loggers |
| `RoleInstance` | pod / VM IP, for isolating a single bad instance |

The four that produce wrong answers:

1. **`Level` is bigger = worse.** Errors are `Level >= 4`. The IcM warehouse uses the
   opposite convention, so a query copied from there silently selects debug noise.
2. **`EventMessage` is always empty.** Use `FormattedMessage`. A filter on `EventMessage`
   returns nothing and reads as "it never happened".
3. **`ActivityId` is always `00000000-...`.** To follow one request across services use
   `ActivityTraceId`. Joining on `ActivityId` matches everything to everything.
4. **`Tenant` decides the environment.** A question about UAT that does not filter
   `Tenant == "UAT"` answers from production traffic, which is about 10x the volume
   (measured: 384k Prod rows against 39k UAT in the same hour) and drowns the rows being
   asked about.

Useful shapes:

```kql
// Everything about one request or incident id, in order
Log | where PreciseTimeStamp >= ago(7d) | where FormattedMessage has "<id>"
    | project PreciseTimeStamp, LoggerName, Level, FormattedMessage | order by PreciseTimeStamp asc

// What is failing right now, grouped
Log | where PreciseTimeStamp >= ago(1h) | where Level >= 4
    | summarize n=count() by LoggerName, EventId | order by n desc

// One request end to end, once ActivityTraceId is known
Log | where PreciseTimeStamp >= ago(2h) | where ActivityTraceId == "<traceid>"
    | project PreciseTimeStamp, LoggerName, FormattedMessage | order by PreciseTimeStamp asc
```

#### The SQL views on `betprod.westus2` / `Lionrock` — usually the faster answer

46 `external_table(...)` views over the service's own database. For "what happened to MY
request" these beat both the app log and the MCP: one query, joined, with the error text
and the ticket in it.

| Table | Key columns |
|---|---|
| `Request` | `RequestId, Status, Requestor, Submitter, Region, RequestSource, CreatedTime` |
| `SubRequest` | `ParentRequestId, SubRequestId, Status, RequestServiceType, SKU, Quota, FulfillChannel, Notes, CreatedTime, FulfillTime, CompletedTime` |
| **`OperationLog`** | `ParentRequestId, SubRequestId, OperationTime, OperationType, Operator, Content` |
| `Ticket` | `TicketId, ParentRequestId, SubRequestId, State, Channel, Cloud, CreatedTime, Notes` |
| `PlannedQuotaRequest` | `RequestId, RequestSource, SubscriptionId, ServiceTreeId, Region, PlanVersion, ContactEmail, ...` |

Beyond the on-demand path, grouped by the question they answer:

| The question | Tables |
|---|---|
| "why was my **plan** not approved / who approves it" | `PlanRegion` (`ServiceTreeId, Blueprint, Region, Version, Status, Submitter, SubmitTime, ApprovedBy, ApprovedTime`), `PlanRegionApproval` (`Type, Status, By`) |
| "what is in the plan for this region" | `Plan` (`Kind, Name, ServiceTreeId, Version`), `PlanDetail` (`SubscriptionCount, DeploymentModel, Service, ...`) |
| "is the capacity order stuck" | `CapacityOrder` (`Id, Status, IsHobo, CreatedTime, ExpiryDate`), `PlanRegionCapacityOrderMapping` |
| "is this region open / what does it require" | `Region` (`RegionName, CloudName, ArmRegionName, Status, RegionType, RequiredFeatures, ...`), `AZ` (`State, IsLive, IsSupportedInGenevaAction, RequiredFeatures`) |
| "does this subscription have access" | `SubscriptionRegion` (`SubscriptionId, Region, Source`), `PlannedQuotaSubscriptionBinding` |
| "is the AFEC flag set" | `Afec` (`AfecName, CompletedTime, CorrelationId, Region, RequestType, Source, SubscriptionId`) |
| "who owns this / is the team onboarded" | `Team` (`Oid, Name, Type, Ring`), `TeamConfig` (`EnabledInUI, AllowHoboCapacityOrders, AutoApproveRegionalPlansForBuildout, ...`) |
| "which blueprint version" | `Blueprint` (`Id, ServiceTreeId, Type, CommitHash, OwningTeam, Name`) |

`.show external tables` lists all 46 if none of these fit — `Demand*`, `PfPlan*`,
`Manatree` and the rest exist but have not come up in a support question yet.

**`OperationLog` is where the error actually is.** `SubRequest.Notes` only carries
cancellation reasons ("[CanceledByAdmin]..."), so a sub-request in `Error` with empty
Notes looks like it failed for no reason. The exception lives in
`OperationLog.Content` as JSON, under `Note`:

```kql
external_table('OperationLog')
| where ParentRequestId == <id> and OperationType == "Error"
| project OperationTime, SubRequestId, Content
| order by OperationTime desc
```

That returned, for one real request, the region, the subscription, the requester, the SKU
and `ErrorCode=500579(CrpClientNoSkuFound)` in a single row.

**"The record carries no error text" is never a finding.** A reply once reported exactly
that: sub-request 1 in `Error`, `Notes` empty, nothing in the app log, therefore "the
service isn't telling us why" -- and it offered to retry blindly in production on that
basis. The exception was in `OperationLog` the whole time, naming the SKU and the region.
Empty `Notes` plus a quiet app log means this table has not been read yet. It never means
the failure had no cause.

An earlier reply to that same request, written before this section existed, dug
`CrpClientNoSkuFound` out of the app log the hard way and said far more. Losing that to a
routing table that read "then the app log" is why the table now says `OperationLog` first.

`OperationType` also shows who did what: `Retry` rows name the person, so "somebody
already retried this twice" is one query away.

**Waiting on something external?** `Ticket` says what. Every row observed is
`Channel == "ADO"` (an RDQuota work item created by CM24), and `State` carries the real
status: `Backlogged`, `Action Required`, `Incomplete`, `Completed`. `Action Required`
means the reviewer asked the requester something — see the auto-cancellation note on the
`lionrock` wiki's `entities/rdquota-cm24.md`.

```kql
external_table('Ticket') | where ParentRequestId == <id>
| project TicketId, SubRequestId, Channel, State, Cloud, CreatedTime
```

**Link the ticket, do not try to read it.** `Channel == "ADO"` tickets are RDQuota work
items in **`CapacityRequest/Quota`** — not `msazure/One`, where a sampled id 404s:

```
https://dev.azure.com/CapacityRequest/Quota/_workitems/edit/<TicketId>
```

The asker opens that as themselves and sees the whole discussion, which is more than any
query here would return. Do not fetch it: this identity gets **401** on that org (measured),
so an attempt only produces a confusing error. `Ticket.State` already gives the status
worth putting in the reply.

Other channels: ICM goes to the IcM portal (`/imp/v3/incidents/details/<id>/home`), and QMS
has no openable portal at all — `TicketProvider.GetTicketUrl` links a filtered RDQuota
query instead.

**A `General_BadRequest` with no detail is the cluster, not your KQL.** It rejects valid
queries intermittently — the same text can fail 8 times and then succeed. iris retries the
transient ones; if it still fails, wait rather than rewriting a query that is correct.

- **`icm-query`** and **`icm-call GET`** — whether an incident already exists and
  what has been said on it. Check this before answering "is this known": someone
  else may already have the answer on the incident.
- **eng.ms** — the authoritative docs for anything outside our service (ARM, CIS,
  EV2, quota platform), and where most TSGs live. On the host use the `browse` skill or
  the `enghub` MCP; the search entry point is `https://eng.ms/search?q=<query>`.
  **Not reachable from the loop container, and not for want of a token.** Measured by
  sending the SAME user token from both: 200 from the host, 403 from the pod. With no
  token at all it is 401 from the host and 403 from the pod -- different answers to an
  identical request, so the refusal is about where the request comes from, not about
  credentials. The 403 carries `x-azure-ref` and the body says only "The request is
  blocked", i.e. Azure Front Door turns it away before eng.ms sees it. Nothing here can
  fix that: say the source was unavailable and answer from the wikis.
- **The TSG for the thing that broke** — usually linked from the `oncall` wiki page
  for that root cause, sometimes only findable on eng.ms. If a TSG exists, cite it:
  it is what lets the asker act without you.

#### When something similar worked, diff against it

"But we have a successful case for this" is the most useful sentence an asker can say,
and you should look for it before they do. If the same SKU, region, blueprint or request
type has a case that went through, the difference between the two IS the cause, and it
is far more convincing than a lone error line.

Measured on a real thread: `CrpClientNoSkuFound` on a VM SKU got "the SKU is too new,
CRP does not support it", which the asker refuted one minute later with a request using
the same SKU successfully. The log showed `CasProvider` saying `already has the Regional
access for the VM SKU` on the working request and `does not have` elsewhere. Same
check, opposite outcome: that is the answer, and nothing about the failing request alone
would have produced it.

So for "why did MY thing fail" where the thing is not obviously broken everywhere: find
the working counterpart, run the same query against both, and report the difference.
