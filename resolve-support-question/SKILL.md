---
name: resolve-support-question
description: Use for general Lionrock or Region Access and Quota product concepts and expected behavior outside a dedicated workflow resolver's scope. Execution Plan approval, status and Action Required questions belong to the plan resolver even without a link or identifiers. Specific request status, failures, approvals and action requests use their business resolver. Read-only.
summary: Answer a product or expected-behavior question with evidence
handles: [Ask.HowItWorks]
---

# Resolve a product explanation question

Use [oncall-reply](../oncall-reply/SKILL.md) to read the original question and
available replies. This resolver owns whether the explanation is supported and
what remains unknown; the reply helper owns context access and presentation.

## Find and verify the explanation

Choose a workflow-specific resolver before a generic wiki explanation when its
description covers the question, including conceptual questions. Missing required
identifiers are for that resolver to establish; they do not turn a workflow status
report into a generic question. Keep a source's object and workflow scope intact:
an On-demand request state does not establish an Execution Plan's next actor.

Use [wiki-query](../wiki-query/SKILL.md) over the relevant `s360-docs`, `oncall`
and `lionrock` wikis under `WIKI_ROOT`. Navigate through their indexes and follow
the query skill's `searchRaw` rules. A task's narrower list of suggested wikis
does not itself make the other mounted wikis unavailable.

For an expected-behavior claim, read the page's discriminator and check the
condition against the supplied case using permitted capabilities. If it requires
a request ID, subscription, region or exact error that is missing, ask for that
input and say why it is needed. Do not treat a plausible page match as a diagnosis.

For knowledge outside our service, use the authoritative documentation when
reachable. On the host, eng.ms is accessed through the installed browser skill.
The Loop pod has previously received an origin-based 403 from eng.ms; use mounted
wiki evidence there and report a required source as unavailable if the read fails.
An official source that contradicts the wiki takes precedence; note the divergence.

If the question turns out to require this request's current status or a failure
investigation, hand over the collected context to the matching business resolver.
This skill is not the default for every question that lacks a match.

## Answer or expose the knowledge gap

Give the explanation and a cited page, plus the verified condition for any claim
that the behavior is expected. Use the caller's audience and reply format. For a
support draft, avoid exposing internal wiki paths; use a suitable shareable source
or state the verification limit.

If no source supports an answer, identify the missing knowledge precisely. The
wiki query log records `answered=false`; this is a knowledge gap within a matching
resolver, not proof that no resolver exists. Give a partial answer and the missing
input/evidence in the caller's format. When a required source is inaccessible,
use its `resolver_unavailable` contract. Name an owning team only when supported,
and do not promise a follow-up that has not been arranged.

Return the answer, without a separate message, incident mutation or wiki-content
write. The query helper's existing local query log is still used.
