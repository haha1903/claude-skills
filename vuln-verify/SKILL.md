---
name: vuln-verify
description: Use when receiving vulnerability reports (CVE, Defender alerts, S360 action items, image scan results) — pulls active vulnerabilities straight from the S360 Kusto cluster (shavulnmgmtprdwus/ShaS360) via fetch-vulns.py, summarizes them, then verifies with vuln-verify.sh (Go), vuln-verify-os.sh (OS pkg), vuln-verify-java.sh (Java jar) to confirm each is still present before planning remediation
---

# Vulnerability Verification

Verify whether a reported vulnerability actually affects running workloads before spending time on remediation. The skill can either (a) pull the current active vulnerability list directly from S360 Kusto and drive verification from there, or (b) take a pasted/file report and verify it. Prefer the provided scripts; fall back to manual commands only when the scripts don't fit.

**TL;DR: when asked to verify current vulns, just run `./scripts/batch-verify.py --fetch` — it does the whole pipeline (dedup images, ACR/AKS precheck, clean up completed pods, parallel extract, cross-reference). Fall back to per-type scripts (`vuln-verify.sh`, `-os.sh`, `-java.sh`) only for Go rows or pasted reports.**

## When to Use

- User says "check our vulns", "verify current vulnerabilities", "run vuln-verify" without a report attached → run `batch-verify.py`
- Received a CVE report, Defender for Cloud alert, or image scan result → skip to Step 1 (manual path) or paste into the matching `vuln-verify*.sh`
- Need to check if the affected image is still in ACR / deployed in AKS
- Need to confirm the reported module version is still embedded in the current image
- Before starting any vulnerability fix work

## Tooling (scripts/)

All scripts `kubectl exec` into `deploy/azure-cli` and run `relogin` there — the host machine needs only `kubectl`, no local `az`/`crane`/ACR credentials. Image refs default to `betprod.azurecr.io/`.

| Script | Purpose |
|---|---|
| `scripts/batch-verify.py [--fetch] [--concurrency N] [--no-cleanup] [--cache-ttl S] [--out report.json]` | **Preferred single entry point.** End-to-end pipeline: fetch Kusto → distinct images → ACR precheck (exists? latest digest?) → AKS precheck + auto-delete `Succeeded` pods using target images → parallel `crane export` extraction of every live image (dpkg/apk/rpm/java/node in one pass) → cross-reference each Kusto row against cache → emit FIXED/VULNERABLE/IMAGE GONE/NOT PRESENT/SKIPPED. Reuses `deploy/azure-cli` pod when Ready, falls back to spinning up `vuln-verify-tmp`. Cache at `/tmp/vuln-cache/` (default 1h TTL) means re-runs are ~70s vs ~500s cold. Go rows are SKIPPED — fall back to `vuln-verify.sh` for Go |
| `scripts/_extract-all-deps.py` | Pod-side helper invoked by `batch-verify.py`. Exports a single image via crane, dumps dpkg/apk/rpm/java/node install lists to stdout as JSON. Don't run directly |
| `scripts/fetch-vulns.py [--owner GUID] [--format json\|table\|summary] [--out file]` | Query the S360 Kusto cluster (`shavulnmgmtprdwus` / `ShaS360`) via `GetUnifiedS360ActionDetails` and return all active vulnerabilities for the given RemediationOwner. Default owner is the BET team (`66fc1dd2-fca0-43fe-a29e-e5019a29e949`). Default format is JSON — use `--format summary` for quick grouped counts, `--format table` for per-row pretty print. Relies on `az login` and reuses `~/.claude/skills/kusto-query/scripts/kusto_helper.py`. `batch-verify.py` calls this automatically |
| `scripts/list-acr-images.sh` | List all repositories in `betprod` ACR |
| `scripts/query-go-libs.sh <repo>[:tag\|@digest] [filter]` | Dump Go `mod`/`dep`/`=>` lines from every Go binary in the image. Accepts bare repo (no tag → latest digest) or full `betprod.azurecr.io/...@sha256:...` |
| `scripts/query-os-packages.sh <repo>[:tag\|@digest] [filter]` | Dump installed OS packages (dpkg for Debian/Ubuntu, apk for Alpine) from the image. Output format: `<mgr>\t<name>\t<version>` |
| `scripts/query-java-jars.sh <repo>[:tag\|@digest] [filter]` | Dump Java artifacts (`groupId:artifactId` + version) from every `.jar` in the image, including jars nested inside fat/shaded jars. Reads `META-INF/maven/*/pom.properties` first, falls back to `MANIFEST.MF`. Output format: `<jar-path>\t<groupId>:<artifactId>\t<version>` (nested jars shown as `outer.jar!inner.jar`) |
| `scripts/vuln-verify.sh <report>` | Batch-verify a **Go** vulnerability report against the latest digest of each repo. Prints FIXED / VULNERABLE / REPO GONE / NOT PRESENT per (repo, module) |
| `scripts/vuln-verify-os.sh <report>` | Batch-verify an **OS package** vulnerability report (dpkg/apk) against the latest digest. Uses a Python implementation of Debian version comparison (handles `~`, epoch, revision) so no `dpkg` tool is needed on the pod |
| `scripts/vuln-verify-java.sh <report>` | Batch-verify a **Java jar** vulnerability report against the latest digest. Matches by `groupId:artifactId` and scans nested jars (fat/shaded). Uses Maven-style version comparison (handles `-SNAPSHOT`, `-RC`, `.Final`) |

### Report format consumed by `vuln-verify.sh` (Go)

One record per line, whitespace-separated:

```
<module-path>  v<vuln-ver>  <fixed-ver>  Go  <binary-path>  <betprod.azurecr.io/...@sha256:...>
```

Lines without a `betprod.azurecr.io/...` image ref are ignored (they're typically duplicates from scanner output). Trailing columns beyond the image are also ignored.

### Report format consumed by `vuln-verify-os.sh` (OS packages)

```
<pkg-name>  <vuln-ver>  <fixed-ver>  [betprod.azurecr.io/...@sha256:...]
```

Scanners typically emit several package lines sharing a single image ref on the last line of the block. The script buffers package lines and attaches them to the next image ref that appears (backward-sticky), so the grouping is preserved.

### Report format consumed by `vuln-verify-java.sh` (Java jars)

```
<groupId:artifactId>  <vuln-ver>  <fixed-ver>  Java  <jar-path>  <betprod.azurecr.io/...@sha256:...>
```

The first column must be `groupId:artifactId` exactly as recorded in the jar's `pom.properties`. `query-java-jars.sh` scans nested jars too (fat/shaded), so artifacts bundled inside a uber-jar like `elastic-apm-agent-*.jar` are reachable. If a shaded jar has its `pom.properties` stripped, the artifact may come back as `[NOT PRESENT]` even though classes are still embedded — in that case inspect the jar manually.

Example invocation:

```bash
./scripts/vuln-verify.sh report.txt
# or
pbpaste | ./scripts/vuln-verify.sh
```

Example output:

```
--- betprod.azurecr.io/tektoncd/pipeline/webhook@sha256:76348f4c... ---
  [IMAGE GONE]  digest no longer in ACR -- vulnerability cannot apply

--- betprod.azurecr.io/tektoncd/pipeline/controller@sha256:1150c68e... ---
  [FIXED]       github.com/go-jose/go-jose/v4  current=v4.1.4  required>=4.1.4
  [VULNERABLE]  go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp  current=v1.42.0  required>=1.43.0
```

Result states:
- `[FIXED]` — current version ≥ required fixed version
- `[VULNERABLE]` — current version < required fixed version
- `[IMAGE GONE]` — digest no longer exists in ACR (the CVE instance cannot apply anymore, but the vulnerable image may have been replaced by a newer digest — check that separately)
- `[NOT PRESENT]` — module not found in any Go binary of the image (scanner false positive, or module was removed)
- `[ERROR]` — crane/ACR error

## Source: S360 Kusto (preferred when no report is attached)

When the user just says "verify our vulns" without attaching a report, fetch the authoritative active list from the S360 vulnerability management Kusto cluster instead of waiting for a paste.

- **Cluster:** `https://shavulnmgmtprdwus.westus2.kusto.windows.net`
- **Database:** `ShaS360`
- **Stored function:** `GetUnifiedS360ActionDetails(_Filter_RemediationOwner)`
- **Default RemediationOwner (BET team):** `66fc1dd2-fca0-43fe-a29e-e5019a29e949`

The canonical query (already embedded in `fetch-vulns.py`) filters out `NotFound` scan results, `Orphaned Image`, and App Service assets, then dedupes to the latest scan per (VMSSArmId, VulnerabilityId, ImageId).

Key columns in each returned row:

| Column | Use |
|---|---|
| `SLA`, `DueDate` | Prioritization — overdue / near-due first |
| `VulnerabilityName` | CVE / advisory title |
| `Image`, `ImageId` | `Image` is the repo:tag; `ImageId` is typically a digest or scanner ID (may or may not match `betprod.azurecr.io/...@sha256:...` — if not, derive the ACR ref from `Image` + latest digest) |
| `ScanResult` | The details block from the scanner — contains the **package/module name + current version + fixed version**. Parse this to build the per-row verify record |
| `AssetType` | `ContainerImage`, `VirtualMachineScaleSet`, etc. |
| `Environment` | Usually `Production` |
| `AKSCluster`, `VMScaleSetName`, `ResourceGroup` | Where the asset runs |
| `LastScanTimeUTC`, `LastSeen` | Freshness |

### Classifying a row into Go / OS / Java

`fetch-vulns.py` returns the raw `ScanResult`. Decide which verify script to feed each row into by looking at the scanner text plus the image origin:

| Signal in `ScanResult` | Treat as | Verifier |
|---|---|---|
| Go module path (`github.com/...`, `go.opentelemetry.io/...`, `k8s.io/...`) | Go | `vuln-verify.sh` |
| Debian/Alpine package name (`libssl3`, `musl`, `openssh-client`, `libcrypto3`) or lines that look like `pkg version vuln→fixed` without a module path | OS package | `vuln-verify-os.sh` |
| `groupId:artifactId` pattern (e.g. `org.apache.logging.log4j:log4j-core`, `io.netty:netty-common`) or mentions `.jar` | Java jar | `vuln-verify-java.sh` |
| Node.js package (`brace-expansion`, `lodash`, etc.) + image known to be Node | Node | Manual (no batch verifier yet) |

If `ScanResult` is ambiguous, run `scripts/query-go-libs.sh <image>` / `query-os-packages.sh` / `query-java-jars.sh` first to see what's actually inside.

### Registry scope: `betprod` vs `betint`

Rows in the Kusto output can reference **two different container registries**:

| Registry | Meaning | How to verify |
|---|---|---|
| `betprod.azurecr.io` | Production. All `vuln-verify*.sh` scripts and every `query-*.sh` helper operate here via the azure-cli pod in bet-prod AKS | The provided scripts (they hard-code `betprod`) |
| `betint.azurecr.io` | **Internal test / NonProd registry.** NOT reachable from the bet-prod AKS azure-cli pod — the pod's workload identity is scoped to subscription `AG_DCX_Lionrock_PROD`, which doesn't own `betint` | **Use the host's local `az` CLI** (run `az login` with an account that has access to the betint-owning subscription), then run `crane` / `az acr manifest list-metadata` locally |

When a Kusto row's `ImageId` starts with `betint.azurecr.io/...`, do not try the pod-based scripts — they'll fail with 401. Either verify from the local machine, or mark the row as "NonProd, out of scope for BET verification tooling" and hand it to the owning team.

## Verification Workflow

### Fast path — one-shot batch verify

When the user just says "verify our vulns" / "run vuln-verify" with no report attached, prefer `batch-verify.py`. It collapses Steps 0–3 into a single parallel pass and auto-handles image dedup, ACR/AKS precheck, completed-pod cleanup, and verification against both the reported digest and the current latest digest.

```bash
./scripts/batch-verify.py --fetch --out /tmp/vuln-report.json
```

Output: per-image verdict table + grouped summary (`FIXED` / `VULNERABLE` / `IMAGE GONE` / `NOT PRESENT` / `SKIPPED`). JSON report at `--out` for further processing.

Typical wall time: ~5–9 min cold, ~1 min with cache. The per-image extract JSONs live at `/tmp/vuln-cache/` so incremental re-runs only re-fetch Kusto and re-verify against cache.

`batch-verify.py` SKIPs Go rows — for those fall back to Step 1 with `vuln-verify.sh` (plus the existing report format). Same for `betint.azurecr.io` rows (see "Registry scope" above).

The manual per-script workflow below is the fallback for when you already have a pasted report, need to verify a single image, or need Go support.

### Step 0 — Fetch and summarize the current vulnerability list (Kusto-driven mode)

Only when there is no pasted/file report. Skip this step if the user already gave you a report.

```bash
# Full JSON dump (default) — pipe to jq for grouping
./scripts/fetch-vulns.py --out /tmp/vulns.json
jq 'length' /tmp/vulns.json

# Quick grouped summary for the user
./scripts/fetch-vulns.py --format summary
```

Before moving on, **present a summary to the user**, including at least:

1. Total active vulnerability count.
2. Breakdown by `SLA` (e.g. how many `OutOfSLA`/`WithinSLA`) and how many are already overdue (`DueDate` < today).
3. Breakdown by `AssetType` (ContainerImage vs VMSS vs VM).
4. Top 10–15 `VulnerabilityName` values with counts — this is the "what are we actually dealing with" list.
5. Top 5–10 `Image` values by count — this tells you which images need the most attention.
6. Brief narrative: "These cluster into N groups — Go module CVEs in tekton/flux, OS package CVEs in base images, Java jar CVEs in elastic-operator, …".

Ask the user whether to proceed with verification for all of them, for a subset (by image / vuln name / SLA bucket), or stop after the summary. Only then move on to Step 1.

### Step 1 — Batch verify module versions in reported images

For a Go vulnerability report, run `scripts/vuln-verify.sh report.txt`. This covers:
- Whether each reported image digest still exists in ACR
- Whether each reported module is still at the vulnerable version inside the Go binary

`[IMAGE GONE]` and `[FIXED]` can be closed immediately. `[VULNERABLE]` and `[NOT PRESENT]` need Step 2.

### Step 2 — Is any vulnerable image still running?

Only matters for entries not already closed by Step 1.

```bash
# Is the exact vulnerable digest running anywhere?
kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[*]}{.metadata.namespace}{"\t"}{.metadata.name}{"\t"}{range .status.containerStatuses[*]}{.imageID}{"\n"}{end}{end}' \
  | grep '<digest-or-repo-keyword>'
```

- Pod runs the reported digest → active vulnerability, remediate
- Pod runs a newer digest → if `[FIXED]` in Step 1 the new image resolves it; if `[VULNERABLE]` the rebuild didn't pick up the fix
- No pod runs it → low priority; image is in registry but unused

### Step 3 — Check newer digests when report cites a gone digest

If `[IMAGE GONE]` in Step 1, the reported digest is no longer in ACR, but there may be a newer digest of the same repo. List it and re-verify:

```bash
kubectl exec deploy/azure-cli -n default -- bash -c \
  "az acr manifest list-metadata --name <repo> --registry betprod --orderby time_desc --top 3"

./scripts/query-go-libs.sh <repo>@<newer-digest> <module-filter>
```

## Decision Table

| ACR Status | AKS Status | `vuln-verify.sh` Result | Action |
|---|---|---|---|
| Reported digest present | Pod runs reported digest | `[VULNERABLE]` | Remediate |
| Reported digest present | Pod runs reported digest | `[FIXED]` | Scanner stale — close |
| Reported digest present | Pod runs newer digest | `[FIXED]` on newer digest | Close |
| Reported digest present | Pod runs newer digest | `[VULNERABLE]` on newer digest | Rebuild didn't pick up fix — investigate `go.mod` / base image |
| Reported digest present | No pod runs it | any | Low priority — unused in registry |
| Reported digest gone | No pod runs it | `[IMAGE GONE]` | Close |
| Reported digest gone | Pod runs newer digest | check newer digest | Re-verify newer digest with Step 3 |

## Common Mistakes

- Assuming a CVE is real without verifying the module version is still embedded in the binary
- Fixing vulnerabilities in images that have already been replaced
- Checking only ACR, not AKS — image in registry doesn't mean it's running
- Assuming a newer image digest means the vulnerability is fixed — rebuilds don't always include the patch
- Forgetting `relogin` before ACR queries (the scripts handle this; manual commands need it)
- Trying to `kubectl exec` into distroless images (no shell) — use `crane export` or the provided scripts
