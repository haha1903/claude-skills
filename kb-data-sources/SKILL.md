---
name: kb-data-sources
description: Use BEFORE querying any Lionrock/BET/IcM data source (Kusto clusters agboa/betprod/icmcluster, IcM OData, Geneva) to get the mandatory filters, real field semantics, and known false signals for that source. Also read this before answering any question about billing meters, product onboarding, caymanProductId/bigId, productOid, whether a product ever submitted a request, or the status of a MIX/CMX/azure-ratecard meterCreationJobs tracking id. Read it when a query returns 0 rows, a suspiciously clean number, or before drawing any conclusion from query output.
---

# Data sources: mandatory filters and false signals

Per-source cards for every data source we query. Each card answers three
questions that a schema cannot:

1. **What filter is mandatory** (omitting it silently mixes unrelated data)
2. **What the fields actually mean** (vs what their names suggest)
3. **What false signals this source produces** (numbers that look meaningful and are not)

## How to use this

Read the card for your source **before** the first query, not after it looks
wrong. Every entry below was written after a wrong conclusion shipped.

If a source is not here, add a card after you finish querying it. A card is
cheap; re-deriving a gotcha costs a day.

## Cards

| Source | Card |
|---|---|
| `agboa.westus2` / `lionrock` / `Log` — Lionrock app logs | [lionrock-log.md](references/lionrock-log.md) |
| `icmcluster` / `IcMDataWarehouse` — IcM reporting | [icm-warehouse.md](references/icm-warehouse.md) |
| IcM OData REST — single-incident read/write | [icm-odata.md](references/icm-odata.md) |
| `betprod.westus2` / `Lionrock` — request/plan external tables | [betprod.md](references/betprod.md) |
| `betprod.westus2` / `BET` — billing meters, product onboarding | [betprod-bet-db.md](references/betprod-bet-db.md) |
| MIX / azure-ratecard API — meter creation + tracking, PME auth | [mix-ratecard-api.md](references/mix-ratecard-api.md) |
| `genevaactions` / `Production` — Geneva / ACIS execution logs | [geneva-logs.md](references/geneva-logs.md) |
| `kusto-query` helper CLI — the wrapper, not a source | [kusto-query-cli.md](references/kusto-query-cli.md) |

## The two rules that generalise

**A 0-row result is not evidence of absence until the query is proven to work.**
Run `| take 1` or `| count` with the filters stripped first. Wrong column name,
wrong enum spelling, and HTTP 400 all present as "no data". This has produced a
false all-clear at least four times: `Status eq 'RESOLVED'`, `IncidentId` vs
`Id`, a text search that missed rows, and a `State eq 'Active'` list query that
hid 37 unacknowledged incidents while reporting 0 remaining.

**When the answer means less work, look for a counterexample before reporting
it.** "Cannot be done", "0 remaining", and "tests pass" are the three shapes
that turn out wrong most often, because the false answer is the convenient one.
