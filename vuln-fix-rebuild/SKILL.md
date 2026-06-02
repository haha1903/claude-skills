---
name: vuln-fix-rebuild
description: Use when vulnerability fix requires triggering Tekton pipeline rebuilds with force-rebuild, monitoring pipeline progress, and verifying images are updated in the cluster
---

# Vulnerability Fix - Rebuild and Verify

Trigger pipeline rebuilds and verify that fixed images are deployed.

## When to Use

- After vuln-fix-patch (committed go.mod replace directives)
- When upstream already has the fix and a simple rebuild picks it up
- When OS packages need updating via base image rebuild
- Weekly rebuild verification

## Pipeline Run Order

**toolchain-build FIRST** (base images), then **tekton-build + flux-build** (can run in parallel).

## Trigger Pipeline Run

```bash
kubectl create -f - <<'EOF'
apiVersion: tekton.dev/v1
kind: PipelineRun
metadata:
  generateName: <pipeline-name>-vuln-fix-
  namespace: default
  labels:
    azure.workload.identity/use: "true"
spec:
  pipelineRef:
    name: <pipeline-name>
  params:
    - name: force-rebuild
      value: "true"
  workspaces:
    - name: shared-workspace
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          resources:
            requests:
              storage: 10Gi
  taskRunTemplate:
    serviceAccountName: tekton-builder
  timeouts:
    pipeline: 1h0m0s
EOF
```

Pipeline names: `toolchain-build`, `tekton-build`, `flux-build`, `misc-build`

## Monitor Progress

```bash
# Watch pipeline logs
tkn pipelinerun logs <run-name> -f -n default

# Watch pod rollout
kubectl get pods -n tekton-pipelines -w
kubectl get pods -n flux-system -w
```

## Verify Fix

```bash
# Confirm image digests changed
kubectl get pods --all-namespaces \
  -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.imageID}{"\n"}{end}{end}' \
  | grep -E "(tekton|flux)" | sort -u
```

## Critical Warning

**Do NOT delete ACR tags to force rebuild.** Tekton runtime images (entrypoint, nop, sidecarlogresults, workingdirinit) are required for pipeline execution. Deleting them breaks ALL pipeline runs. Use `force-rebuild: "true"` parameter instead.

## Weekly Automated Rebuilds

CronJobs in `cronjob-image-sync.yaml` already run weekly with `force-rebuild: "true"`:

| Day | Pipeline |
|-----|----------|
| Sunday 2:00 AM | tekton-build |
| Monday 2:00 AM | flux-build |
| Tuesday 2:00 AM | toolchain-build |
| Wednesday 2:00 AM | misc-build |
