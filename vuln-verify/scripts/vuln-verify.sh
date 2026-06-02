#!/usr/bin/env bash
# vuln-verify.sh - Verify Go vulnerability reports against the LATEST image in ACR.
#
# Strips tag/digest from each reported image ref and checks the repo's latest
# digest. Use case: after a fix has been deployed, confirm the current image no
# longer contains the vulnerable module versions.
#
# Usage:
#   ./vuln-verify.sh report.txt
#   cat report.txt | ./vuln-verify.sh
#
# Input format (whitespace-separated, one record per line):
#   <module> v<vuln-ver> <fixed-ver> Go <binary> <image-ref>
# Lines without a betprod.azurecr.io image ref are ignored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERY="$SCRIPT_DIR/query-go-libs.sh"
INPUT="${1:-/dev/stdin}"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Extract (module, fixed_version, repo) triples -- repo has prefix + digest/tag stripped.
awk '{
  img=""
  for (i=NF; i>=1; i--) if ($i ~ /^betprod\.azurecr\.io\//) { img=$i; break }
  if (img == "") next
  sub(/^betprod\.azurecr\.io\//, "", img)
  sub(/@sha256:.*$/, "", img)
  sub(/:[^\/]+$/, "", img)
  print $1 "|" $3 "|" img
}' "$INPUT" | sort -u > "$TMP/records.txt"

cut -d'|' -f3 "$TMP/records.txt" | sort -u > "$TMP/repos.txt"

# semver a >= b ; strips leading 'v'
semver_ge() {
  local a="${1#v}" b="${2#v}"
  [[ "$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -1)" == "$a" ]]
}

echo "=== Vulnerability Verification Report (against most recent ACR digest per repo) ==="
echo ""

while read -r repo; do
  echo "--- $repo (most recent digest) ---"

  if ! "$QUERY" "$repo" >"$TMP/libs.txt" 2>"$TMP/err.txt"; then
    if grep -qE "MANIFEST_UNKNOWN|No manifests found" "$TMP/err.txt"; then
      echo "  [REPO GONE]   no manifests in ACR for this repo"
    else
      echo "  [ERROR]       $(head -1 "$TMP/err.txt")"
    fi
    echo ""
    continue
  fi

  grep -F "|$repo" "$TMP/records.txt" | while IFS='|' read -r module fixed _; do
    current=$(awk -v m="$module" '$1=="dep" && $2==m {print $3; exit}' "$TMP/libs.txt")
    if [[ -z "$current" ]]; then
      echo "  [NOT PRESENT] $module  (not in any binary of latest image)"
    elif semver_ge "$current" "$fixed"; then
      echo "  [FIXED]       $module  current=$current  required>=$fixed"
    else
      echo "  [VULNERABLE]  $module  current=$current  required>=$fixed"
    fi
  done
  echo ""
done < "$TMP/repos.txt"
