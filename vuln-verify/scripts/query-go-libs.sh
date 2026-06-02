#!/usr/bin/env bash
# Query all Go module dependencies embedded in binaries of a container image in betprod ACR.
# Usage: ./query-go-libs.sh <repo>[:tag|@digest] [filter]
#   If no tag/digest given, uses the most recent digest.
#   e.g. ./query-go-libs.sh tektoncd/pipeline/webhook
#        ./query-go-libs.sh capacity-service:20260101.v1
#        ./query-go-libs.sh tektoncd/pipeline/webhook@sha256:abcd...
#        ./query-go-libs.sh tektoncd/pipeline/webhook latest go-jose

set -euo pipefail

REPO="${1:-}"
if [[ -z "$REPO" ]]; then
  echo "Usage: $0 <repo>[:tag|@digest] [filter]" >&2
  exit 1
fi
FILTER="${2:-}"

kubectl exec -i deploy/azure-cli -n default -- bash -s -- "$REPO" "$FILTER" <<'REMOTE'
set -euo pipefail
REPO="$1"
FILTER="$2"

# Strip betprod.azurecr.io/ prefix if user included it
REPO="${REPO#betprod.azurecr.io/}"

relogin >/dev/null 2>&1

# If no tag/digest given, resolve to latest digest
if [[ "$REPO" != *:* && "$REPO" != *@* ]]; then
  BARE="$REPO"
  DIGEST=$(az acr manifest list-metadata --name "$BARE" --registry betprod \
    --orderby time_desc --top 1 --query '[0].digest' -o tsv 2>/dev/null)
  if [[ -z "$DIGEST" ]]; then
    echo "No manifests found for repo: $BARE" >&2
    exit 1
  fi
  REPO="${BARE}@${DIGEST}"
fi

IMAGE="betprod.azurecr.io/${REPO}"
echo "[*] Image: $IMAGE" >&2

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

echo "[*] Exporting image filesystem..." >&2
crane export "$IMAGE" "$WORK/img.tar"
mkdir -p "$WORK/fs"
tar -xf "$WORK/img.tar" -C "$WORK/fs" 2>/dev/null || true

echo "[*] Scanning for Go binaries..." >&2
find "$WORK/fs" -type f -executable 2>/dev/null | while read -r bin; do
  if ! grep -l -a "Go buildinf" "$bin" >/dev/null 2>&1; then
    continue
  fi
  rel="${bin#$WORK/fs/}"
  echo ""
  echo "=== /$rel ==="
  if [[ -n "$FILTER" ]]; then
    strings "$bin" | grep -E "^dep[[:space:]]+" | grep -- "$FILTER" || echo "(no matches for '$FILTER')"
  else
    strings "$bin" | grep -E "^(mod|dep|=>)[[:space:]]+" | sort -u
  fi
done
REMOTE
