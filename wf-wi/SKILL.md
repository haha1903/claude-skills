---
name: wf-wi
description: Create an Azure DevOps work item from a git diff for tasks-gateway pr-workflow tasks. Non-interactive: AI-generates type/parent/title/description from the diff, picks a parent from the user's active Lionrock features, and creates the work item via az. Returns JSON with the new id so wf-pr create can link it. Use when the task prompt does NOT name an existing work item id.
---

# wf-wi

Non-interactive work-item creation for workflow tasks. Uses the shared `msapi`
library (`msapi.boards` for work items, `msapi.aigen` for AI generation) so
cpr's AI-generation logic is reused without any prompt-for-confirmation step.

## Prerequisite

- `az` authenticated for Azure DevOps on dev.azure.com/msazure (same as wf-pr).
- Run from inside the worktree of the BET repo (or any repo whose changes
  define the diff). The skill reads `git diff <target>..HEAD` to feed the AI.
- `msapi` importable (pip-installed in the container; `pip install -e ~/Projects/msapi` locally).

## Command

```
bin/wi.py create-from-diff [--target master] [--type pbi|bug] [--parent <feature-key-or-id>] [--title T] [--description D]
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
2. `generate_with_ai(diff, AI_PROMPT, FeatureMap)` returns
   `{type, parent, title, description, completedwork}` JSON.
3. `parse_ai_response` -> sanity check; CLI flags override AI fields.
4. `get_parent_info(parent)` resolves parent id + area path + parent type.
5. `create_work_item(title, type, iteration, parent_id, area_path, description)`
   creates the item via `az boards work-item create`.
6. `set_completed_work(id, completedwork)` sets the estimate.
7. `update_state(id, "In Review")` advances state (matches cpr behavior).

Returns the new id on stdout. The caller (playbook) feeds it to
`wf-pr create --work-items <id>`.
