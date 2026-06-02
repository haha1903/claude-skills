#!/bin/bash
#
# Batch-post inline review comments to an Azure DevOps pull request.
#
# Requires: az login (current account is used as the comment author).
#
# Usage:
#   1. Fill in env vars ADO_ORG / ADO_PROJECT / ADO_REPO_ID / ADO_PR_ID,
#      or edit the defaults below.
#   2. Write each comment body to its own plain-text file (e.g. /tmp/b1.txt).
#      Markdown is rendered by ADO. No JSON escaping needed — the script
#      passes the file through python3 json.dumps.
#   3. Edit the COMMENTS array: one entry per thread, formatted as
#        "filepath|line|body-file|label"
#      filepath must start with "/".
#   4. Run: bash post-threads.sh
#
# To post an overall (non-inline) comment, set filepath to "" and line to 0 —
# the script will omit threadContext for that entry.

set -e

ORG="${ADO_ORG:-https://dev.azure.com/msazure}"
PROJECT="${ADO_PROJECT:-One}"
REPO_ID="${ADO_REPO_ID:?set ADO_REPO_ID — get via: az repos show --repository <name> --org \$ORG --project \$PROJECT --query id -o tsv}"
PR_ID="${ADO_PR_ID:?set ADO_PR_ID}"

# Azure DevOps OAuth resource GUID — stable, don't change.
RESOURCE="499b84ac-1321-427f-aa17-267ca6975798"
TOKEN=$(az account get-access-token --resource "$RESOURCE" --query accessToken -o tsv)

# Edit this array. One line per thread.
# Format: "filepath|line|body-file|label"
COMMENTS=(
  "/src/path/to/file.cs|34|/tmp/b1.txt|B1"
  "/src/path/to/other.ts|44|/tmp/b2.txt|B2"
)

post_thread() {
  local path="$1"
  local line="$2"
  local body_file="$3"
  local label="$4"

  local payload
  payload=$(python3 -c "
import json
content = open('$body_file').read()
body = {
  'comments': [{'parentCommentId': 0, 'content': content, 'commentType': 1}],
  'status': 1,
}
if '$path' and int('$line') > 0:
    body['threadContext'] = {
        'filePath': '$path',
        'rightFileStart': {'line': $line, 'offset': 1},
        'rightFileEnd':   {'line': $line, 'offset': 1},
    }
print(json.dumps(body))
")

  local response
  response=$(curl -s -X POST \
    "$ORG/$PROJECT/_apis/git/repositories/$REPO_ID/pullRequests/$PR_ID/threads?api-version=7.0" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "$payload")

  echo "$response" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if 'id' in d:
    ctx = d.get('threadContext') or {}
    fp = ctx.get('filePath', '(overall)')
    ln = (ctx.get('rightFileStart') or {}).get('line', '-')
    print(f'[$label] thread {d[\"id\"]} -> {fp}:{ln}')
else:
    print(f'[$label] FAILED: {json.dumps(d)[:300]}')
"
}

for entry in "${COMMENTS[@]}"; do
  IFS='|' read -r path line body_file label <<< "$entry"
  post_thread "$path" "$line" "$body_file" "$label"
done
