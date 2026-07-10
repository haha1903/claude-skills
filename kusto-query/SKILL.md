---
name: kusto-query
description: Use when querying Azure Data Explorer (Kusto) clusters — covers the iris bin (bin/query.mjs), Azure CLI token auth, and the raw REST query/management endpoints as a fallback
---

# Kusto Query

## Overview

Query any Azure Data Explorer (Kusto) cluster with the signed-in `az` user's token. The primary path is the iris bin below; the raw `curl` REST calls are kept as a fallback for ad-hoc use.

## Run a query (primary path)

```bash
# KQL query
node ~/.claude/skills/kusto-query/bin/query.mjs \
  https://CLUSTER.REGION.kusto.windows.net DATABASE "TableName | take 10"

# Management command
node ~/.claude/skills/kusto-query/bin/query.mjs --mgmt \
  https://CLUSTER.REGION.kusto.windows.net DATABASE ".show tables"
```

Output is JSON `{cols, rows}` (pipe to `jq`). Auth is the signed-in `az` user — run `az login` first, and connect the VPN for internal clusters. The bin calls the iris SDK (`kusto.queryKusto` / `kusto.mgmtKusto`) through `_iris-shared`, auto-building iris on first run.

> The Python helper `scripts/kusto_helper.py` (re-exporting `msapi.kusto`) is
> retained for skills that still import it (e.g. icm-query) and will move to iris
> when the icm module migrates. New code should use the bin above.

## Raw REST (fallback)

## Authentication

```bash
# Get token for a cluster
TOKEN=$(az account get-access-token --resource https://CLUSTER.REGION.kusto.windows.net --query accessToken -o tsv)
```

## REST API Endpoints

**Query (KQL):** `POST {cluster_url}/v2/rest/query`
```bash
curl -s -X POST "https://CLUSTER.REGION.kusto.windows.net/v2/rest/query" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db":"DATABASE","csl":"TableName | take 10"}'
```
Response: array of frames. Primary result is in `FrameType=DataTable, TableKind=PrimaryResult`.

**Management (.show, .create, etc.):** `POST {cluster_url}/v1/rest/mgmt`
```bash
curl -s -X POST "https://CLUSTER.REGION.kusto.windows.net/v1/rest/mgmt" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"db":"DATABASE","csl":".show tables"}'
```
Response: `{ "Tables": [{ "Columns": [...], "Rows": [...] }] }`

## Python helper (legacy, for icm-query only)

`scripts/kusto_helper.py` re-exports `msapi.kusto` (`query_kusto` / `mgmt_kusto` /
`list_tables` / `show_schema`). It is retained only because `icm-query` still
imports it; it moves to iris when the icm module migrates. Do not write new code
against it — use `bin/query.mjs` above.

## Common Management Commands

```kql
.show databases                          // list databases
.show tables                             // list tables
.show table TableName schema as json     // table schema
.show table TableName details            // row count, extent size, etc.
.show materialized-views                 // materialized views
.show functions                          // stored functions
```

## Useful KQL Patterns

```kql
// Row count and time range
Table | summarize Count=count(), Min=min(timestamp), Max=max(timestamp)

// Distinct value count
Table | summarize dcount(ColumnName)

// Cross-cluster query
cluster('other.region.kusto.windows.net').database('DB').Table | take 10

// Ingest from cross-cluster query
.set-or-replace TargetTable <| cluster('source.kusto.windows.net').database('DB').SourceTable | ...

// Create table
.create-merge table TableName (Col1: string, Col2: long, Col3: datetime)
```

## Exploration Template

When exploring an unknown cluster, run these with the bin (pipe through `jq`):

```bash
C=https://CLUSTER.REGION.kusto.windows.net
Q=~/.claude/skills/kusto-query/bin/query.mjs

# 1. Discover databases
node $Q --mgmt $C NetDefaultDB ".show databases" | jq '.rows[].DatabaseName'

# 2. List tables
node $Q --mgmt $C DATABASE ".show tables" | jq '.rows[].TableName'

# 3. Schema + sample for a table
node $Q --mgmt $C DATABASE ".show table TableName schema as json" | jq '.rows[0].Schema | fromjson | .OrderedColumns'
node $Q $C DATABASE "TableName | take 3" | jq
```

## Troubleshooting

- **Token failed:** Run `az login` first, or check cluster URL spelling
- **Empty response:** Cluster may not exist at that address — try different region suffixes
- **Permission denied:** Need "Database Viewer" role on the target database
- **Timeout:** the bin defaults to a 120s timeout; for heavier queries call the SDK directly with a larger `timeout` argument
