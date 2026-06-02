#!/usr/bin/env bash
# Query OS package versions (dpkg / apk / rpm) installed in a container image in betprod ACR.
# Usage: ./query-os-packages.sh <repo>[:tag|@digest] [filter]
#   If no tag/digest given, uses the most recent digest.
#   e.g. ./query-os-packages.sh ko
#        ./query-os-packages.sh ko@sha256:6dbf71b...
#        ./query-os-packages.sh ko latest openssl

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

REPO="${REPO#betprod.azurecr.io/}"

relogin >/dev/null 2>&1

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
crane export "$IMAGE" "$WORK/img.tar" 2>/dev/null
mkdir -p "$WORK/fs"
tar -xf "$WORK/img.tar" -C "$WORK/fs" 2>/dev/null || true

emit() {
  local mgr="$1" name="$2" ver="$3"
  if [[ -n "$FILTER" && "$name" != *"$FILTER"* ]]; then
    return
  fi
  printf '%s\t%s\t%s\n' "$mgr" "$name" "$ver"
}

# dpkg (Debian / Ubuntu)
if [[ -f "$WORK/fs/var/lib/dpkg/status" ]]; then
  echo "[*] Parsing dpkg status..." >&2
  awk '
    /^Package: / { pkg=$2 }
    /^Version: / { ver=$2; if (pkg!="") print "dpkg\t" pkg "\t" ver; pkg=""; ver="" }
    /^$/ { pkg=""; ver="" }
  ' "$WORK/fs/var/lib/dpkg/status" | while IFS=$'\t' read -r mgr name ver; do
    emit "$mgr" "$name" "$ver"
  done
fi

# apk (Alpine)
if [[ -f "$WORK/fs/lib/apk/db/installed" ]]; then
  echo "[*] Parsing apk db..." >&2
  awk '
    /^P:/ { pkg=substr($0,3) }
    /^V:/ { ver=substr($0,3); if (pkg!="") print "apk\t" pkg "\t" ver; pkg=""; ver="" }
    /^$/ { pkg=""; ver="" }
  ' "$WORK/fs/lib/apk/db/installed" | while IFS=$'\t' read -r mgr name ver; do
    emit "$mgr" "$name" "$ver"
  done
fi

# rpm (Red Hat / Mariner / Azure Linux) — skipped: would need rpm tool against BDB/sqlite
if [[ -d "$WORK/fs/var/lib/rpm" ]]; then
  echo "[!] rpm database found but not parsed (requires rpm tool)" >&2
fi
REMOTE
