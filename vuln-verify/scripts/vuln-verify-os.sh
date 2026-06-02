#!/usr/bin/env bash
# vuln-verify-os.sh - Verify OS-package (dpkg/apk) vulnerability reports against the LATEST image in ACR.
#
# Input format (whitespace-separated, one record per line):
#   <pkg> <vuln-ver> <fixed-ver>  <image-ref>
# Lines without a betprod.azurecr.io image ref are inherited from the most recent
# line in the report that had one (scanner output often lists image only once per group).
#
# Usage:
#   ./vuln-verify-os.sh report.txt
#   pbpaste | ./vuln-verify-os.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUERY="$SCRIPT_DIR/query-os-packages.sh"
INPUT="${1:-/dev/stdin}"

TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# Extract (pkg, fixed_version, repo) triples. Image ref is sticky BACKWARD: the
# scanner lists packages first, then the image ref on the final line of a block.
# Buffer pending (pkg, fixed) pairs and flush them when an image line appears.
awk '
  function flush(img,   i) {
    sub(/^betprod\.azurecr\.io\//, "", img)
    sub(/@sha256:.*$/, "", img)
    sub(/:[^\/]+$/, "", img)
    for (i=1; i<=n; i++) print buf_pkg[i] "|" buf_fix[i] "|" img
    n=0
  }
  {
    img=""
    for (i=NF; i>=1; i--) if ($i ~ /^betprod\.azurecr\.io\//) { img=$i; break }
    if (NF >= 3) {
      n++
      buf_pkg[n]=$1
      buf_fix[n]=$3
    }
    if (img != "") flush(img)
  }
' "$INPUT" | sort -u > "$TMP/records.txt"

cut -d'|' -f3 "$TMP/records.txt" | sort -u > "$TMP/repos.txt"

# Debian/Alpine version comparison implemented in Python (no dpkg needed).
# Compares Debian-style versions correctly: [epoch:]upstream[-revision], with
# tilde < empty < alnum ordering. Works for apk versions too (they lack epoch).
compare_ge() {
  local a="$1" b="$2"
  python3 - "$a" "$b" <<'PY' >/dev/null 2>&1
import sys, re

def split_epoch(v):
    m = re.match(r'^(\d+):(.*)$', v)
    return (int(m.group(1)), m.group(2)) if m else (0, v)

def split_upstream_rev(v):
    if '-' in v:
        i = v.rindex('-')
        return v[:i], v[i+1:]
    return v, ''

def cmp_str(a, b):
    # Debian version comparison: ~ < '' < letters < digits-as-separators ...
    # Alternate non-digit and digit chunks.
    def tokenize(s):
        i, out = 0, []
        while i < len(s):
            nd = ''
            while i < len(s) and not s[i].isdigit():
                nd += s[i]; i += 1
            out.append(('s', nd))
            d = ''
            while i < len(s) and s[i].isdigit():
                d += s[i]; i += 1
            out.append(('n', int(d) if d else 0))
        return out
    ta, tb = tokenize(a), tokenize(b)
    for i in range(max(len(ta), len(tb))):
        ea = ta[i] if i < len(ta) else ('s','')
        eb = tb[i] if i < len(tb) else ('s','')
        if ea[0] == 's':
            # Per-char comparison with ~ < '' < letters < other
            sa, sb = ea[1], eb[1]
            for j in range(max(len(sa), len(sb))):
                ca = sa[j] if j < len(sa) else ''
                cb = sb[j] if j < len(sb) else ''
                if ca == cb: continue
                def ord_(c):
                    if c == '~': return -1
                    if c == '':  return 0
                    if c.isalpha(): return ord(c)
                    return ord(c) + 256
                return ord_(ca) - ord_(cb)
        else:
            if ea[1] != eb[1]:
                return ea[1] - eb[1]
    return 0

def ver_cmp(a, b):
    ea, ua = split_epoch(a); eb, ub = split_epoch(b)
    if ea != eb: return ea - eb
    ua_u, ua_r = split_upstream_rev(ua); ub_u, ub_r = split_upstream_rev(ub)
    c = cmp_str(ua_u, ub_u)
    if c: return c
    return cmp_str(ua_r, ub_r)

sys.exit(0 if ver_cmp(sys.argv[1], sys.argv[2]) >= 0 else 1)
PY
}

echo "=== OS Package Vulnerability Verification (against most recent ACR digest per repo) ==="
echo ""

while read -r repo; do
  echo "--- $repo (most recent digest) ---"

  if ! "$QUERY" "$repo" >"$TMP/pkgs.txt" 2>"$TMP/err.txt"; then
    if grep -qE "MANIFEST_UNKNOWN|No manifests found" "$TMP/err.txt"; then
      echo "  [REPO GONE]   no manifests in ACR for this repo"
    else
      echo "  [ERROR]       $(head -1 "$TMP/err.txt")"
    fi
    echo ""
    continue
  fi

  grep -F "|$repo" "$TMP/records.txt" | while IFS='|' read -r pkg fixed _; do
    current=$(awk -F'\t' -v p="$pkg" '$2==p {print $3; exit}' "$TMP/pkgs.txt")
    if [[ -z "$current" ]]; then
      echo "  [NOT PRESENT] $pkg  (not installed in latest image)"
    elif compare_ge "$current" "$fixed"; then
      echo "  [FIXED]       $pkg  current=$current  required>=$fixed"
    else
      echo "  [VULNERABLE]  $pkg  current=$current  required>=$fixed"
    fi
  done
  echo ""
done < "$TMP/repos.txt"
