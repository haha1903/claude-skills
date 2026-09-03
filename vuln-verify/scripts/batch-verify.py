#!/usr/bin/env python3
"""End-to-end vulnerability verification pipeline.

Pipeline:
  1. Load /tmp/vulns.json (or fetch fresh with fetch-vulns.py).
  2. Distinct all images referenced by the Kusto rows + for each repo also
     resolve the *latest* ACR digest.
  3. ACR precheck: `crane manifest` in parallel to tell which reported
     digests still exist and to grab the repo's latest digest.
  4. AKS precheck: one `kubectl get pods -A -o json`, correlate imageID
     against our target digests + find Succeeded (completed) pods using
     them; delete those Succeeded pods automatically.
  5. Parallel bulk extract of every live image (reported digest if still
     present + latest digest) via `_extract-all-deps.py` running inside
     the azure-cli pod. Cache output at /tmp/vuln-cache/.
  6. Cross-reference each Kusto row's ScanResult against the cache and
     emit a verdict (FIXED / VULNERABLE / IMAGE GONE / NOT PRESENT).
  7. Print summary + per-row table. JSON dump on request.

Usage:
  ./batch-verify.py                       # use /tmp/vulns.json (or fetch)
  ./batch-verify.py --fetch               # force fresh Kusto fetch
  ./batch-verify.py --vulns /path.json    # explicit input
  ./batch-verify.py --also-verify-latest  # also verify against the latest
                                          # digest of each repo (default on
                                          # when reported digest is gone)
  ./batch-verify.py --concurrency N       # parallel extracts (default 5)
  ./batch-verify.py --no-cleanup          # skip completed-pod cleanup
  ./batch-verify.py --cache-ttl 3600      # reuse extract cache older than
                                          # this many seconds (default 3600)
  ./batch-verify.py --out report.json     # also write machine-readable JSON

Requires: kubectl context pointed at bet-prod AKS. On macOS host.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable

SCRIPT_DIR = Path(__file__).resolve().parent
FETCH = SCRIPT_DIR / "fetch-vulns.mjs"
EXTRACTOR_LOCAL = SCRIPT_DIR / "_extract-all-deps.py"

# Pod bootstrap
AZ_CLI_DEPLOY = "azure-cli"
TMP_POD_NAME = "vuln-verify-tmp"
POD_IMAGE = "mcr.microsoft.com/azure-cli:2.69.0"
NS = "default"
SA = "bet-prod"
CLIENT_ID = "8c2cd91e-48e2-4b0c-80a6-f752d877b693"
TENANT_ID = "33e01921-4d64-4f8c-a055-5bdaffd5e33d"

CACHE_DIR = Path("/tmp/vuln-cache")
DEFAULT_VULNS = Path("/tmp/vulns.json")

COLOR = sys.stdout.isatty()


def c(code: str, s: str) -> str:
    if not COLOR:
        return s
    return f"\033[{code}m{s}\033[0m"


def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def krun(*args, timeout=300) -> subprocess.CompletedProcess:
    return run(["kubectl"] + list(args), timeout=timeout)


# ---------------------------------------------------------------------------
# Version comparators
# ---------------------------------------------------------------------------

def _debian_tokenize(s: str):
    out, i = [], 0
    while i < len(s):
        nd = ""
        while i < len(s) and not s[i].isdigit():
            nd += s[i]; i += 1
        out.append(("s", nd))
        d = ""
        while i < len(s) and s[i].isdigit():
            d += s[i]; i += 1
        out.append(("n", int(d) if d else 0))
    return out


def _debian_char_ord(c_: str) -> int:
    if c_ == "~":
        return -1
    if c_ == "":
        return 0
    if c_.isalpha():
        return ord(c_)
    return ord(c_) + 256


def _debian_cmp_str(a: str, b: str) -> int:
    ta, tb = _debian_tokenize(a), _debian_tokenize(b)
    for i in range(max(len(ta), len(tb))):
        ea = ta[i] if i < len(ta) else ("s", "")
        eb = tb[i] if i < len(tb) else ("s", "")
        if ea[0] == "s":
            sa, sb = ea[1], eb[1]
            for j in range(max(len(sa), len(sb))):
                ca = sa[j] if j < len(sa) else ""
                cb = sb[j] if j < len(sb) else ""
                if ca == cb:
                    continue
                return _debian_char_ord(ca) - _debian_char_ord(cb)
        else:
            if ea[1] != eb[1]:
                return ea[1] - eb[1]
    return 0


def _split_epoch(v: str):
    m = re.match(r"^(\d+):(.*)$", v)
    return (int(m.group(1)), m.group(2)) if m else (0, v)


def _split_rev(v: str):
    if "-" in v:
        i = v.rindex("-")
        return v[:i], v[i + 1:]
    return v, ""


def dpkg_ge(cur: str, fixed: str) -> bool:
    """Debian/Ubuntu version comparison."""
    ea, ua = _split_epoch(cur)
    eb, ub = _split_epoch(fixed)
    if ea != eb:
        return ea >= eb
    cua, cra = _split_rev(ua)
    cub, crb = _split_rev(ub)
    c1 = _debian_cmp_str(cua, cub)
    if c1 != 0:
        return c1 > 0
    return _debian_cmp_str(cra, crb) >= 0


def rpm_strip_arch(v: str) -> str:
    return re.sub(r"\.(x86_64|x86__64|aarch64|noarch|i686)$", "", v)


def rpm_ge(cur: str, fixed: str) -> bool:
    """RPM version comparison using Debian algorithm (close-enough).

    Handles the S360 scanner quirk of emitting `__` in place of `_`
    (e.g. `2.48-10.el9__7.1` instead of `2.48-10.el9_7.1`) by collapsing
    consecutive underscores on both sides before comparing.
    """
    def norm(v: str) -> str:
        v = rpm_strip_arch(v)
        return re.sub(r"_+", "_", v)
    return dpkg_ge(norm(cur), norm(fixed))


_MAVEN_QUAL = {
    "snapshot": -5, "alpha": -4, "beta": -3, "milestone": -2, "m": -2,
    "rc": -1, "cr": -1, "": 0, "ga": 0, "final": 0, "release": 0,
}


def _maven_tokens(v: str):
    v = v.lstrip("vV")
    out = []
    for part in re.split(r"[.\-_+]", v):
        if not part:
            continue
        m = re.match(r"^(\d+)([A-Za-z].*)?$", part)
        if m:
            out.append(("n", int(m.group(1))))
            if m.group(2):
                out.append(("q", m.group(2).lower()))
        else:
            out.append(("q", part.lower()))
    return out


def maven_ge(cur: str, fixed: str) -> bool:
    ta, tb = _maven_tokens(cur), _maven_tokens(fixed)
    for i in range(max(len(ta), len(tb))):
        ea = ta[i] if i < len(ta) else ("n", 0)
        eb = tb[i] if i < len(tb) else ("n", 0)
        if ea[0] == eb[0]:
            if ea[0] == "n":
                if ea[1] != eb[1]:
                    return ea[1] > eb[1]
            else:
                wa = _MAVEN_QUAL.get(ea[1], 1)
                wb = _MAVEN_QUAL.get(eb[1], 1)
                if wa != wb:
                    return wa > wb
                if ea[1] != eb[1]:
                    return ea[1] > eb[1]
        else:
            # numeric token beats qualifier-only token at same position
            return ea[0] == "n"
    return True


def semver_ge(cur: str, fixed: str) -> bool:
    """Strict-ish semver for Node-style versions."""

    def parse(v: str):
        v = v.lstrip("vV").split("+")[0]
        core, _, pre = v.partition("-")
        nums = [int(x) for x in re.findall(r"\d+", core)] or [0]
        return nums, pre

    na, pa = parse(cur)
    nb, pb = parse(fixed)
    for i in range(max(len(na), len(nb))):
        a = na[i] if i < len(na) else 0
        b = nb[i] if i < len(nb) else 0
        if a != b:
            return a > b
    # core equal: release > pre-release
    if pa == pb:
        return True
    if pa and not pb:
        return False
    if pb and not pa:
        return True
    return pa >= pb


# ---------------------------------------------------------------------------
# Image helpers
# ---------------------------------------------------------------------------

_IMG_RE = re.compile(r"^(?P<reg>[^/]+)/(?P<repo>.+?)@(?P<digest>sha256:[0-9a-f]+)$")


def parse_image(ref: str):
    m = _IMG_RE.match(ref.strip())
    if not m:
        return None
    return {"registry": m["reg"], "repo": m["repo"], "digest": m["digest"], "ref": ref.strip()}


def make_ref(reg: str, repo: str, digest: str) -> str:
    return f"{reg}/{repo}@{digest}"


# ---------------------------------------------------------------------------
# Pod bootstrap
# ---------------------------------------------------------------------------

def ensure_pod() -> str:
    """Make sure a usable azure-cli pod exists. Return pod name."""
    r = krun("get", "deploy", AZ_CLI_DEPLOY, "-n", NS, "-o",
             "jsonpath={.status.readyReplicas}", timeout=30)
    if r.returncode == 0 and r.stdout.strip() in {"1", "2", "3"}:
        # Find the pod name
        r2 = krun("get", "pods", "-n", NS, "-l", f"app={AZ_CLI_DEPLOY}",
                  "-o", "jsonpath={.items[0].metadata.name}", timeout=30)
        if r2.returncode == 0 and r2.stdout.strip():
            log(f"using existing pod deploy/{AZ_CLI_DEPLOY} -> {r2.stdout.strip()}")
            return r2.stdout.strip()

    log(f"deploy/{AZ_CLI_DEPLOY} not Ready, spinning up {TMP_POD_NAME}")
    # Delete leftover tmp pod if any
    krun("delete", "pod", TMP_POD_NAME, "-n", NS, "--ignore-not-found",
         "--grace-period=1", timeout=60)
    manifest = f"""apiVersion: v1
kind: Pod
metadata:
  name: {TMP_POD_NAME}
  namespace: {NS}
  labels:
    azure.workload.identity/use: "true"
spec:
  serviceAccountName: {SA}
  restartPolicy: Never
  containers:
  - name: cli
    image: {POD_IMAGE}
    command: ["/bin/bash","-c","sleep 7200"]
    resources:
      requests: {{ cpu: "200m", memory: "512Mi" }}
      limits:   {{ cpu: "2000m", memory: "2Gi" }}
"""
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(manifest)
        yaml_path = f.name
    try:
        krun("apply", "-f", yaml_path, timeout=60)
        krun("wait", "--for=condition=Ready",
             f"pod/{TMP_POD_NAME}", "-n", NS, "--timeout=120s", timeout=180)
    finally:
        os.unlink(yaml_path)
    return TMP_POD_NAME


def bootstrap_pod(pod: str):
    """Install tools + az login inside the pod."""
    script = r"""set -e
# Install only what's missing; avoid tdnf upgrading curl (ABI breakage).
MISSING=""
for t in tar gzip rpm awk python3; do
  command -v "$t" >/dev/null 2>&1 || MISSING="$MISSING $t"
done
if [ -n "$MISSING" ]; then
  tdnf install -y $MISSING >/dev/null 2>&1 || true
fi
if [ ! -x /usr/local/bin/crane ]; then
  cd /tmp
  curl -sL https://github.com/google/go-containerregistry/releases/latest/download/go-containerregistry_Linux_x86_64.tar.gz -o gcr.tgz
  tar -xzf gcr.tgz crane
  install crane /usr/local/bin/
fi
if ! az account show >/dev/null 2>&1; then
  az login --federated-token "$(cat $AZURE_FEDERATED_TOKEN_FILE)" \
    --service-principal -u __CLIENT__ -t __TENANT__ >/dev/null
fi
TOKEN=$(az acr login -n betprod --expose-token -o tsv --query accessToken 2>/dev/null)
echo "$TOKEN" | crane auth login betprod.azurecr.io \
  -u 00000000-0000-0000-0000-000000000000 --password-stdin >/dev/null 2>&1
echo "ready"
""".replace("__CLIENT__", CLIENT_ID).replace("__TENANT__", TENANT_ID)
    r = run(["kubectl", "exec", "-n", NS, pod, "--", "bash", "-c", script],
            timeout=300)
    if r.returncode != 0 or "ready" not in r.stdout:
        sys.exit(f"pod bootstrap failed:\nstdout={r.stdout}\nstderr={r.stderr}")
    log("pod bootstrap ok (crane + rpm + az login + acr login)")


def upload_extractor(pod: str) -> str:
    dst = "/tmp/_extract-all-deps.py"
    r = run(["kubectl", "cp", "-n", NS, str(EXTRACTOR_LOCAL),
             f"{pod}:{dst}"], timeout=120)
    if r.returncode != 0:
        sys.exit(f"failed to upload extractor: {r.stderr}")
    run(["kubectl", "exec", "-n", NS, pod, "--", "chmod", "+x", dst], timeout=30)
    return dst


# ---------------------------------------------------------------------------
# ACR precheck
# ---------------------------------------------------------------------------

def crane_manifest_exists(pod: str, image_ref: str) -> bool:
    r = run(["kubectl", "exec", "-n", NS, pod, "--",
             "crane", "manifest", image_ref], timeout=60)
    return r.returncode == 0


def acr_latest_digest(pod: str, registry: str, repo: str) -> str | None:
    if registry != "betprod.azurecr.io":
        return None
    r = run(["kubectl", "exec", "-n", NS, pod, "--",
             "az", "acr", "manifest", "list-metadata",
             "--name", repo, "--registry", "betprod",
             "--orderby", "time_desc", "--top", "1",
             "--query", "[0].digest", "-o", "tsv"], timeout=60)
    if r.returncode != 0:
        return None
    d = r.stdout.strip()
    return d if d and d.startswith("sha256:") else None


@dataclass
class AcrStatus:
    reported_exists: bool
    latest_digest: str | None  # None if same as reported or unknown
    latest_ref: str | None


def acr_precheck(pod: str, images: list[dict], concurrency=6) -> dict[str, AcrStatus]:
    """Check each reported image: does digest still exist? what's the latest?"""
    results: dict[str, AcrStatus] = {}
    # Dedupe work: (ref, repo) → check; share latest-digest-by-repo across refs
    repos = sorted({(i["registry"], i["repo"]) for i in images})

    log(f"ACR precheck: {len(images)} images / {len(repos)} repos (concurrency={concurrency})")

    latest_by_repo: dict[tuple[str, str], str | None] = {}
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = {ex.submit(acr_latest_digest, pod, reg, repo): (reg, repo)
                for reg, repo in repos}
        for fut in as_completed(futs):
            latest_by_repo[futs[fut]] = fut.result()

    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = {ex.submit(crane_manifest_exists, pod, i["ref"]): i for i in images}
        for fut in as_completed(futs):
            img = futs[fut]
            exists = fut.result()
            key = (img["registry"], img["repo"])
            latest = latest_by_repo.get(key)
            latest_ref = make_ref(img["registry"], img["repo"], latest) if latest else None
            same = (latest == img["digest"])
            results[img["ref"]] = AcrStatus(
                reported_exists=exists,
                latest_digest=None if same else latest,
                latest_ref=None if same else latest_ref,
            )
    return results


# ---------------------------------------------------------------------------
# AKS precheck + completed-pod cleanup
# ---------------------------------------------------------------------------

def get_all_pods() -> list[dict]:
    r = krun("get", "pods", "-A", "-o", "json", timeout=60)
    if r.returncode != 0:
        sys.exit(f"kubectl get pods -A failed: {r.stderr}")
    return json.loads(r.stdout).get("items", [])


def pod_uses_digest(pod: dict, digest: str) -> bool:
    stat = pod.get("status", {}) or {}
    for key in ("containerStatuses", "initContainerStatuses"):
        for cs in stat.get(key, []) or []:
            if digest in (cs.get("imageID") or ""):
                return True
    return False


@dataclass
class AksHit:
    namespace: str
    name: str
    phase: str
    digest: str
    image_ref: str


def aks_scan(all_pods: list[dict], images: list[dict]) -> list[AksHit]:
    hits = []
    digests = {i["digest"]: i["ref"] for i in images}
    for pod in all_pods:
        for digest, ref in digests.items():
            if pod_uses_digest(pod, digest):
                hits.append(AksHit(
                    namespace=pod["metadata"]["namespace"],
                    name=pod["metadata"]["name"],
                    phase=pod.get("status", {}).get("phase", "?"),
                    digest=digest,
                    image_ref=ref,
                ))
    return hits


def cleanup_completed_pods(hits: list[AksHit]) -> list[AksHit]:
    terminal = [h for h in hits if h.phase == "Succeeded"]
    if not terminal:
        return []
    log(f"cleaning {len(terminal)} completed (Succeeded) pod(s) matching target images")
    cleaned = []
    for h in terminal:
        r = krun("delete", "pod", h.name, "-n", h.namespace,
                 "--grace-period=5", "--ignore-not-found", timeout=60)
        if r.returncode == 0:
            cleaned.append(h)
            log(f"  deleted {h.namespace}/{h.name} (was using {h.image_ref[-40:]})")
        else:
            log(f"  FAILED to delete {h.namespace}/{h.name}: {r.stderr.strip()}")
    return cleaned


# ---------------------------------------------------------------------------
# Extraction (parallel crane export in pod)
# ---------------------------------------------------------------------------

def cache_path(ref: str) -> Path:
    parsed = parse_image(ref)
    assert parsed
    safe_repo = parsed["repo"].replace("/", "_")
    short = parsed["digest"][7:19]
    return CACHE_DIR / f"{parsed['registry']}_{safe_repo}_{short}.json"


def extract_one(pod: str, extractor_path: str, ref: str, ttl: int) -> dict:
    cp = cache_path(ref)
    if cp.exists() and (time.time() - cp.stat().st_mtime) < ttl:
        log(f"cache hit: {ref[-60:]}")
        return json.loads(cp.read_text())

    log(f"extracting: {ref[-60:]}")
    t0 = time.time()
    r = run(["kubectl", "exec", "-n", NS, pod, "--",
             "python3", extractor_path, ref], timeout=900)
    if r.returncode != 0:
        log(f"  extract failed for {ref}: {r.stderr.strip()[:200]}")
        return {"image": ref, "error": r.stderr.strip()[:200]}
    try:
        data = json.loads(r.stdout)
    except json.JSONDecodeError as e:
        data = {"image": ref, "error": f"bad JSON from extractor: {e}"}
    cp.parent.mkdir(parents=True, exist_ok=True)
    cp.write_text(json.dumps(data))
    dt = time.time() - t0
    if "error" not in data:
        counts = ", ".join(f"{k}={len(data.get(k, []))}"
                           for k in ("dpkg", "apk", "rpm", "java", "node"))
        log(f"  done {ref[-60:]} in {dt:.1f}s  ({counts})")
    return data


def batch_extract(pod: str, extractor_path: str, refs: list[str],
                  concurrency: int, ttl: int) -> dict[str, dict]:
    out: dict[str, dict] = {}
    if not refs:
        return out
    log(f"bulk extracting {len(refs)} image(s) with concurrency={concurrency}")
    with ThreadPoolExecutor(max_workers=concurrency) as ex:
        futs = {ex.submit(extract_one, pod, extractor_path, r, ttl): r for r in refs}
        for fut in as_completed(futs):
            ref = futs[fut]
            out[ref] = fut.result()
    return out


# ---------------------------------------------------------------------------
# ScanResult parsing + row verification
# ---------------------------------------------------------------------------

def classify_scanresult(sr: str) -> str:
    """Return 'go' | 'java' | 'node' | 'os'."""
    sr = sr or ""
    if "Go " in sr or re.search(r"\b(github\.com|go\.opentelemetry|k8s\.io|golang\.org)/", sr):
        return "go"
    if " Java " in sr or ".jar" in sr:
        return "java"
    if "Node.js" in sr or "node_modules" in sr:
        return "node"
    return "os"


def parse_scan_lines(sr: str) -> list[dict]:
    """Turn the scanner's ScanResult block into a list of per-pkg records."""
    recs = []
    for line in (sr or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) < 3:
            continue
        name, cur, fixed = parts[0], parts[1], parts[2]
        rec = {"name": name, "current": cur, "fixed": fixed, "raw": line}
        if len(parts) >= 5 and parts[3] in {"Java", "Go", "Node.js"}:
            rec["kind"] = parts[3].lower()
            rec["path"] = parts[4]
        recs.append(rec)
    return recs


@dataclass
class Verdict:
    row_idx: int
    image: str
    vuln: str
    kind: str
    package: str
    current: str | None
    fixed: str
    state: str  # FIXED | VULNERABLE | IMAGE GONE | NOT PRESENT | ERROR | SKIPPED
    note: str = ""


def _find_os(pkg: str, deps: dict) -> tuple[str | None, str, str | None]:
    """Return (version, kind, comparator_name) for an OS package."""
    for src, comp in (("dpkg", "dpkg"), ("apk", "apk"), ("rpm", "rpm")):
        for entry in deps.get(src, []):
            if entry["name"] == pkg:
                return entry["ver"], src, comp
    return None, "os", None


def _find_java(ga: str, deps: dict):
    """Return highest version for groupId:artifactId across all jars."""
    best = None
    for e in deps.get("java", []):
        if e["ga"] == ga:
            if best is None or maven_ge(e["ver"], best):
                best = e["ver"]
    return best


def _find_node(name: str, deps: dict):
    """Return *all* matches for a Node package (multiple copies may coexist)."""
    return [e for e in deps.get("node", []) if e["name"] == name]


def verify_row(row: dict, row_idx: int, acr: AcrStatus,
               deps_by_ref: dict[str, dict],
               also_latest: bool) -> list[Verdict]:
    image_id = row.get("ImageId", "")
    parsed = parse_image(image_id)
    vuln_name = row.get("VulnerabilityName", "?")
    sr = row.get("ScanResult", "")
    recs = parse_scan_lines(sr)

    verdicts: list[Verdict] = []
    if not parsed:
        verdicts.append(Verdict(
            row_idx, image_id, vuln_name, "?", "?", None, "?",
            "ERROR", "cannot parse ImageId"))
        return verdicts

    # Pick which digest(s) to verify against
    targets = []
    if acr.reported_exists:
        targets.append(("reported", image_id))
    else:
        verdicts.append(Verdict(
            row_idx, image_id, vuln_name, "-", "-", None, "-",
            "IMAGE GONE", "reported digest no longer in ACR"))
    if also_latest and acr.latest_ref:
        targets.append(("latest", acr.latest_ref))

    if not targets:
        return verdicts

    for label, ref in targets:
        deps = deps_by_ref.get(ref)
        if not deps or "error" in deps:
            err = (deps or {}).get("error", "no deps cached")
            for rec in recs:
                verdicts.append(Verdict(
                    row_idx, ref, vuln_name,
                    rec.get("kind") or classify_scanresult(sr),
                    rec["name"], None, rec["fixed"],
                    "ERROR", f"[{label}] {err}"))
            continue

        kind = classify_scanresult(sr)
        for rec in recs:
            pkg = rec["name"]
            fixed = rec["fixed"]
            if kind == "os":
                cur, src, comp = _find_os(pkg, deps)
                if cur is None:
                    state = "NOT PRESENT"
                    note = f"[{label}] no match in dpkg/apk/rpm"
                else:
                    cmp_fn = {"dpkg": dpkg_ge, "apk": dpkg_ge,
                              "rpm": rpm_ge}[comp]
                    state = "FIXED" if cmp_fn(cur, fixed) else "VULNERABLE"
                    note = f"[{label}] via {src}"
                verdicts.append(Verdict(
                    row_idx, ref, vuln_name, "os", pkg, cur, fixed, state, note))
            elif kind == "java":
                cur = _find_java(pkg, deps)
                if cur is None:
                    verdicts.append(Verdict(
                        row_idx, ref, vuln_name, "java", pkg, None, fixed,
                        "NOT PRESENT", f"[{label}] no jar matches"))
                else:
                    state = "FIXED" if maven_ge(cur, fixed) else "VULNERABLE"
                    verdicts.append(Verdict(
                        row_idx, ref, vuln_name, "java", pkg, cur, fixed,
                        state, f"[{label}]"))
            elif kind == "node":
                matches = _find_node(pkg, deps)
                if not matches:
                    verdicts.append(Verdict(
                        row_idx, ref, vuln_name, "node", pkg, None, fixed,
                        "NOT PRESENT", f"[{label}] no node_modules hit"))
                else:
                    # Any match below fixed → VULNERABLE; report the worst.
                    worst = min(matches, key=lambda e: (0 if not semver_ge(e["ver"], fixed) else 1, e["ver"]))
                    state = "FIXED" if all(semver_ge(m["ver"], fixed) for m in matches) else "VULNERABLE"
                    note = f"[{label}] {len(matches)} copy(ies); worst={worst['path']}"
                    verdicts.append(Verdict(
                        row_idx, ref, vuln_name, "node", pkg, worst["ver"], fixed,
                        state, note))
            else:  # go or unknown
                verdicts.append(Verdict(
                    row_idx, ref, vuln_name, kind, pkg, None, fixed,
                    "SKIPPED", f"[{label}] kind={kind} needs vuln-verify.sh"))

    return verdicts


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

STATE_COLORS = {
    "FIXED":       ("32", "✓"),
    "VULNERABLE":  ("31", "✗"),
    "IMAGE GONE":  ("33", "·"),
    "NOT PRESENT": ("33", "?"),
    "ERROR":       ("31", "!"),
    "SKIPPED":     ("34", "-"),
}


def print_verdicts(verdicts: list[Verdict]):
    # Group by image
    by_img: dict[str, list[Verdict]] = {}
    for v in verdicts:
        by_img.setdefault(v.image, []).append(v)

    for img in sorted(by_img):
        print(f"\n--- {img} ---")
        for v in by_img[img]:
            color, glyph = STATE_COLORS.get(v.state, ("0", "·"))
            state = c(color, f"{glyph} {v.state:<11}")
            pkg = v.package[:55]
            cur = (v.current or "-")[:30]
            line = f"  {state}  {pkg:<55}  cur={cur:<30}  need>={v.fixed}"
            if v.note:
                line += f"  ({v.note})"
            print(line)


def print_summary(verdicts: list[Verdict]):
    states = [v.state for v in verdicts]
    total = len(verdicts)
    counts = {s: states.count(s) for s in set(states)}
    print("\n" + "=" * 60)
    print(f"Total verdicts: {total}")
    for s in ("FIXED", "VULNERABLE", "IMAGE GONE", "NOT PRESENT", "ERROR", "SKIPPED"):
        if s in counts:
            color, _ = STATE_COLORS.get(s, ("0", "·"))
            print(f"  {c(color, s):<15}  {counts[s]}")
    print("=" * 60)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def load_vulns(path: Path, force_fetch: bool) -> list[dict]:
    if force_fetch or not path.exists():
        log(f"fetching fresh vulns → {path}")
        r = run([str(FETCH), "--out", str(path)], timeout=300)
        if r.returncode != 0:
            sys.exit(f"fetch-vulns.py failed: {r.stderr}")
    with open(path) as f:
        return json.load(f)


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--vulns", type=Path, default=DEFAULT_VULNS)
    ap.add_argument("--fetch", action="store_true",
                    help="force fresh Kusto fetch")
    ap.add_argument("--also-verify-latest", action="store_true", default=True,
                    help="verify against latest ACR digest in addition to the reported one")
    ap.add_argument("--concurrency", type=int, default=5)
    ap.add_argument("--no-cleanup", action="store_true",
                    help="skip deletion of completed pods")
    ap.add_argument("--cache-ttl", type=int, default=3600,
                    help="reuse extract cache newer than N seconds (default 3600)")
    ap.add_argument("--out", type=Path, help="write machine-readable JSON report")
    args = ap.parse_args()

    t_start = time.time()

    # ---- 1. load vulns ----
    vulns = load_vulns(args.vulns, args.fetch)
    log(f"loaded {len(vulns)} vulnerability rows from {args.vulns}")

    # ---- 2. distinct images ----
    parsed_rows = [parse_image(v.get("ImageId", "")) for v in vulns]
    images_by_ref: dict[str, dict] = {}
    for p in parsed_rows:
        if p and p["ref"] not in images_by_ref:
            images_by_ref[p["ref"]] = p
    images = list(images_by_ref.values())

    # Partition by registry — skill only handles betprod via pod
    betprod = [i for i in images if i["registry"] == "betprod.azurecr.io"]
    other = [i for i in images if i["registry"] != "betprod.azurecr.io"]
    log(f"distinct images: {len(images)} total / {len(betprod)} betprod / {len(other)} other")
    if other:
        for o in other:
            log(f"  SKIP (non-betprod): {o['ref']}")

    if not betprod:
        log("nothing to verify (no betprod images)")
        return

    # ---- 3. pod bootstrap ----
    pod = ensure_pod()
    bootstrap_pod(pod)
    extractor = upload_extractor(pod)

    # ---- 4. ACR precheck ----
    acr = acr_precheck(pod, betprod, concurrency=args.concurrency)
    acr_missing = sum(1 for s in acr.values() if not s.reported_exists)
    acr_newer = sum(1 for s in acr.values() if s.latest_ref)
    log(f"ACR precheck: {acr_missing} reported digests gone, {acr_newer} repos have newer digests")

    # ---- 5. AKS precheck + cleanup ----
    all_pods = get_all_pods()
    log(f"AKS scan: {len(all_pods)} pods total")
    hits = aks_scan(all_pods, betprod)
    log(f"AKS scan: {len(hits)} pods use one of our target images")
    running = [h for h in hits if h.phase == "Running"]
    completed = [h for h in hits if h.phase == "Succeeded"]
    failed = [h for h in hits if h.phase == "Failed"]
    log(f"  Running={len(running)}  Succeeded={len(completed)}  Failed={len(failed)}")
    if completed and not args.no_cleanup:
        cleanup_completed_pods(completed)

    # Refresh hits after cleanup
    if completed and not args.no_cleanup:
        hits = [h for h in hits if h.phase != "Succeeded"]

    # ---- 6. bulk extract ----
    to_extract: set[str] = set()
    for img in betprod:
        st = acr[img["ref"]]
        if st.reported_exists:
            to_extract.add(img["ref"])
        if args.also_verify_latest and st.latest_ref:
            to_extract.add(st.latest_ref)
    deps_by_ref = batch_extract(pod, extractor, sorted(to_extract),
                                concurrency=args.concurrency, ttl=args.cache_ttl)

    # ---- 7. cross-reference ----
    log("cross-referencing rows...")
    all_verdicts: list[Verdict] = []
    for idx, v in enumerate(vulns):
        p = parse_image(v.get("ImageId", ""))
        if not p:
            continue
        if p["registry"] != "betprod.azurecr.io":
            all_verdicts.append(Verdict(
                idx, p["ref"], v.get("VulnerabilityName", "?"), "?",
                "-", None, "-", "SKIPPED",
                f"non-betprod registry; verify from local host"))
            continue
        verdicts = verify_row(v, idx, acr[p["ref"]], deps_by_ref,
                              args.also_verify_latest)
        all_verdicts.extend(verdicts)

    # ---- 8. output ----
    print_verdicts(all_verdicts)
    print_summary(all_verdicts)
    log(f"total wall time: {time.time() - t_start:.1f}s")

    if args.out:
        payload = {
            "generated_at": time.time(),
            "input_rows": len(vulns),
            "verdicts": [v.__dict__ for v in all_verdicts],
            "acr": {ref: s.__dict__ for ref, s in acr.items()},
            "aks_hits": [h.__dict__ for h in hits],
        }
        args.out.write_text(json.dumps(payload, indent=2, default=str))
        log(f"wrote JSON report → {args.out}")


if __name__ == "__main__":
    main()
