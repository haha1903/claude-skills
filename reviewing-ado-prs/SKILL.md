---
name: reviewing-ado-prs
description: Use when the user asks to review an Azure DevOps pull request, provides a dev.azure.com PR URL, or wants review comments posted back as inline threads on an ADO PR.
---

# Reviewing ADO Pull Requests

Rigorous, severity-tiered review of Azure DevOps pull requests with comments delivered inline via the ADO REST API.

## When to use

- User pastes `https://dev.azure.com/.../pullrequest/<id>` and asks to review it
- User wants a **strict** review (surface everything worth flagging, not just obvious defects)
- User wants comments posted to the PR, not just shown in chat

## When NOT to use

- Local branch review without a PR — use plain `git diff`
- GitHub PRs — use `gh` instead of ADO API
- Quick sanity check — skip this skill, just read the diff

## Review discipline

- Three severity tiers in your private notes: **Blocking** (merge-blocking), **Concerns** (author must answer), **Nits** (optional polish)
- Every comment states the problem, references `file:line`, and asks a question when possible
- **Do NOT prescribe the fix.** The submitter decides how to fix; the reviewer identifies what's wrong. "Why `Contains`?" beats "change to `HashSet`"
- Each comment must be self-contained — readable without scrolling to other threads
- Before posting: reread each comment and strip any sentence that tells the author what code to write

## Read strategy

For PRs over ~500 lines, **never read sequentially file-by-file**. Read by layer, in parallel:

1. Core new modules (domain logic)
2. Integration points (where new code hooks into existing)
3. Public API / schema changes
4. Tests (coverage + assertion strength; look for blind spots where tests assert text but not numbers / positions)
5. Docs / config drift

## Key commands

| Step | Command |
|------|---------|
| PR metadata | `az repos pr show --id <id> --org <org>` (capture `lastMergeBase`, `lastMergeSourceCommit`, `sourceRefName`) |
| Repo ID | `az repos show --repository <name> --org <org> --project <proj> --query id -o tsv` |
| Fetch branch | `git fetch origin <sourceBranchName>` |
| Diff stat | `git diff --stat <base>..<head>` |
| Read file at PR commit | `git show "<commit>:<path>"` (quote the whole ref-colon-path under zsh) |
| Access token | `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken -o tsv` |

## Before posting to the PR — confirm with the user

**Ask only one question: scope.** The other three choices are already settled by default for this user — do not re-ask them.

- **Scope (ASK)** — Blocking-only first is a safe default, not the full 40-comment wall. Author observation & response quality drops fast past ~15 inline comments. Present scope tiers as options (e.g. Blocking only / Blocking + top Concerns / everything).
- **Language (fixed default: English)** — do not ask; the author list for this user's ADO work is non-Chinese-reading. Only switch if the user volunteers otherwise.
- **Thread status (fixed default: Active, `status: 1`)** — do not ask. Reviewer comments that do not require an answer are rare and the user will say so explicitly.
- **Identity (fixed default: current `az login` account)** — do not ask. The user already knows this is how ADO auth works; asking is noise.

## REST payload

Endpoint:

```
POST https://dev.azure.com/<org>/<project>/_apis/git/repositories/<repoId>/pullRequests/<prId>/threads?api-version=7.0
```

Body:

```json
{
  "comments": [
    { "parentCommentId": 0, "content": "<markdown>", "commentType": 1 }
  ],
  "status": 1,
  "threadContext": {
    "filePath": "/src/path/to/file.cs",
    "rightFileStart": { "line": 34, "offset": 1 },
    "rightFileEnd":   { "line": 34, "offset": 1 }
  }
}
```

- `filePath` **must** start with `/`
- `status: 1` = Active, `status: 2` = Fixed, `status: 4` = ByDesign
- `commentType: 1` = Text, `commentType: 2` = CodeChange
- For overall (non-inline) comment, omit `threadContext` entirely

See `post-threads.sh` in this skill directory for a working batch-poster driven by a small `COMMENTS` array — adapt, do not rewrite from scratch.

## Common pitfalls

| Pitfall | Note |
|---------|------|
| `$PR:path` in zsh | Triggers `:s` parameter modifier, mangles the argument. Quote as `"$PR:path"` or `"${PR}:path"` |
| Prescribing fixes | Reviewer identifies, author decides. Strip "change to X" sentences before posting |
| Batch-posting all comments | Defaults to Blocking-only until author responds. Large drops hurt discussion quality |
| Non-English comments to unknown authors | Default English; offer bilingual only if user confirms |
| Missing leading `/` in `filePath` | API accepts it but PR UI won't link the thread to the file |
| Summarizing review in chat only | User often wants the comments posted to the PR — confirm scope first, don't assume |
| Forgetting to state problem + ask a question | "This looks fragile" is noise; "Why regex a human-readable message instead of structured data?" is actionable |

## Typical flow

1. Extract PR ID from URL (`pullrequest/(\d+)`)
2. `az repos pr show` → capture metadata
3. `git fetch origin <sourceRef>` → local PR branch available
4. `git diff --stat <base>..<head>` → file-layer triage
5. Layered parallel reads via `git show "<commit>:<path>"`
6. Draft tiered review in chat; surface Concerns and Nits for user sight
7. Ask the scope clarification question above (language / status / identity use the fixed defaults, do not ask)
8. Write each comment body to its own `/tmp/<label>.txt` (avoids JSON escape pain)
9. Run `post-threads.sh` with a `COMMENTS` array mapping `filepath|line|body-file|label`
10. Report thread IDs back with a clickable URL per thread:
    `https://dev.azure.com/<org>/<project>/_git/<repo>/pullrequest/<id>?discussionId=<threadId>`
