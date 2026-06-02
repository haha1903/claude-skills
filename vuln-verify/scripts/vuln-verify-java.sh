#!/usr/bin/env bash
# vuln-verify-java.sh - Verify Java jar vulnerability reports against the LATEST image in ACR.
#
# Looks up each reported <groupId:artifactId> inside every jar in the most recent
# digest of each repo (including nested fat/shaded jars).
#
# Usage:
#   ./vuln-verify-java.sh report.txt
#   pbpaste | ./vuln-verify-java.sh
#
# Input format (whitespace-separated, one record per line):
#   <groupId:artifactId> <vuln-ver> <fixed-ver> Java <jar-path> <image-ref>
# Lines without a betprod.azurecr.io image ref are ignored.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERY="$SCRIPT_DIR/query-java-jars.sh"
INPUT="${1:-/dev/stdin}"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Extract (ga, fixed_version, repo) triples. Strip registry prefix and tag/digest
# so we verify against the most recent image.
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

# Maven-ish version comparison. Handles common qualifiers (RELEASE/Final/GA -> 0,
# milestone/RC/beta/alpha -> negative weights). Good enough for scanner outputs
# like 1.0.45 vs 1.2.8, or 2.25.0 vs 2.25.3.
semver_ge() {
  python3 - "$1" "$2" <<'PY' >/dev/null 2>&1
import sys, re
QUAL = {'snapshot': -5, 'alpha': -4, 'beta': -3, 'milestone': -2, 'm': -2,
        'rc': -1, 'cr': -1, '': 0, 'ga': 0, 'final': 0, 'release': 0}

def tokens(v):
    v = v.lstrip('vV')
    out = []
    for part in re.split(r'[.\-_+]', v):
        if not part: continue
        m = re.match(r'^(\d+)([A-Za-z].*)?$', part)
        if m:
            out.append(('n', int(m.group(1))))
            if m.group(2):
                out.append(('q', m.group(2).lower()))
        else:
            out.append(('q', part.lower()))
    return out

def cmp(a, b):
    ta, tb = tokens(a), tokens(b)
    for i in range(max(len(ta), len(tb))):
        ea = ta[i] if i < len(ta) else ('n', 0)
        eb = tb[i] if i < len(tb) else ('n', 0)
        if ea[0] == eb[0]:
            if ea[0] == 'n':
                if ea[1] != eb[1]: return ea[1] - eb[1]
            else:
                wa = QUAL.get(ea[1], 1); wb = QUAL.get(eb[1], 1)
                if wa != wb: return wa - wb
                if ea[1] != eb[1]: return (ea[1] > eb[1]) - (ea[1] < eb[1])
        else:
            # numeric token beats qualifier-only token at same position
            return 1 if ea[0] == 'n' else -1
    return 0

sys.exit(0 if cmp(sys.argv[1], sys.argv[2]) >= 0 else 1)
PY
}

echo "=== Java Vulnerability Verification (against most recent ACR digest per repo) ==="
echo ""

while read -r repo; do
  echo "--- $repo (most recent digest) ---"

  if ! "$QUERY" "$repo" >"$TMP/jars.txt" 2>"$TMP/err.txt"; then
    if grep -qE "MANIFEST_UNKNOWN|No manifests found" "$TMP/err.txt"; then
      echo "  [REPO GONE]   no manifests in ACR for this repo"
    else
      echo "  [ERROR]       $(head -1 "$TMP/err.txt")"
    fi
    echo ""
    continue
  fi

  grep -F "|$repo" "$TMP/records.txt" | while IFS='|' read -r ga fixed _; do
    # Prefer highest matching version found across all jars in the image.
    current=$(awk -F'\t' -v g="$ga" '$2==g {print $3}' "$TMP/jars.txt" | sort -Vu | tail -1)
    if [[ -z "$current" ]]; then
      echo "  [NOT PRESENT] $ga  (not found in any jar of latest image)"
    elif semver_ge "$current" "$fixed"; then
      echo "  [FIXED]       $ga  current=$current  required>=$fixed"
    else
      echo "  [VULNERABLE]  $ga  current=$current  required>=$fixed"
    fi
  done
  echo ""
done < "$TMP/repos.txt"
