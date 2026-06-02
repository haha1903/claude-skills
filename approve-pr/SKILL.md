---
name: approve-pr
description: Use when the user wants to approve an Azure DevOps pull request by providing a PR URL or PR ID.
---

# Approve Azure DevOps PR

Approve an Azure DevOps PR via `az repos pr set-vote`. Accepts a PR URL or numeric PR ID.

## Usage

The user provides one of:
- A full PR URL: `https://dev.azure.com/msazure/One/_git/.../pullrequest/15496153`
- A numeric PR ID: `15496153`

## Steps

1. Extract the PR ID from the input (parse from URL if needed — match `pullrequest/(\d+)`).
2. Run:

```bash
az repos pr set-vote \
  --id <PR_ID> \
  --vote approve \
  --org https://dev.azure.com/msazure \
  --detect false
```

3. Report the result to the user.

## Notes

- Org is hardcoded to `https://dev.azure.com/msazure`.
- No `--project` flag — `set-vote` does not support it.
- User must be logged in via `az login` first.
