---
name: refactor
description: Use after implementing a feature or making changes to review and simplify code. Triggers on "refactor", "simplify", "clean up code", "remove duplication", or when a logical chunk of work is complete and needs polishing.
---

# Refactor

Review changed code for reuse, quality, efficiency, and unnecessary complexity. Then fix issues found.

## Process

1. **Understand the codebase** — read all files in the current directory (recursively). Understand the project structure, dependencies, entry points, and how modules relate to each other. Do NOT use `git diff` — review the full codebase as-is.
2. **Review each file** for:
   - Dead code, unused imports, unreachable branches
   - Duplication — extract shared logic, don't copy-paste
   - Over-engineering — remove abstractions that serve only one caller
   - Comments that describe WHAT (delete) vs WHY (keep)
   - Naming — unclear, inconsistent, or misleading names
   - Parameter sprawl — group related params into a context/options object
   - Leftover debug code, TODOs, or temporary workarounds
   - Inconsistent patterns across files (e.g., error handling, logging, config access)
   - Type safety gaps — missing types, overly broad types, `any` usage
3. **Fix issues** — edit files directly, don't just report
4. **Build and test** — verify nothing broke
5. **Report** — one-line summary of what changed

## Comment Rules

- Default: no comments
- Keep only when the WHY is non-obvious: hidden constraints, subtle invariants, workarounds
- Delete: "this does X", "added for Y feature", "handles the case from issue #123"
- Never add comments that restate the code

## What NOT to Do

- Don't add features or change behavior
- Don't introduce new abstractions "for future use"
- Don't rename things just for style if existing names are clear
