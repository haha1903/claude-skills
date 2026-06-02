#!/usr/bin/env bash
# Query Java jar dependencies embedded in a container image in betprod ACR.
# Usage: ./query-java-jars.sh <repo>[:tag|@digest] [filter]
#   If no tag/digest given, uses the most recent digest.
#   e.g. ./query-java-jars.sh elasticsearch/elasticsearch
#        ./query-java-jars.sh elasticsearch/elasticsearch@sha256:abcd...
#        ./query-java-jars.sh elasticsearch/elasticsearch latest log4j
#
# Output: one line per artifact found, TAB-separated:
#   <jar-path>\t<groupId>:<artifactId>\t<version>
# Nested jars (fat/shaded) are reported with the outer!inner path.

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
crane export "$IMAGE" "$WORK/img.tar" 2>/dev/null
mkdir -p "$WORK/fs"
tar -xf "$WORK/img.tar" -C "$WORK/fs" 2>/dev/null || true

echo "[*] Scanning JAR files..." >&2
python3 - "$WORK/fs" "$FILTER" <<'PY'
import os, sys, zipfile, io

root = sys.argv[1]
flt  = sys.argv[2]

def parse_props(raw):
    out = {}
    for line in raw.decode('utf-8', errors='replace').splitlines():
        line = line.strip()
        if not line or line.startswith('#'): continue
        if '=' in line:
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip()
    return out

def parse_manifest(raw):
    out = {}
    text = raw.decode('utf-8', errors='replace')
    # Join continuation lines (manifests wrap at 72 cols with a leading space)
    lines, buf = [], ''
    for line in text.splitlines():
        if line.startswith(' '):
            buf += line[1:]
        else:
            if buf: lines.append(buf)
            buf = line
    if buf: lines.append(buf)
    for line in lines:
        if ':' in line:
            k, v = line.split(':', 1)
            out[k.strip()] = v.strip()
    return out

def emit(path, ga, ver):
    if flt and flt not in ga: return
    print(f"{path}\t{ga}\t{ver}")

def scan_jar(blob, display, depth=0):
    try:
        zf = zipfile.ZipFile(io.BytesIO(blob))
    except zipfile.BadZipFile:
        return
    names = zf.namelist()

    # Primary: META-INF/maven/<g>/<a>/pom.properties (most reliable)
    got_any = False
    for n in names:
        if n.startswith('META-INF/maven/') and n.endswith('/pom.properties'):
            try:
                p = parse_props(zf.read(n))
                g, a, v = p.get('groupId',''), p.get('artifactId',''), p.get('version','')
                if g and a and v:
                    emit(display, f"{g}:{a}", v)
                    got_any = True
            except Exception:
                pass

    # Fallback: MANIFEST.MF (some jars lack pom.properties, e.g. OSGi bundles)
    if not got_any:
        try:
            m = parse_manifest(zf.read('META-INF/MANIFEST.MF'))
            ver = m.get('Implementation-Version') or m.get('Bundle-Version') or ''
            ident = (m.get('Bundle-SymbolicName') or
                     m.get('Implementation-Title') or
                     m.get('Automatic-Module-Name') or '')
            if ident and ver:
                emit(display, ident, ver)
        except KeyError:
            pass
        except Exception:
            pass

    # Recurse into nested jars (fat / uber / shaded jars bundle deps inside)
    if depth < 3:
        for n in names:
            if n.endswith('.jar'):
                try:
                    scan_jar(zf.read(n), f"{display}!{n}", depth + 1)
                except Exception:
                    pass

for dirpath, _, files in os.walk(root):
    for f in files:
        if not f.endswith('.jar'): continue
        full = os.path.join(dirpath, f)
        rel = full[len(root):].lstrip('/')
        try:
            with open(full, 'rb') as fh:
                scan_jar(fh.read(), rel)
        except Exception as e:
            print(f"[ERROR] {rel}: {e}", file=sys.stderr)
PY
REMOTE
