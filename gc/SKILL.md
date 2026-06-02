---
name: gc
description: Execute gc command for AI-generated Git commits when user mentions "gc"
allowed-tools: [Bash, Read, AskUserQuestion]
---

# Git Commit with AI-generated Message (gc)

This skill executes the `gc` command for intelligent Git commits with AI-generated messages.

## When to Use

Use this skill when the user mentions **"gc"** in their message.

Examples:
- "gc"
- "run gc"
- "gc -n"
- "gc squash"
- "use gc to commit"

## Command: gc

The `gc` command provides AI-powered Git commits with automatic staging and message generation.

## Core Features

### AI-Powered Commit Messages
- Analyzes Git diff using AI
- Generates professional commit messages
- Follows Git standard format (subject + body)
- Supports exclude patterns for sensitive files

### Smart Workflow
- Automatically stages all changes (`git add -A`)
- Generates commit message from diff
- Auto-confirms with `-y` flag (required for non-interactive mode)
- Optional push to remote

## Command Options

| Option | Description | Usage |
|--------|-------------|-------|
| `-y` | **Auto-confirm (REQUIRED)** | Always include in skill |
| `-n` | No push to remote | Local commit only |
| `-a` | Amend/squash commits | Clean up feature branch |
| `-b` | Trigger Azure DevOps build | Start pipeline after push |

## Common Scenarios

### Scenario 1: Commit and Push (DEFAULT)
```bash
gc -y
```
- Stages all changes
- Generates AI commit message
- Commits and pushes to remote

**Use when**: User says "gc" without specifying push behavior. **This is the default.**

### Scenario 2: Commit Only (No Push)
```bash
gc -y -n
```
- Stages all changes
- Generates AI commit message
- Commits locally
- **Does NOT push** to remote

**Use when**: User explicitly says "no push", "-n", "don't push", or "local only"

### Scenario 3: Squash Commits (Amend)
```bash
gc -y -a
```
- Creates backup branch
- Squashes all commits since master/main
- Regenerates single commit message
- Force-pushes with `--force-with-lease`

**Use when**: Cleaning up feature branch before merge

### Scenario 4: Squash + No Push
```bash
gc -y -a -n
```
- Squashes commits locally
- **Does NOT** force-push

**Use when**: Want to review before pushing

### Scenario 5: Commit and Trigger Build
```bash
gc -y -b
```
- Commits and pushes
- Triggers Azure DevOps pipeline build

**Use when**: Need to start build immediately after commit

### Scenario 6: Squash + Build
```bash
gc -y -a -b
```
- Squashes commits
- Pushes to remote
- Triggers pipeline build

**Use when**: Cleaning up branch and starting build

## Important Notes

### Always Include `-y` Flag

**CRITICAL**: The `-y` flag MUST be included in all gc commands when used in skills.

**Reason**: Skills cannot handle interactive prompts. Without `-y`, the command will wait for user input and hang.

**Correct**: `gc -y`, `gc -y -n`, `gc -y -a`
**Wrong**: `gc`, `gc -n`, `gc -a`

### Amend Mode Behavior

When using `-a` (amend/squash):

1. **Backup created**: `<branch>-bak` (e.g., `feature-bak`)
2. **Auto-rebase**: If base branch (master/main) moved forward
3. **Single commit check**: If only 1 commit, operation cancelled with `-y`
4. **Force-push**: Uses `--force-with-lease` for safety
5. **Cleanup**: Auto-deletes useless backup branches if cancelled

**Warning**: Rewrites commit history. Use with caution on shared branches.

### Build Trigger

Requires `ado.build` git config:
```bash
git config ado.build 12345
```

If not set, command will prompt (but skills can't handle this).

## Parameter Decision Matrix

| User Intent | Command | Flags |
|-------------|---------|-------|
| **Default ("gc")** | `gc -y` | `-y` |
| Explicitly no push | `gc -y -n` | `-y` `-n` |
| Squash commits | `gc -y -a` | `-y` `-a` |
| Squash (no push) | `gc -y -a -n` | `-y` `-a` `-n` |
| Commit + build | `gc -y -b` | `-y` `-b` |
| Squash + build | `gc -y -a -b` | `-y` `-a` `-b` |

**IMPORTANT**: Only add `-n` when the user explicitly requests no push. Bare "gc" means commit AND push.

## Exclude Patterns

Manage files excluded from commit or AI message generation:

```bash
# List exclude patterns
gc exclude --list
gc exclude-commit --list

# Add patterns
gc exclude --add "build" "dist" "*.log"
gc exclude-commit --add ".env" "*.config"
```

**Pattern Types**:
- `gc.exclude`: Files committed but excluded from AI message
- `gc.exclude-commit`: Files not staged or committed at all

## Prerequisites

Before using gc:
- `ai` command available in PATH (for message generation)
- Git repository initialized
- Changes to commit (or use `-b` to trigger build only)
- For `-b` flag: `ado.build` git config set

## Error Handling

### No changes to commit
- Command succeeds but shows "nothing to commit"
- If `-b` flag present, still triggers build

### Only 1 commit with `-a -y`
- Operation automatically cancelled
- Shows message: "Only 1 commit found, operation cancelled"

### Build config missing
- Error if `ado.build` not configured with `-b` flag
- Solution: Set config manually before using `-b`

## Command Reference

**Location**: `/Users/haichang/bin/gc`

**Full syntax**:
```bash
gc [OPTIONS]
gc exclude [SUBCOMMAND]
gc exclude-commit [SUBCOMMAND]
```

**Required for skills**: Always include `-y` flag

**Common combinations**:
- `gc -y` - Commit and push (**default** when user just says "gc")
- `gc -y -n` - Commit, no push (only when user explicitly requests)
- `gc -y -a` - Squash and push (cleanup branch)
- `gc -y -b` - Commit, push, and build (CI/CD trigger)
