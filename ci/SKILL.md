---
name: ci
description: Create Azure DevOps work items (PBI, Task, Bug, Feature) from natural language description
allowed-tools: [Bash, Read, AskUserQuestion]
---

# Create Azure DevOps Work Item (ci)

This skill creates Azure DevOps work items from natural language descriptions.

## When to Use

Use this skill when the user:
- Wants to create a PBI, Task, Bug, or Feature in Azure DevOps
- Mentions "ci", "create work item", "create pbi", "create task", "create bug"
- Provides a work item description and wants it tracked in ADO

## Azure DevOps Configuration

```
Organization: https://dev.azure.com/msazure
Project: One
```

## Parent Mapping

| Key | Area Path | Title Keyword |
|-----|-----------|---------------|
| `bet` | One\Azure\Core\Buildout and Decomm\GeoExpansion\Lionrock\Billing | Billing Meter |
| `s360` | One\Azure\Core\Buildout and Decomm\GeoExpansion\Lionrock\Compliance | S360 |
| `lionrock` | One\Azure\Core\Buildout and Decomm\GeoExpansion\Lionrock\Execution\On Demand | On Demand Quota live site |
| `devops` | One\Azure\Core\Buildout and Decomm\GeoExpansion\Lionrock\Engineering | DevOps |
| `psl` | One\Azure\Core\Buildout and Decomm\GeoExpansion\Lionrock\Billing | PSL |

## Work Item Types

| Short | Full Type |
|-------|-----------|
| `pbi` | Product Backlog Item |
| `task` | Task |
| `bug` | Bug |
| `feature` | Feature |

## Workflow

### Step 1: Analyze User Input

Parse the user's description and determine:

1. **type**: Choose based on content:
   - `pbi`: Feature development, new functionality (default)
   - `bug`: Bug fix, issue resolution
   - `task`: Smaller task under a PBI (requires parent PBI ID)

2. **parent**: Choose based on context:
   - `psl`: PSL related (highest priority if mentioned)
   - `bet`: Billing meter related
   - `s360`: Security/Quality/Compliance related
   - `lionrock`: Quota project related
   - `devops`: DevOps/operations/infrastructure related

3. **title**: Concise title (under 100 chars)
   - Keep special patterns like [SFI-xxx], [QEI-xxx] as-is
   - Use sentence case

4. **description**: Generate a STRUCTURED markdown description using ADO markdown format:

```markdown
Description
-----------

[One paragraph summary of what needs to be done and why]

### Background

*   [Key context point 1]
*   [Key context point 2]
*   [Reference to any related documents, announcements, or issues]

### [Optional section based on content, e.g., "Migration Options", "Technical Details"]

1.  [Option/Detail 1]
2.  [Option/Detail 2]

Tasks
-----

*   [ ] [Task 1]
*   [ ] [Task 2]
*   [ ] [Task 3]

Acceptance Criteria
-------------------

*   [Criteria 1]
*   [Criteria 2]
*   [Criteria 3]

Timeline
--------

*   **Target completion**: [Date or milestone]
*   **Key dates**: [Any important deadlines]
```

**ADO Markdown Format Rules:**
- H2 headings: Use `---` underline (e.g., `Title\n-----`)
- H3 headings: Use `###` prefix
- Unordered lists: Use `*   ` (asterisk + 3 spaces)
- Ordered lists: Use `1.  ` (number + dot + 2 spaces)
- Checklist items: Use `*   [ ] ` (asterisk + 3 spaces + brackets with space)
- Add blank line after each section

**IMPORTANT**:
- The description should be comprehensive and actionable, NOT a brief one-liner
- Include all relevant context from the user's input
- Use **markdown** format, NOT HTML - ADO renders markdown natively
- The `multilineFieldsFormat` in ADO API response should show `markdown` for the field

5. **completedwork**: Estimate effort in days:
   - Simple (config, doc, one-line): 0.1 - 0.3
   - Small (minor fixes, simple features): 0.5 - 1.0
   - Medium (standard features): 1.0 - 3.0
   - Large (complex features): 3.0 - 5.0

### Step 2: Confirm with User

Present the generated parameters. Show the FULL description in a code block so user can review:

```
==========================================
Work Item Parameters
==========================================
Type:         [type]
Parent:       [parent key or ID]
Title:        [title]
Effort:       [completedwork] days
==========================================

Description:
[Show full markdown description here]
```

Ask user to confirm or modify before creating.

### Step 3: Get Parent Feature ID

If parent is a key (not numeric ID), query the Feature ID:

```bash
az boards query -p "One" --org "https://dev.azure.com/msazure" --wiql "
  SELECT [System.Id] FROM workitems
  WHERE [System.TeamProject]='One'
    AND [System.WorkItemType]='Feature'
    AND [System.AreaPath] = '<area_path>'
    AND [System.Title] CONTAINS '<title_keyword>'
    AND [System.State] NOT IN ('Done', 'Removed')
  ORDER BY [System.Id] DESC
" --query "[].fields.\"System.Id\"" -o tsv | head -n1
```

### Step 4: Get Current Monthly Iteration

```bash
now=$(date +%s)
one_day_ago=$(date -v-1d +%s)  # macOS

az boards iteration project list --path "\\One\\Iteration" -p "One" --org "https://dev.azure.com/msazure" --depth 4 -o json | jq -r --arg now "$now" --arg one_day_ago "$one_day_ago" '
  .children[]? // empty
  | select(.name | startswith("FY"))
  | .children[]? // empty
  | select(.name | startswith("Q"))
  | .children[]? // empty
  | select(.name == "Month")
  | .children[]? // empty
  | select(.attributes.startDate != null and .attributes.finishDate != null)
  | select((.attributes.startDate | fromdateiso8601) < ($now | tonumber))
  | select((.attributes.finishDate | fromdateiso8601) > ($one_day_ago | tonumber))
  | .path | sub("\\\\One\\\\Iteration\\\\"; "One\\")
' | head -n1
```

### Step 5: Create Work Item via REST API

**IMPORTANT: Field Selection by Work Item Type**
- **Bug**: Use `Microsoft.VSTS.TCM.ReproSteps` field (displays as "Repro Steps" in UI)
- **PBI/Task/Feature**: Use `System.Description` field

**CRITICAL**: The `multilineFieldsFormat` MUST be set AT CREATION TIME via REST API. Once a work item is created with HTML format, it CANNOT be converted to Markdown via API. Therefore, we must use the REST API directly (not az boards CLI).

**Work Item Type URL Mapping**:
| Type | URL Parameter |
|------|---------------|
| Bug | `$Bug` |
| Product Backlog Item | `$Product%20Backlog%20Item` |
| Task | `$Task` |
| Feature | `$Feature` |

```bash
# Write description to temp file (MARKDOWN format)
cat > /tmp/wi_desc.txt << 'DESCEOF'
[DESCRIPTION CONTENT HERE - use markdown syntax]
DESCEOF

# Determine field name based on work item type
# For Bug: use Microsoft.VSTS.TCM.ReproSteps
# For PBI/Task/Feature: use System.Description
if [ "$TYPE" = "Bug" ]; then
  FIELD_NAME="Microsoft.VSTS.TCM.ReproSteps"
  TYPE_URL="\$Bug"
elif [ "$TYPE" = "Product Backlog Item" ]; then
  FIELD_NAME="System.Description"
  TYPE_URL="\$Product%20Backlog%20Item"
elif [ "$TYPE" = "Task" ]; then
  FIELD_NAME="System.Description"
  TYPE_URL="\$Task"
else
  FIELD_NAME="System.Description"
  TYPE_URL="\$Feature"
fi

# Get access token for Azure DevOps
TOKEN=$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv)

# Escape description content for JSON (handles newlines and special chars)
DESC_CONTENT=$(cat /tmp/wi_desc.txt | jq -Rs .)

# IMPORTANT: AreaPath and IterationPath need DOUBLE backslashes in JSON
# Example: "One\\\\Azure\\\\Core\\\\..." becomes "One\\Azure\\Core\\..." in the API

# Create work item via REST API with multilineFieldsFormat set at creation
cat > /tmp/wi_create.json << EOF
[
  {"op": "add", "path": "/fields/System.Title", "value": "$TITLE"},
  {"op": "add", "path": "/fields/System.AreaPath", "value": "$AREA_PATH"},
  {"op": "add", "path": "/fields/System.IterationPath", "value": "$ITERATION"},
  {"op": "add", "path": "/fields/System.AssignedTo", "value": "haichang@microsoft.com"},
  {"op": "add", "path": "/fields/${FIELD_NAME}", "value": $DESC_CONTENT},
  {"op": "add", "path": "/multilineFieldsFormat/${FIELD_NAME}", "value": "Markdown"}
]
EOF

# Create work item - note the escaped $ in the URL
ID=$(curl -s -X POST \
  "https://dev.azure.com/msazure/One/_apis/wit/workitems/${TYPE_URL}?api-version=7.2-preview.3" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json-patch+json" \
  -d @/tmp/wi_create.json | jq -r '.id')

echo "Created work item: $ID"

# Verify markdown format was set correctly
curl -s "https://dev.azure.com/msazure/One/_apis/wit/workitems/${ID}?api-version=7.2-preview.3&\$expand=all" \
  -H "Authorization: Bearer $TOKEN" | jq '.multilineFieldsFormat'

# Set parent relationship
az boards work-item relation add \
  --org "https://dev.azure.com/msazure" \
  --id "$ID" \
  --target-id "$PARENT_ID" \
  --relation-type parent -o none

# Set completed work (if provided)
az boards work-item update \
  --id "$ID" \
  --org "https://dev.azure.com/msazure" \
  --fields "Microsoft.VSTS.Scheduling.CompletedWork=$COMPLETED_WORK" -o none

# Set state to Active
az boards work-item update \
  --org "https://dev.azure.com/msazure" \
  --id "$ID" \
  -f State="Active" -o none

# Copy ID to clipboard and open in browser
echo -n "$ID" | pbcopy
az boards work-item show \
  --org "https://dev.azure.com/msazure" \
  --id "$ID" \
  --open
```

### Step 5b: Verify Markdown Format

After creation, verify the `multilineFieldsFormat` shows `markdown` (not `html`):

```bash
curl -s "https://dev.azure.com/msazure/One/_apis/wit/workitems/${ID}?api-version=7.2-preview.3&\$expand=all" \
  -H "Authorization: Bearer $TOKEN" | jq '.multilineFieldsFormat'

# Expected output for Bug:
# {
#   "Microsoft.VSTS.TCM.ReproSteps": "markdown",
#   "Microsoft.VSTS.Common.Resolution": "html"
# }
```

### Step 6: Report Result

Show the created work item ID and copy to clipboard:
```bash
echo -n "$ID" | pbcopy
```

## Example: Full Description Generation

**User Input:**
"Migrate from ingress-nginx to AKS Gateway API before November 2026 retirement"

**Generated Description (ADO Markdown Format):**

```markdown
Description
-----------

The ingress-nginx project is being retired in March 2026 due to inadequate maintenance and security concerns. We need to evaluate and migrate to a supported alternative to avoid security risks and ensure continued compliance.

### Background

*   Upstream ingress-nginx development ends March 2026
*   No further security patches after retirement (vulnerabilities may become zero-day exploits)
*   AKS App Routing extended support ends November 2026
*   Reference: AzRel Red Flag - ingress-nginx Retirement

### Migration Options

1.  **Gateway API backend** (AKS App Routing) - Preview March 2026, GA May 2026
2.  **Istio add-on** - Gateway API support GA expected May 2026
3.  **App Gateway for Containers**

Note: None of the alternatives are drop-in replacements.

Tasks
-----

*   [ ] Inventory current ingress-nginx usage across clusters
*   [ ] Evaluate migration options based on our requirements
*   [ ] Create POC with selected alternative
*   [ ] Document migration plan and rollback strategy
*   [ ] Execute migration in non-prod environment
*   [ ] Execute migration in prod environment
*   [ ] Validate and monitor post-migration

Acceptance Criteria
-------------------

*   All ingress-nginx dependencies removed
*   Traffic routing works as expected with new solution
*   No service disruption during migration
*   Documentation updated

Timeline
--------

*   **Target completion**: Before November 2026
*   **Recommended start**: After May 2026 (when alternatives reach GA)
```

## Important Notes

- Generate STRUCTURED markdown descriptions, not brief summaries
- Always confirm parameters with user before creating
- Use English for all fields (title, description)
- Copy work item ID to clipboard after creation
- Open work item in browser for user to review

### Critical: Markdown Format

- **MUST use REST API** to create work items (not `az boards work-item create`)
- **MUST set `multilineFieldsFormat`** at creation time - cannot convert HTML to Markdown later
- **Bug type**: Use `Microsoft.VSTS.TCM.ReproSteps` field
- **PBI/Task/Feature**: Use `System.Description` field
- **Verify format** after creation by checking `multilineFieldsFormat` in API response

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| Content shows as plain text | `multilineFieldsFormat` not set | Must set at creation via REST API |
| "Invalid patch document" | JSON escape issues | Use `jq -Rs` to escape content |
| Backslashes not working in paths | Single backslash in JSON | Use `\\\\` (double-escaped) for paths |
