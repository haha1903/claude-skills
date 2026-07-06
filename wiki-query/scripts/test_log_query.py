import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path

# log-query.py has a hyphen in its name, so import it by file path.
_SPEC = importlib.util.spec_from_file_location(
    "log_query", str(Path(__file__).resolve().parent / "log-query.py"))
log_query = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(log_query)


class BuildRecordTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        # Make WIKI_ROOT a git repo so wikiCommit resolves.
        self.wiki_root = Path(self.tmp) / "wiki"
        (self.wiki_root / "s360-docs").mkdir(parents=True)
        subprocess.run(["git", "init", "-q"], cwd=self.wiki_root, check=True)
        subprocess.run(["git", "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "--allow-empty", "-qm", "init"],
                       cwd=self.wiki_root, check=True)

    def test_record_has_all_fields_and_free_derivations(self):
        cwd = Path(self.tmp) / "Tasks" / "fix-rpaas"
        cwd.mkdir(parents=True)
        rec = log_query.build_record(
            wiki="s360-docs",
            question="how does RPaaS auth work",
            pages=["summaries/arm-rp-rpaas-auth.md", "concepts/rpaas-auth.md"],
            answered=True,
            note="",
            cwd=str(cwd),
            wiki_root=str(self.wiki_root),
        )
        self.assertEqual(rec["wiki"], "s360-docs")
        self.assertEqual(rec["task"], "fix-rpaas")            # from cwd basename
        self.assertEqual(rec["question"], "how does RPaaS auth work")
        self.assertEqual(rec["pages"], ["summaries/arm-rp-rpaas-auth.md", "concepts/rpaas-auth.md"])
        self.assertEqual(rec["pageCount"], 2)                 # derived
        self.assertTrue(rec["answered"])
        self.assertEqual(rec["note"], "")
        self.assertTrue(rec["ts"])                            # non-empty iso ts
        self.assertTrue(rec["host"])                          # hostname
        self.assertRegex(rec["wikiCommit"], r"^[0-9a-f]{7,}$")  # short sha

    def test_wikicommit_empty_when_not_a_git_repo(self):
        non_git = Path(self.tmp) / "plain"
        (non_git / "w").mkdir(parents=True)
        rec = log_query.build_record(
            wiki="w", question="q", pages=[], answered=False, note="",
            cwd=self.tmp, wiki_root=str(non_git))
        self.assertEqual(rec["wikiCommit"], "")               # graceful, not a crash
        self.assertEqual(rec["pageCount"], 0)


class AppendLogTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.wiki_root = Path(self.tmp) / "wiki"
        (self.wiki_root / "s360-docs").mkdir(parents=True)

    def test_creates_then_appends_valid_jsonl(self):
        rec1 = {"question": "q1", "pages": []}
        rec2 = {"question": "q2\nwith newline and \"quotes\"", "pages": ["a.md"]}
        log_query.append_log(str(self.wiki_root), "s360-docs", rec1)
        log_query.append_log(str(self.wiki_root), "s360-docs", rec2)
        logp = self.wiki_root / "s360-docs" / "queries.log"
        lines = logp.read_text().splitlines()
        self.assertEqual(len(lines), 2)                       # appended, not overwritten
        self.assertEqual(json.loads(lines[0])["question"], "q1")
        # newlines/quotes survive a round-trip → valid JSON escaping
        self.assertEqual(json.loads(lines[1])["question"], "q2\nwith newline and \"quotes\"")

    def test_write_failure_is_non_fatal(self):
        # Point at a path that can't be created (a file where a dir must be).
        blocker = Path(self.tmp) / "blocker"
        blocker.write_text("x")
        # wiki dir would be blocker/s360-docs — parent is a file → mkdir fails.
        # append_log must swallow the error (return None, no raise).
        try:
            log_query.append_log(str(blocker), "s360-docs", {"question": "q"})
        except Exception as e:  # noqa: BLE001
            self.fail(f"append_log raised instead of warning: {e}")


if __name__ == "__main__":
    unittest.main()
