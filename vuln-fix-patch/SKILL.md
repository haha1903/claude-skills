---
name: vuln-fix-patch
description: Use when a verified vulnerability requires patching Go dependencies (go.mod replace directives) or Node.js packages in build task yamls for FluxCD, Tekton, or toolchain pipelines
---

# Vulnerability Fix - Patch Dependencies

Fix vulnerabilities by adding go.mod replace directives or updating packages in build task yamls.

## When to Use

- Vulnerability verified as real (use vuln-verify first)
- Fix requires updating Go dependencies, OS packages, or Node.js packages
- Need to modify build pipeline task yamls

## Identify Fix Type

| Vulnerability Type | Example | Fix Method |
|-------------------|---------|------------|
| Go dependency | OTel, aws-sdk, stdlib | `go.mod replace` directive in build task yaml |
| OS package | libcrypto3, musl, openssh | Base image rebuild (apk/apt upgrade - usually automatic) |
| Node.js package | brace-expansion | npm update in build step |

## Check Upstream First

Before patching, check if upstream (tektoncd/pipeline, fluxcd/*) already fixed the dependency. If yes, a rebuild without patching will pick up the fix automatically - use vuln-fix-rebuild instead.

## Build Task YAML Locations

| Component | File |
|-----------|------|
| FluxCD | `deploy/bet-bot/charts/bet-bot-infra/templates/task-fluxcd-build.yaml` |
| Tekton Pipeline | `deploy/bet-bot/charts/bet-bot-infra/templates/task-tekton-build.yaml` |
| Base images | `deploy/bet-bot/charts/bet-bot-infra/templates/pipeline-toolchain-build.yaml` |

## Patching Go Dependencies

### FluxCD: Add replace directives in `clone-and-patch` step

### Tekton: Add replace directives in `clone-source` step, run `go mod tidy` before `ko build`

Example replace directive:
```go
replace golang.org/x/net => golang.org/x/net v0.33.0
```

## Commit and Deploy

```bash
cd deploy/bet-bot
git add charts/bet-bot-infra/templates/<modified-files>
git commit -m "Add go.mod replace directives for <CVE> fixes"
git push origin hai/bot

# Reconcile FluxCD
flux reconcile source git flux-system
flux reconcile kustomization infrastructure
flux reconcile helmrelease bet-bot-infra -n default
```

After committing, use vuln-fix-rebuild to trigger pipeline runs.

## Common Mistakes

- Not running `go mod tidy` after adding replace directives
- Forgetting to reconcile FluxCD after pushing changes
- Patching when upstream already has the fix (wasted effort)
