---
name: kusto-query
description: Use when querying Azure Data Explorer (Kusto) clusters — covers authentication via Azure CLI token, REST API query/management endpoints, and the msapi.kusto helper (scripts/kusto_helper.py is a compat shim re-exporting it)
---

# Kusto Query

## Overview

Query any Azure Data Explorer (Kusto) cluster using Azure CLI token authentication and REST API. No SDK needed — just `az cli` + `curl`.

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

## msapi.kusto

The implementation lives in the shared `msapi` library (`pip install -e
~/Projects/msapi`). Uses `az cli` + `curl` (avoids Python SSL issues). The old
`scripts/kusto_helper.py` is now a compatibility shim that re-exports from
`msapi.kusto`, so existing `from kusto_helper import …` importers keep working —
but new code should import from `msapi.kusto`.

```python
from msapi.kusto import query_kusto, mgmt_kusto, list_tables, show_schema, print_results

# KQL query — returns (cols, rows) where rows is list of dicts
cols, rows = query_kusto("https://CLUSTER.REGION.kusto.windows.net", "DB", "Table | take 10")

# Management command
cols, rows = mgmt_kusto(CLUSTER_URL, "DB", ".show tables")

# List all tables in a database
tables = list_tables(CLUSTER_URL, "DB")  # returns list of dicts with 'TableName'

# Show table schema
columns = show_schema(CLUSTER_URL, "DB", "TableName")
# Returns: [{"Name": "col", "CslType": "string"}, ...]

# Pretty-print
print_results(cols, rows, "Optional Title")
```

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

When exploring an unknown cluster:

```python
#!/usr/bin/env python3
from msapi.kusto import query_kusto, mgmt_kusto, list_tables, show_schema, print_results

CLUSTER = "https://CLUSTER.REGION.kusto.windows.net"

# 1. Discover databases
cols, rows = mgmt_kusto(CLUSTER, "NetDefaultDB", ".show databases")
print_results(cols, rows, "Databases")

# 2. List tables
tables = list_tables(CLUSTER, "DATABASE")
for t in tables:
    print(t.get("TableName"))

# 3. Schema + sample for a table
schema = show_schema(CLUSTER, "DATABASE", "TableName")
for col in schema:
    print(f"  {col['Name']:35} {col['CslType']}")

cols, rows = query_kusto(CLUSTER, "DATABASE", "TableName | take 3")
print_results(cols, rows, "Sample")
```

## Troubleshooting

- **Token failed:** Run `az login` first, or check cluster URL spelling
- **Empty response:** Cluster may not exist at that address — try different region suffixes
- **Permission denied:** Need "Database Viewer" role on the target database
- **Timeout:** Add `timeout` parameter: `query_kusto(..., timeout=180)`
