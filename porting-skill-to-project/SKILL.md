---
name: porting-skill-to-project
description: Use when moving/copying one of your personal skills (from ~/.claude/skills or an agent skills dir) into a project repo that hosts its own skills under .github/skills, or when the user says "put this skill into <project>", "add this skill to the repo the project way", "share this skill via the repo". Covers matching the repo's conventions, adjusting frontmatter/paths, updating every skill index, and the gitignore/PR gotchas.
---

# Porting a Personal Skill into a Project Repo

Move a skill you built for yourself into a project that keeps its own skills under
`.github/skills/` (agentskills.io spec). The mechanical copy is trivial; the value
is in matching the project's conventions and not missing the indexes/gotchas.

## Do NOT just copy the folder

A personal skill carries runtime-specific frontmatter and absolute paths that are
wrong inside a repo, and repos track skills in index files a copy won't touch.
Follow the steps.

## Steps

1. **Discover the target repo's skill convention — don't assume.**
   - Confirm the skills dir: `ls <repo>/.github/skills/` (this is the common one;
     some repos differ).
   - Read the repo's `.github/skills/README.md` (or equivalent) for the
     "how a skill is structured" + "adding a new skill" rules. Follow THAT, not
     your personal layout.
   - Open one existing skill's `SKILL.md` to copy its exact frontmatter shape.

2. **Copy the skill files** into `<repo>/.github/skills/<skill-name>/`
   (`SKILL.md` + any `bin/` / `config/` / `references/` / `assets/`).

3. **Rewrite `SKILL.md` to the repo's conventions:**
   - Frontmatter: keep only fields the repo's skills use (usually just `name` +
     `description`). **Drop personal-runtime fields** like `allowed-tools`.
   - Paths: change every absolute/`~`/`../../_shared` path to a repo-relative one
     (e.g. `node .github/skills/<name>/bin/x.mjs`). Grep the file for the old
     skill name and old paths after editing — leftovers hide in the run command.

4. **Update EVERY skill index (there is usually more than one):**
   - `.github/skills/README.md` index table.
   - The repo-root `AGENTS.md` (or `CLAUDE.md`) "Agent Skills" section.
   - The README's "adding a new skill" list tells you which indexes exist — do all
     of them. Missing one is the most common defect.

5. **Verify it runs from the new location** before declaring done: execute the
   skill's entry command with the in-repo path and check the output.

6. **Surface repo-hosting gotchas to the user (don't silently work around):**
   - **gitignore:** the repo's `.gitignore` may swallow `bin/`/`config/` (run
     `git check-ignore <file>`). If so, tell the user — offer `git add -f` vs a
     `.gitignore` exception; don't decide for them.
   - **Company repos = PR flow:** if the remote is an ADO/GitHub company repo on a
     protected branch (e.g. `master`), do NOT commit directly. Branch + PR, and
     confirm with the user first.

## Quick reference

| Aspect | Personal skill | In-repo skill |
|---|---|---|
| Location | `~/.claude/skills/<name>/` | `<repo>/.github/skills/<name>/` |
| Frontmatter | may have `allowed-tools`, etc. | usually just `name` + `description` |
| Paths | absolute / `~` / shared-dir imports | repo-relative |
| Indexes | none | README table + AGENTS.md/CLAUDE.md |
| Commit | your call | branch + PR on company repos |

## Common mistakes

- Copying the folder and stopping — indexes not updated, frontmatter still personal.
- Updating only ONE index (README but not AGENTS.md, or vice versa).
- Leaving the old skill name / absolute path in the run command inside `SKILL.md`.
- `git add` silently failing because `.gitignore` excludes `bin/` or `config/`.
- Committing straight to `master` on a company repo instead of opening a PR.
- Keeping a dependency on your private tooling (e.g. a shared SDK bundle) so the
  skill can't run for anyone else — a shared skill must be self-contained.
