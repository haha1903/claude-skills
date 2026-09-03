---
name: ci
description: Create Azure DevOps work items (PBI, Task, Bug, Feature) from a natural-language description
allowed-tools: [Bash, Read, AskUserQuestion]
---

# Create Azure DevOps Work Item (ci)

Create ADO work items (PBI / Task / Bug / Feature) under the Lionrock area.
**The logic lives in the `~/bin/ci` script** (Node, backed by the iris `boards`
module) — this skill drives that script; do NOT hand-roll `az boards` / REST calls.

Org `https://dev.azure.com/msazure`, project `One`. `~/bin/ci` handles parent
resolution, current-iteration lookup, creation, `Original Estimate`, state=Active,
and clipboard/open.

## Usage — two modes

### Explicit mode (use this when driving it as an agent)

Non-interactive. Pass everything as flags:

```bash
~/bin/ci -m "<title>" -t <pbi|bug|task|feature> -p <parent-alias|feature-id> [-d "<description>"]
```

- `-t` type: `pbi` (default) · `bug` · `task` · `feature`
- `-p` parent: a **feature alias** (below) or a numeric Feature/PBI id. Required.
  - `task` under a specific PBI → pass that PBI's numeric id as `-p`.
- `-d` description: rendered as **Markdown**. For a **Bug** it goes to
  `Microsoft.VSTS.TCM.ReproSteps`; for PBI/Task/Feature to `System.Description`.
  You can pass a full structured Markdown body (headings, lists, checklists).
- `-l` list all feature aliases and their ids: `~/bin/ci -l`
- `~/bin/ci noci` — interactive: toggle the `NOCI` tag on one of your Features
  (skip from CI). **Interactive — run only when the user asks, in a real terminal.**

### AI mode (interactive — user runs it, not the agent)

`~/bin/ci "<free-form description>"` generates the params with AI, then opens an
interactive review loop (approve / regenerate / edit). Because it needs a TTY,
**suggest the user run it themselves** (e.g. `! ~/bin/ci "..."`) rather than
calling it from a tool.

## Parent aliases

Aliases are **generated dynamically** from your active Lionrock Features — the
alias is the first word of the Feature title (e.g. `billing`, `s360`, `sfi`,
`improve`, `enhance`, `develop`, …). They change as Features come and go, so
there is no fixed list.

**Always run `~/bin/ci -l` first** to see the current aliases + their Feature ids
and area paths, then pick the one whose Feature/area matches the work. When
unsure which fits, show the user the `-l` output and ask. You can also pass a
numeric Feature id directly to `-p`.

## Workflow (agent)

1. From the user's request, decide **type** (`bug` for a defect/fix, `pbi` for
   new work, `task` only under a given PBI, `feature` rarely) and **parent alias**.
2. Draft a **concise title** (sentence case, <100 chars; keep `[SFI-xxx]`/`[QEI-xxx]`
   tags as-is) and, if useful, a short description.
3. **Confirm type + parent + title with the user** (AskUserQuestion or inline)
   before creating — creation is a real write.
4. Run the explicit-mode command. Report the new id (it's copied to clipboard and
   opened in the browser by the script).

## Linking a PR to the work item

`~/bin/ci` creates the item but does not link PRs. To attach a PR (so the item
tracks the fix), add an `ArtifactLink` via REST:

```bash
ORG=https://dev.azure.com/msazure
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)
REPO=$(az repos show --org "$ORG" --project One --repository <REPO_NAME> --query id -o tsv)
PROJ=$(az devops project show --org "$ORG" --project One --query id -o tsv)
ART="vstfs:///Git/PullRequestId/${PROJ}%2F${REPO}%2F<PR_ID>"
python3 -c "import json;print(json.dumps([{'op':'add','path':'/relations/-','value':{'rel':'ArtifactLink','url':'$ART','attributes':{'name':'Pull Request'}}}]))" > /tmp/link.json
curl -s -X PATCH "$ORG/One/_apis/wit/workitems/<WI_ID>?api-version=7.2-preview.3" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json-patch+json" -d @/tmp/link.json
```

## Limitations (of `~/bin/ci`)

- AI mode and `noci` are interactive (need stdin) — not agent-runnable; have the
  user run them.
- Does not link PRs — see "Linking a PR" above.

> Fix the script, not this skill, when the creation logic needs to change:
> `~/bin/ci` + the iris `boards` module (`~/Projects/iris/src/boards.ts`) are the
> source of truth.
