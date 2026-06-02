#!/usr/bin/env bash
# List all repositories in betprod ACR.
set -euo pipefail

kubectl exec -i deploy/azure-cli -n default -- bash -s <<'REMOTE'
set -euo pipefail
relogin >/dev/null
az acr repository list --name betprod -o tsv
REMOTE
