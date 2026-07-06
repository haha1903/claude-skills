#!/usr/bin/env python3
"""Append one JSONL line recording a wiki query to <WIKI_ROOT>/<wiki>/queries.log.

Called by the wiki-query skill after a task answers a question from the wiki.
The task passes only what it already knows (question / pages / answered / note);
every other field is derived here for free (no extra work for the task).

Pure stdlib, no network, no LLM. A write failure is non-fatal: it warns to
stderr and exits 0 so it never blocks the task's answer.
"""
import argparse
import json
import os
import socket
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path


def default_wiki_root() -> str:
    return os.environ.get("WIKI_ROOT") or os.path.expanduser("~/Projects/wiki")


def _wiki_commit(wiki_root: str) -> str:
    """Short HEAD sha of the wiki repo, or '' if not a git repo / git absent."""
    try:
        out = subprocess.run(
            ["git", "-C", wiki_root, "rev-parse", "--short", "HEAD"],
            capture_output=True, text=True, timeout=5,
        )
        return out.stdout.strip() if out.returncode == 0 else ""
    except Exception:  # noqa: BLE001 — git missing, timeout, etc.
        return ""


def build_record(wiki, question, pages, answered, note, *, cwd, wiki_root) -> dict:
    return {
        "ts": datetime.now(timezone.utc).isoformat(),
        "task": os.path.basename(os.path.normpath(cwd)),
        "wiki": wiki,
        "wikiCommit": _wiki_commit(wiki_root),
        "host": socket.gethostname(),
        "question": question,
        "pages": pages,
        "pageCount": len(pages),
        "answered": answered,
        "note": note,
    }


def append_log(wiki_root, wiki, record) -> None:
    """Append one JSONL line. Best-effort: warn on failure, never raise."""
    try:
        log_path = Path(wiki_root) / wiki / "queries.log"
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with open(log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:  # noqa: BLE001
        print(f"[wiki-query] failed to write queries.log: {e}", file=sys.stderr)


def main(argv=None) -> int:
    p = argparse.ArgumentParser(description="Log a wiki query to queries.log")
    p.add_argument("--wiki", required=True)
    p.add_argument("--question", required=True)
    p.add_argument("--pages", default="", help="comma-separated wiki-relative page paths")
    p.add_argument("--answered", default="true", choices=["true", "false"])
    p.add_argument("--note", default="")
    args = p.parse_args(argv)

    wiki_root = default_wiki_root()
    pages = [s.strip() for s in args.pages.split(",") if s.strip()]
    record = build_record(
        wiki=args.wiki, question=args.question, pages=pages,
        answered=(args.answered == "true"), note=args.note,
        cwd=os.getcwd(), wiki_root=wiki_root,
    )
    append_log(wiki_root, args.wiki, record)
    return 0


if __name__ == "__main__":
    sys.exit(main())
