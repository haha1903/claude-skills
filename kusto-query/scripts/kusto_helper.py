#!/usr/bin/env python3
"""
Shared Kusto query helper using Azure CLI authentication.
Uses curl as HTTP backend (more reliable SSL handling than Python 3.14 urllib).

Usage:
    from kusto_helper import query_kusto, list_tables, show_schema
"""

import subprocess
import json
import sys


def get_token(cluster_url):
    """Get access token via az cli for a Kusto cluster."""
    result = subprocess.run(
        ["az", "account", "get-access-token",
         "--resource", cluster_url,
         "--query", "accessToken", "-o", "tsv"],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        print(f"[ERROR] Failed to get token: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return result.stdout.strip()


def _http_post(url, token, body_dict, timeout=120):
    """Execute HTTP POST via curl for reliable SSL handling."""
    body = json.dumps(body_dict)
    result = subprocess.run(
        ["curl", "-s", "-X", "POST", url,
         "-H", f"Authorization: Bearer {token}",
         "-H", "Content-Type: application/json",
         "-d", body,
         "--max-time", str(timeout)],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        raise RuntimeError(f"curl failed (exit {result.returncode}): {result.stderr}")
    if not result.stdout.strip():
        raise RuntimeError(f"Empty response. stderr: {result.stderr}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"Non-JSON response: {result.stdout[:500]}")


def query_kusto(cluster_url, database, kql, timeout=120):
    """
    Execute a KQL query against a Kusto cluster using REST API v2.

    Returns (cols, rows) where rows is list of dicts.
    """
    token = get_token(cluster_url)
    url = f"{cluster_url}/v2/rest/query"
    data = _http_post(url, token, {"db": database, "csl": kql}, timeout)

    for frame in data:
        if frame.get("FrameType") == "DataTable" and frame.get("TableKind") == "PrimaryResult":
            cols = [c["ColumnName"] for c in frame["Columns"]]
            rows = [dict(zip(cols, row)) for row in frame["Rows"]]
            return cols, rows

    return [], []


def mgmt_kusto(cluster_url, database, command, timeout=120):
    """
    Execute a management command (.show, .create, etc.) using REST API v1.

    Returns (cols, rows) where rows is list of dicts.
    """
    token = get_token(cluster_url)
    url = f"{cluster_url}/v1/rest/mgmt"
    data = _http_post(url, token, {"db": database, "csl": command}, timeout)

    table = data.get("Tables", [{}])[0]
    cols = [c["ColumnName"] for c in table.get("Columns", [])]
    rows = [dict(zip(cols, row)) for row in table.get("Rows", [])]
    return cols, rows


def list_tables(cluster_url, database):
    """List all tables in a database."""
    cols, rows = mgmt_kusto(cluster_url, database, ".show tables")
    return rows


def show_schema(cluster_url, database, table_name):
    """Show schema of a specific table."""
    cols, rows = mgmt_kusto(
        cluster_url, database,
        f".show table {table_name} schema as json"
    )
    if rows:
        schema = json.loads(rows[0].get("Schema", "{}"))
        return schema.get("OrderedColumns", [])
    return []


def print_results(cols, rows, title=""):
    """Pretty-print query results."""
    if title:
        print(f"\n{'='*80}")
        print(f"  {title}")
        print(f"{'='*80}")

    if not rows:
        print("  (no results)")
        return

    print(f"  Rows: {len(rows)} | Columns: {', '.join(cols)}\n")
    for i, row in enumerate(rows, 1):
        print(f"  --- Row {i} ---")
        for col in cols:
            val = str(row.get(col, ""))
            if len(val) > 120:
                val = val[:120] + "..."
            print(f"    {col:35}: {val}")
    print()
