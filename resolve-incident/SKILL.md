---
name: resolve-incident
description: Use when a Lionrock, CIS, EV2 Bridge or BET monitor incident needs diagnosis of a fault in our code or a dependency, or an established diagnosis needs its supported remediation or ownership decision. Trace the actual inner error and current state before confirming the category. Specific benign-condition checks use resolve-incident-noise.
summary: Diagnose an incident and establish the supported remediation
handles: [Internal.OurBug, Internal.ExternalFault]
---

# Resolve an incident diagnosis

Establish the failure's cause and what action follows from it. The two categories
share the investigation; the evidence determines whether the failing boundary is
our code/configuration or an external dependency. Invocation alone is not a fix.

Read [the investigation reference](reference.md) for repo/error lookups and TSG
locations. Use installed [icm](../icm/SKILL.md),
[kusto-query](../kusto-query/SKILL.md), and [wiki-query](../wiki-query/SKILL.md)
capabilities for reads. Their current invocation/auth instructions take precedence
over older API examples in the reference. Respect denied capabilities.

## Investigate the supplied scope

For an incoming item, inspect only its incident or supplied family. A missing ID
does not authorize a queue sweep. A separately requested all-incident investigation
can list pending actions, group by evidence-supported cause and work each group.
Mooncake/Fairfax Geneva-Log incidents remain outside that sweep's established scope;
report them as requiring the separate operator workflow rather than silently skip.

1. Read the incident, its DescriptionEntries and any existing root-cause wiki page.
   The first monitoring entry often carries the real inner error and
   `ActivityTraceId`; the title alone does not.
2. Locate the throw/log site in the appropriate repo. Follow the inner exception
   across service boundaries; a stack trace in our code can wrap a dependency fault.
3. Confirm against the current request/resource and runtime logs. Match region,
   environment and failing attempt. If the IcM names a Lionrock request, reuse
   [resolve-lionrock-request](../resolve-lionrock-request/SKILL.md) and its evidence.
   For CIS-backed execution, use [cis-evidence](../cis-evidence/SKILL.md) to map the correct request flow to its full JobId and read bounded job/task snapshots. Match cloud and attempt, preserve reporting delay and unavailable reads, and keep missing runtime logs explicit. Snapshot state alone does not establish root cause or downstream fulfillment.
   For EV2 failures, read [rollout-status](../rollout-status/SKILL.md) and use
   `--tree --json` on the supplied rollout. Preserve the child rollout ID,
   resource/action, correlation ID, execution time and nested evidence source
   path. Empty action-level `ErrorInfo` does not mean the failure log is absent.
   Read `evidence` for resource errors and Shell logs, and report any truncation.
   A nonzero script exit or SQL timeout alone does not establish its deeper cause
   or current recovery. Keep diagnostic details in internal investigation output
   under the caller's disclosure rules.
   For Geneva / ACIS failures, use [geneva-execution-logs](../geneva-execution-logs/SKILL.md) with the complete operation URL or execution key from the incident or Lionrock logs. Discover all matching nonzero Geneva ActivityIds before reading Audit and Tracing. Submission, execution and status polls can use different IDs. Do not join Lionrock ActivityTraceId directly to Geneva ActivityId. Verify the extension, operation, attempt and actual outcome, and preserve missing data or truncation. A recorded Failed status does not establish its underlying cause.
   For monitor-raised incidents, use [geneva-metric-evidence](../geneva-metric-evidence/SKILL.md) to read both monitor versions and the matching metric series. Match the actual dimensions, sampling and evaluation window. Preserve missing points and incomplete queries, and do not infer recovery or root cause from a quiet metric.
4. Read the TSG discriminator and test it against the observed case. A quiet log,
   familiar event token or old incident does not prove recovery or benign behavior.
5. For a family, check whether members have different inner exceptions before
   applying one explanation. Use the caller's `ROUTING: hold` contract where present
   if it should not automatically assign that family as one cause.

## Confirm the category and next step

- **Our fault:** identify the concrete code/configuration location and failure
  evidence. Name the needed remediation and any existing defect link. A diagnosed
  defect remains unresolved until the required follow-up is recorded and the fix
  ships. File/link a defect only when the caller permits it and the capability is
  available; otherwise return the exact proposal and outstanding step.
- **Dependency fault:** name the boundary and quote the inner error that establishes
  it. Use the existing ownership evidence/TSG for the proposed team; do not infer
  that the person who closed a similar incident still owns every case. Routing or
  transfer is complete only after an authorized action is verified.
- **Benign condition:** when investigation supports it, use
  [resolve-incident-noise](../resolve-incident-noise/SKILL.md) with the gathered
  evidence. Do not close an incident merely because its category changed.
- **Unsettled cause:** keep the category tentative, report what is known and what
  evidence is missing. Required unavailable reads use the caller's operator-log
  contract. Do not classify an unavailable source as an external fault.

The ability to read one request does not establish the full set of customers
affected by an alert. If the item requires monitor-to-request impact correlation
and no installed resolver supports it, return that capability gap to the classifier
instead of claiming `Internal.CustomerBlocked` has been resolved.

## Deliver through the caller

For internal drafts containing KQL, follow the query-link presentation in
[kusto-query](../kusto-query/SKILL.md). Each query needs a clickable link to its
verified cluster/database immediately above the code block, with Open query when
available. Preserve these links in the draft returned to the adapter.

If the caller requires an IcM `CATEGORY` disposition, read
`oncall/concepts/icm-categories.md` through `wiki-query` and verify its discriminator.
This field is separate from the `Internal.*` business category. A machine's
"watchdogs healthy" mitigation is not proof that the affected request recovered;
check the actual condition and current hits. Use the caller's `Unclassified` value
when evidence does not settle a disposition.

For the Loop IcM adapter, return the draft/recommendation in its existing format;
the adapter owns routing and delivery. Do not separately comment, assign, resolve,
tag or send. For operator-log outcomes, return only the log block, without draft
or recommendation lines that would invalidate its format.

In a directly authorized investigation, perform only the actions the user already
authorized using the corresponding capability; preserve its confirmation rules.
For a diagnosed Lionrock defect the user explicitly asked to fix, use
[lionrock-fix-pr](../lionrock-fix-pr/SKILL.md), which retains its developer gate,
worktree and verification workflow. Diagnosis by itself does not authorize a PR.
For a production retry use the separate assessment/execution workflows; never use
a retry as an investigative probe.
