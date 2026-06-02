---
name: write-investigation-report
description: Use when a research or investigation session is wrapping up and findings need to be compiled into a structured document. Triggers: "write up findings", "summarize investigation", "document results", "write report", "investigation report", meeting follow-ups with action items, data access requests, troubleshooting sessions.
---

# Write Investigation Report

## Overview

Compile all findings from an investigation or research session into a structured markdown report. Gathers context from meeting notes, documents (PDF/Word), conversation history, action items, and troubleshooting notes, then produces a single comprehensive document.

## When to Use

- After a meeting with action items and follow-up work
- After completing a troubleshooting or research session
- When handing off findings to another team or person
- When documenting data access grants, permission changes, or infrastructure work
- User says "write up the results", "document what we found", "summarize everything"

## Report Structure

Write the report in English. Use the following sections (skip any that don't apply):

```markdown
# [Topic] - Investigation Report

**Date:** YYYY-MM-DD
**Meeting/Context:** [meeting name or investigation context]
**Participants:** [names and roles]

---

## Background
Why this investigation happened. Business context. 1-2 paragraphs max.

## Current State / Workflow
How things work today. Use diagrams or flow notation if helpful:
Submitter -> System A -> System B -> Approval -> Execution

## Problems Identified
### Problem 1: [Name]
- What's broken
- Impact
### Problem 2: [Name]
- ...

## Business Impact
Quantified where possible (hours/week, % of team time, dollar cost).

## Proposed Solutions
| # | Solution | Description |
|---|----------|-------------|

## Action Items
| Owner | Action | Status |
|-------|--------|--------|

## Technical Details
Specific systems, clusters, databases, tables, queries, commands used.

## Troubleshooting Notes
Issues encountered during the investigation and how they were resolved.
Useful for future reference.
```

## Process

1. **Gather**: Review all context in the conversation - meeting notes, documents read, commands run, errors encountered, solutions found
2. **Organize**: Map findings to the report sections above
3. **Quantify**: Include specific numbers, dates, user aliases, system names - no vague references
4. **Write**: Produce the report as `investigation-report.md` (or user-specified filename) in the current working directory
5. **Companion artifacts**: If the investigation produced reply emails, authorization commands, or other actionable outputs, write those as separate files alongside the report

## Common Mistakes

- Writing vague summaries instead of specific findings with names, dates, and numbers
- Forgetting troubleshooting notes (these save hours in future sessions)
- Not including the actual commands/queries used (copy-paste ready)
- Missing action item owners or leaving status blank
