---
name: kusto-grant-permission
description: Use when granting, revoking, or listing database-level permissions on an Azure Data Explorer (Kusto) cluster — covers admins / users / viewers roles for AAD users, groups, and service principals, using .add / .drop / .show control commands
---

# Kusto Grant Permission

## Overview

Kusto permissions are managed via **control commands** (`.add` / `.drop` / `.show`) at the database level. This skill covers the three most-used roles (`admins`, `users`, `viewers`) and the standard workflow: **show → change → show to confirm**.

For cluster-level or table-level permissions, or for richer roles (`ingestors`, `unrestrictedviewers`, `monitors`), adapt the same syntax — the principal format is identical.

## Role Quick Reference (database level)

| Role      | Can do                                                       |
|-----------|--------------------------------------------------------------|
| `admins`  | Everything: read, write, create/drop tables, manage principals |
| `users`   | Create tables/functions, write data, read data               |
| `viewers` | Read data only (query + `.show` commands)                    |

## Principal Syntax (MS tenant)

MS tenant id: `72f988bf-86f1-41af-91ab-2d7cd011db47`

| Principal       | Syntax                                                                    |
|-----------------|---------------------------------------------------------------------------|
| AAD user        | `'aaduser=alice@microsoft.com'`                                           |
| AAD group       | `'aadgroup=<group-object-id>;72f988bf-86f1-41af-91ab-2d7cd011db47'`       |
| Service principal | `'aadapp=<app-id>;72f988bf-86f1-41af-91ab-2d7cd011db47'`                |

Get AAD group object id from name:
```bash
az ad group show --group "Lionrock OnCall" --query id -o tsv
```

## Standard Workflow: show → change → show

### 1. Show current principals

```kusto
.show database MyDatabase principals
```

Filter to one role:
```kusto
.show database MyDatabase principals | where Role == "Database Admin"
```
(`Role` values: `Database Admin`, `Database User`, `Database Viewer`.)

### 2. Add a principal

```kusto
// User → admin
.add database MyDatabase admins ('aaduser=alice@microsoft.com') 'On-call rotation'

// Group → user (recommended — manage membership in AAD, not here)
.add database MyDatabase users ('aadgroup=<group-object-id>;72f988bf-86f1-41af-91ab-2d7cd011db47') 'Lionrock team write access'

// Service principal → viewer
.add database MyDatabase viewers ('aadapp=<app-id>;72f988bf-86f1-41af-91ab-2d7cd011db47') 'bet-prod read-only'
```

Swap `admins` / `users` / `viewers` for the role you want. The trailing quoted string is a free-form note — always include a reason, it shows up in audit.

### 3. Drop a principal

```kusto
.drop database MyDatabase admins ('aaduser=alice@microsoft.com')
.drop database MyDatabase users  ('aadgroup=<group-object-id>;72f988bf-86f1-41af-91ab-2d7cd011db47')
.drop database MyDatabase viewers ('aadapp=<app-id>;72f988bf-86f1-41af-91ab-2d7cd011db47')
```

### 4. Confirm with show

Always re-run `.show database MyDatabase principals` after an `.add` or `.drop` to verify the change landed. Kusto returns the updated list immediately; if the principal you added/removed isn't there, the command silently didn't do what you expected (usually a typo in the principal id).

## Safety

- **Never use `.set`** — `.set database ... admins (...)` **replaces the entire admin list** with what you passed. It will wipe every other admin. Always use `.add`. Same trap for `users` and `viewers`.
- **Caller needs admin rights** on the database (or on the cluster) to run `.add` / `.drop` on principals.
- **Group > user** when possible — adding a person directly means you need another `.add` / `.drop` when they join/leave the team. Put them in an AAD group and grant the group once.

## How to Execute

Pick whichever is convenient:

**Web UI (simplest):** open `https://dataexplorer.azure.com`, connect to the cluster, select the database, paste the command, run.

**REST API via `kusto-query` skill:** use the management endpoint `POST {cluster_url}/v1/rest/mgmt` with the control command as `csl`. See the `kusto-query` skill for the full curl / `kusto_helper.mgmt_kusto(...)` pattern.

**Azure CLI (kusto extension):**
```bash
az kusto database-principal-assignment create \
  --cluster-name MyCluster --database-name MyDatabase \
  --resource-group MyRG \
  --principal-assignment-name alice-admin \
  --principal-id alice@microsoft.com --principal-type User \
  --role Admin --tenant-id 72f988bf-86f1-41af-91ab-2d7cd011db47
```
(ARM-based, slower, creates a persistent named assignment — usually overkill for a one-off grant. Prefer `.add` via web UI or REST.)

## Troubleshooting

- **`Forbidden` / `Principal ... is not authorized`** — caller isn't a DB admin. Ask an existing admin, or escalate to cluster admin.
- **`.add` ran but principal doesn't show in `.show`** — principal syntax typo (wrong tenant id, wrong app id, missing semicolon). Re-check the `aadgroup=...;<tenant>` format.
- **User can authenticate but can't query** — they were added as `admins` on the wrong database, or the cluster has additional row-level security. Check `.show database <DB> principals` on the exact DB they're hitting.
