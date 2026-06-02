---
name: kusto-dashboard
description: Use when programmatically managing ADX / Kusto dashboards at dataexplorer.azure.com — create dashboards, add/rename/delete pages, manage data sources, generate deep links, or batch-generate dashboards from templates. Covers the undocumented dashboards.kusto.windows.net REST API, its JSON schema, and reusable Python helpers.
---

# Kusto Dashboard

## Overview

Programmatically manage Azure Data Explorer dashboards (`https://dataexplorer.azure.com/dashboards`). The service has **no public REST API**, but its web UI hits a stable internal endpoint at `https://dashboards.kusto.windows.net` — this is what we use.

Every write is a **full-payload `PUT`** protected by an `eTag`; the canonical edit flow is:
```
GET /dashboards/{id}  →  mutate JSON in memory  →  PUT /dashboards/{id} (with eTag)
```

For non-trivial work, write Python that imports `kd_lib` (see below) rather than shelling out to the `kd` CLI — the library gives you direct, composable mutation primitives.

## Authentication

The audience is a fixed GUID (the Dashboards service app id), **not** the Kusto cluster URL.

```python
import subprocess
DASHBOARDS_AUD = "35e917a9-4d95-4062-9d97-5781291353b9"

def get_token():
    return subprocess.run(
        ["az", "account", "get-access-token",
         "--resource", DASHBOARDS_AUD,
         "--query", "accessToken", "-o", "tsv"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
```

The JWT's `oid` claim is the current user's object id — handy to filter "dashboards I created":
```python
import base64, json
payload = token.split(".")[1] + "="  # pad for urlsafe b64
my_oid = json.loads(base64.urlsafe_b64decode(payload + "==")).get("oid")
```

## REST API

Base: `https://dashboards.kusto.windows.net`

| Verb | Path | Purpose |
|---|---|---|
| `GET` | `/catalog/entries` | Light list: `[{id, title, createdAt, createdBy, openedAt}, ...]` |
| `GET` | `/dashboards/{id}` | Full JSON (includes `eTag`) |
| `POST` | `/dashboards` | Create — body omits `id`/`eTag`, server assigns |
| `PUT` | `/dashboards/{id}` | **Full replacement**; body must carry the current `eTag` (optimistic lock) |
| `DELETE` | `/dashboards/{id}` | Remove the dashboard itself |
| `DELETE` | `/catalog/entries/{id}` | Remove the **catalog index** entry — **required** after deleting a dashboard, server does NOT cascade |

Stdlib request helper (no `requests` dependency):
```python
import json, urllib.request, urllib.error
BASE = "https://dashboards.kusto.windows.net"

def api(method, path, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req) as r:
            raw = r.read().decode() or "null"
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read().decode()}")
```

## Dashboard JSON schema (v74)

```python
{
  "schema_version": 74,
  "id": "<GUID>",                  # server-assigned on POST
  "eTag": "<GUID>",                # changes on every PUT; required on PUT
  "title": "...",
  "dataSources": [                  # each name MUST be unique within the dashboard
    {"id": "<GUID>", "kind": "manual-kusto",
     "name": "agboa",
     "clusterUri": "https://agboa.westus2.kusto.windows.net/",
     "database": "BET"}
  ],
  "pages": [
    {"id": "<GUID>", "name": "Regions"}
  ],
  "queries": [
    {"id": "<GUID>", "text": "AzureRegion | take 10", "usedVariables": [],
     "dataSource": {"kind": "inline", "dataSourceId": "<dataSources[].id>"}}
  ],
  "tiles": [
    {"id": "<GUID>", "title": "Regions", "visualType": "table",
     "pageId": "<pages[].id>",
     "layout": {"x": 0, "y": 0, "width": 24, "height": 21},   # 24-column grid
     "queryRef": {"kind": "query", "queryId": "<queries[].id>"},
     "visualOptions": { /* visual-specific; see below */ }}
  ],
  "baseQueries": [],                # like queries, but not bound to a tile
  "parameters": [                   # dashboard-level (e.g. the default time range)
    {"kind": "duration", "id": "<GUID>",
     "displayName": "Time range", "description": "",
     "beginVariableName": "_startTime", "endVariableName": "_endTime",
     "defaultValue": {"kind": "dynamic", "count": 1, "unit": "hours"},
     "showOnPages": {"kind": "all"}}
  ]
}
```

**Cross-id invariants** — every integrity rule to preserve when mutating JSON by hand:

- `tile.pageId` ∈ `pages[].id`
- `tile.queryRef.queryId` ∈ `queries[].id`
- `query.dataSource.dataSourceId` ∈ `dataSources[].id`
- `dataSources[].name` unique within the dashboard
- When removing a page: drop its tiles, their queries, and any now-orphaned data sources

**Deep link to a specific page:**
```
https://dataexplorer.azure.com/dashboards/{dashboard_id}?p-_startTime=1hours&p-_endTime=now#{page_id}
```

## Reusable Python library: `kd_lib`

Lives at `/Users/haichang/bin/kd_lib/`. Prefer it over reimplementing — it already handles token caching, eTag plumbing, name uniqueness, and orphan cleanup.

```python
import sys; sys.path.insert(0, "/Users/haichang/bin")
from kd_lib import api, dashboard as D
from kd_lib.auth import get_token, get_my_oid
from kd_lib.config import DASHBOARD_URL, PAGE_LINK_URL
```

### Core helpers

```python
# HTTP
api.list_dashboards()             # [{id, title, createdAt, createdBy, openedAt}, ...]
api.get_dashboard(id)             # full JSON dict
api.create_dashboard(body)        # POST; returns body with server-assigned id/eTag
api.update_dashboard(id, body)    # PUT; returns body with new eTag
api.delete_dashboard(id)          # DELETE

# Dashboard JSON mutations (all mutate in place; pure Python, no network)
D.empty_dashboard(title)                        # minimal valid body for POST
D.suggest_ds_name(cluster_uri)                  # "agboa" from "https://agboa.westus2..."
D.find_data_source(d, cluster, db)              # match by (cluster, db)
D.find_data_source_by_name(d, name)             # match by name
D.make_unique_ds_name(d, base)                  # "agboa" -> "agboa-2" if taken
D.add_data_source(d, cluster, db, name)         # append; returns ds dict
D.add_page(d, page_name, ds_id, query_text, visual_type="table")
D.remove_page(d, page_id)                       # cascades: tiles + queries + orphan ds
D.rename_page(d, page_id, new_name)             # updates page.name only (not tile.title)
D.find_page(d, name_or_id)
D.page_query_preview(d, page_id)                # first line of the tile's query text
```

### Recipe: create a dashboard with two pages

```python
import sys; sys.path.insert(0, "/Users/haichang/bin")
from kd_lib import api, dashboard as D

d = D.empty_dashboard("Capacity Overview")

ds = D.add_data_source(d,
    cluster="https://agboa.westus2.kusto.windows.net/",
    database="BET", name="agboa")

D.add_page(d, "Regions", ds["id"], "AzureRegion | take 100")
D.add_page(d, "Clusters", ds["id"], "BET_Clusters | summarize count() by region")

created = api.create_dashboard(d)
print(created["id"])
```

### Recipe: idempotent "ensure page exists" with retry on eTag conflict

```python
def ensure_page(dashboard_id, page_name, cluster, database, query):
    for attempt in range(3):
        d = api.get_dashboard(dashboard_id)
        if D.find_page(d, page_name):
            return  # already there

        ds = (D.find_data_source(d, cluster, database)
              or D.add_data_source(d, cluster, database,
                    D.make_unique_ds_name(d, D.suggest_ds_name(cluster))))

        D.add_page(d, page_name, ds["id"], query)
        try:
            api.update_dashboard(dashboard_id, d)
            return
        except RuntimeError as e:
            if "412" in str(e) or "409" in str(e):
                continue  # someone else won; re-read and retry
            raise
    raise RuntimeError("eTag conflict after 3 retries")
```

### Recipe: copy a page from one dashboard to another

Because every intra-dashboard reference is a fresh GUID, cloning = regenerate ids + rewrite refs.

```python
import uuid

def copy_page(src_id, src_page_name, dst_id):
    src = api.get_dashboard(src_id)
    dst = api.get_dashboard(dst_id)

    page = next(p for p in src["pages"] if p["name"] == src_page_name)
    tiles = [t for t in src["tiles"] if t["pageId"] == page["id"]]
    query_ids = {t["queryRef"]["queryId"] for t in tiles}
    queries = [q for q in src["queries"] if q["id"] in query_ids]
    ds_ids = {q["dataSource"]["dataSourceId"] for q in queries}
    sources = [ds for ds in src["dataSources"] if ds["id"] in ds_ids]

    # Rewrite ids, ensuring dst data-source names stay unique.
    id_map = {}
    for ds in sources:
        new_id = str(uuid.uuid4())
        id_map[ds["id"]] = new_id
        new_ds = {**ds, "id": new_id,
                  "name": D.make_unique_ds_name(dst, ds["name"])}
        # Only append if (cluster, db) is new in dst; else reuse existing.
        match = D.find_data_source(dst, ds["clusterUri"], ds["database"])
        if match:
            id_map[ds["id"]] = match["id"]
        else:
            dst["dataSources"].append(new_ds)

    new_page_id = str(uuid.uuid4())
    dst["pages"].append({"id": new_page_id, "name": page["name"]})

    for q in queries:
        new_qid = str(uuid.uuid4())
        id_map[q["id"]] = new_qid
        dst["queries"].append({**q, "id": new_qid,
            "dataSource": {**q["dataSource"],
                           "dataSourceId": id_map[q["dataSource"]["dataSourceId"]]}})

    for t in tiles:
        dst["tiles"].append({**t, "id": str(uuid.uuid4()),
            "pageId": new_page_id,
            "queryRef": {**t["queryRef"],
                         "queryId": id_map[t["queryRef"]["queryId"]]}})

    api.update_dashboard(dst_id, dst)
```

### Recipe: list only dashboards the current user created

```python
my_oid = get_my_oid()
mine = [e for e in api.list_dashboards() if e.get("createdBy") == my_oid]
```

### Recipe: deep link for every page in a dashboard

```python
d = api.get_dashboard(dashboard_id)
for p in d["pages"]:
    print(PAGE_LINK_URL.format(dashboard_id=dashboard_id, page_id=p["id"]),
          "-", p["name"])
```

## Running kd_lib from arbitrary projects

When `~/bin` is not on `PYTHONPATH`, either:

```python
import sys; sys.path.insert(0, "/Users/haichang/bin")
from kd_lib import api, dashboard as D
```

or spawn a helper script inline with `subprocess`. `kd_lib` is stdlib-only — no `pip install` needed.

## Fallback: no library, no `kd` CLI

If neither is available (e.g. running on a fresh machine), the three recipes above still work — inline `get_token()` + `api()` from the "Authentication" and "REST API" sections. Schema from this doc + `uuid.uuid4()` for ids is enough to build any dashboard.

## Troubleshooting

- **409 / 412 (eTag conflict)** — dashboard changed between your GET and PUT. Re-read, re-apply your mutation, retry (see "ensure page exists" recipe).
- **403 forbidden on PUT/DELETE** — you have read access but not write. `list_dashboards()` returns everything you can *see*, not everything you can *mutate*. Default to `createdBy == my_oid` when picking a target.
- **401 invalid_token** — clear cache and re-fetch; or `az login`.
- **Wrong audience** — must be `35e917a9-4d95-4062-9d97-5781291353b9`. A token for the Kusto cluster itself (`https://*.kusto.windows.net`) will **not** work here.
- **Dashboard won't load in UI after PUT** — almost always a broken cross-reference: a tile pointing at a deleted query, or duplicate `dataSources[].name`. Re-GET and diff against your local copy. Use `D.remove_page` (which cascades) rather than manual splicing.
- **`schema_version` mismatch** — the UI currently ships v74. Older versions auto-migrate on first open, but generating against a stale schema risks feature loss. Prefer re-exporting a fresh template when the UI updates.
