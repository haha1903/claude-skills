---
name: wf-wi
description: Create an Azure DevOps work item from a git diff for tasks-gateway pr-workflow tasks. Non-interactive: AI-generates type/parent/title/description from the diff, picks a parent from the user's active Lionrock features, and creates the work item via az. Returns JSON with the new id so wf-pr create can link it. Use when the task prompt does NOT name an existing work item id.
---

# wf-wi

Non-interactive work-item creation for workflow tasks. Uses the iris SDK
(`boards` for work items, `aigen` for AI generation, via `_iris-shared`) so
cpr's AI-generation logic is reused without any prompt-for-confirmation step.

## Prerequisite

- `az` authenticated for Azure DevOps on dev.azure.com/msazure (same as wf-pr).
- Run from inside the worktree of the BET repo (or any repo whose changes
  define the diff). The skill reads `git diff <target>..HEAD` to feed the AI.
- iris available (auto-built on first `_iris-shared` import; `IRIS_ROOT` in the
  container, `~/Projects/iris` locally).

## Command

```
bin/wi.mjs create-from-diff [--target master] [--type pbi|bug] [--parent <feature-key-or-id>] [--title T] [--description D]
```
Defaults: target = repo's default branch; type/parent/title/description AI-generated.

→ JSON:
```
{ "id": "12345678", "type": "Product Backlog Item", "title": "...", "parentId": "12340000" }
```
Exit 0 on success; non-zero on AI failure / az failure / no diff.

## How it works (matches ~/bin/cpr's non-interactive path)

1. `git diff <target>..HEAD` (subject to a 1500-line cap; falls back to a stat
   summary when too large) feeds the AI prompt.
2. `aigen.generateWithAi(diff, AI_PROMPT, featureMap.keysString())` returns
   `{type, parent, title, description, completedwork}` JSON.
3. `aigen.parseAiResponse` -> sanity check; CLI flags override AI fields.
4. `boards.getParentInfo(parent, featureMap)` resolves parent id + area + type.
5. `boards.createWorkItem({title, wiType, iteration, parentId, areaPath, description})`
   creates the item via the ADO REST API (Markdown description).
6. `boards.setCompletedWork(id, completedwork)` sets the estimate.
7. `boards.updateState(id, "In Review")` advances state (matches cpr behavior).

Returns the new id on stdout. The caller (playbook) feeds it to
`wf-pr create --work-items <id>`.
