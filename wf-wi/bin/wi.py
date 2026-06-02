#!/usr/bin/env python3
"""
wf-wi: non-interactive work-item creation for tasks-gateway pr-workflow tasks.

Mirrors ~/bin/cpr's "AI generates work item from git diff" path, with all
prompt_user_review() interactions removed — the agent runs in a non-TTY pipe
and any prompt would deadlock. Outputs the new work item as JSON on stdout so
the caller (playbook) can feed it to `wf-pr create --work-items <id>`.
"""

import argparse
import json
import subprocess
import sys

from ado_lib import (
    FeatureMap,
    log_to_file, error_exit, set_debug,
    get_work_item_type, get_type_from_id, get_parent_info,
    get_iteration_path, create_work_item, update_state, set_completed_work,
    generate_with_ai, parse_ai_response,
)

LOG_FILE = "/tmp/wf-wi.log"

# Same prompt cpr uses, kept inline so a host-side cpr edit doesn't drift this
# tool. If you change cpr's prompt and want this tool to follow, copy it here.
AI_PROMPT = '''You are a work item generator for Azure DevOps. Based on the provided git commit messages and code changes, generate a structured JSON output for creating a work item.

Analyze the content and determine:
1. **type**: Choose one of: "pbi" (feature development), "bug" (bug fix)
   - IMPORTANT: Do NOT generate "task" type. Use "pbi" for feature development and "bug" for bug fixes only.
2. **parent**: Choose the most relevant feature shortcut from the available options. The valid keys will be provided in the input context.
3. **title**: A concise title that clearly describes what needs to be done. If the content contains patterns like [SFI-xxx] or [QEI-xxx], use them as-is in the title. Use title case for the first letter only, not every word.
4. **description**: A brief description with more details. If there are special patterns in the title, explain them here.
5. **completedwork**: Estimate effort in days based on code changes
   - Tiny changes (1-10 lines, config/docs): 0.1 - 0.3
   - Small changes (10-50 lines, simple logic): 0.3 - 0.5
   - Medium changes (50-200 lines, multiple files): 0.5 - 1.5
   - Large changes (200-500 lines, complex logic): 1.5 - 3.0
   - Very large changes (500+ lines, major refactoring): 3.0 - 5.0
   - Use decimals for precision (e.g., 0.3, 0.5, 1.0, 2.0)

Output ONLY a valid JSON object with this exact structure:
{
  "type": "pbi|bug",
  "parent": "<one of the available feature keys>",
  "title": "Your generated title",
  "description": "Your generated description",
  "completedwork": 0.5
}

Requirements:
- Use English for all fields
- Be concise and clear
- Title should be under 100 characters
- Description should be under 500 characters
- Default to "pbi" for most development work
- Output ONLY the JSON object, no other text'''


def run_git(*args):
    r = subprocess.run(["git"] + list(args), capture_output=True, text=True)
    return r.stdout.strip(), r.returncode


def detect_default_branch():
    out, rc = run_git("symbolic-ref", "refs/remotes/origin/HEAD")
    if rc == 0 and out:
        return out.replace("refs/remotes/origin/", "")
    return "master"


def get_git_content(target_branch):
    git_log, _ = run_git("log", f"{target_branch}..HEAD", "--pretty=format:%h - %s%n%b")
    if not git_log:
        error_exit(f"No commits between {target_branch}..HEAD; nothing to summarize")
    git_stat, _ = run_git("diff", f"{target_branch}..HEAD", "--stat")
    full_diff, _ = run_git("diff", f"{target_branch}..HEAD")
    diff_lines = len(full_diff.split("\n"))
    if diff_lines > 1500:
        git_patch = f"[Diff too large - {diff_lines} lines. Using stats summary above instead of full diff.]"
    else:
        git_patch = full_diff
    return (
        f"=== Commit Messages ===\n{git_log}\n\n"
        f"=== Changes Summary ===\n{git_stat}\n\n"
        f"=== Code Changes ===\n{git_patch}"
    )


def main():
    p = argparse.ArgumentParser(prog="wi.py")
    sub = p.add_subparsers(dest="cmd", required=True)
    c = sub.add_parser("create-from-diff", help="AI-generate + create a work item from the current git diff")
    c.add_argument("--target", help="Target branch for diff (default: origin's default)")
    c.add_argument("--type", dest="type_short", help="Override AI type: pbi|bug")
    c.add_argument("--parent", help="Override AI parent: feature alias or numeric id")
    c.add_argument("--title", help="Override AI title")
    c.add_argument("--description", help="Override AI description")
    c.add_argument("--debug", action="store_true")
    args = p.parse_args()

    if args.cmd != "create-from-diff":
        p.print_help()
        sys.exit(2)

    set_debug(args.debug)
    log_to_file("========== wf-wi create-from-diff ==========", LOG_FILE)

    _, rc = run_git("rev-parse", "--git-dir")
    if rc != 0:
        error_exit("Not in a git repository")

    target = args.target or detect_default_branch()
    log_to_file(f"target branch: {target}", LOG_FILE)

    feature_map = FeatureMap()
    feature_map.load()

    # If parent is numeric, derive type from it (Feature -> PBI, PBI -> Task).
    type_short = args.type_short
    parent_name = args.parent
    if parent_name and parent_name.isdigit() and not type_short:
        parent_type = get_type_from_id(parent_name, log_file=LOG_FILE)
        if parent_type == "Feature":
            type_short = "pbi"
        elif parent_type == "Product Backlog Item":
            type_short = "task"

    # AI generation. No prompt_user_review — non-interactive by design.
    title = args.title
    description = args.description
    completed_work = None

    if not (title and parent_name and type_short and description):
        diff_text = get_git_content(target)
        ai_json = generate_with_ai(diff_text, AI_PROMPT, feature_map)
        if not ai_json:
            error_exit("AI generation failed — no response")
        log_to_file(f"AI response: {ai_json}", LOG_FILE)
        params = parse_ai_response(ai_json)
        if not params or not params.get("type") or not params.get("title"):
            error_exit(f"AI returned unusable response: {ai_json[:300]}")
        # CLI flags override; otherwise take AI fields.
        type_short = type_short or params["type"]
        parent_name = parent_name or params["parent"]
        title = title or params["title"]
        description = description or params.get("description", "")
        completed_work = params.get("completedwork")

    # Defaults if still missing.
    if not type_short:
        type_short = "pbi"
    if not parent_name:
        first = feature_map.first_key()
        if not first:
            error_exit("No --parent given and no features loaded from ADO")
        parent_name = first

    parent_id, area_path, parent_type = get_parent_info(parent_name, feature_map, log_file=LOG_FILE)
    wi_type = get_work_item_type(type_short)

    # Match cpr's safety: if parent is Feature but type is Task, escalate to PBI.
    if parent_type == "Feature" and wi_type == "Task":
        wi_type = "Product Backlog Item"

    iteration = get_iteration_path(log_file=LOG_FILE)

    new_id = create_work_item(
        title=title, wi_type=wi_type, iteration=iteration,
        parent_id=parent_id, area_path=area_path,
        description=description, debug=args.debug, log_file=LOG_FILE,
    )
    if completed_work:
        set_completed_work(new_id, completed_work, debug=args.debug, log_file=LOG_FILE)

    # Mirror cpr: move state to In Review immediately so the PR side is consistent.
    update_state(new_id, "In Review", debug=args.debug, log_file=LOG_FILE)

    print(json.dumps({
        "id": str(new_id),
        "type": wi_type,
        "title": title,
        "parentId": str(parent_id),
        "parentType": parent_type,
    }, indent=2))


if __name__ == "__main__":
    main()
