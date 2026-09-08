---
name: lionrock-fix-pr
description: Use when a Lionrock defect has been diagnosed down to a specific code location and the user has explicitly asked for it to be fixed and submitted - e.g. "fix it and open a PR", "去修", "提 PR". Covers the verification gate a change must clear before a PR is opened, and the PR mechanics. NOT for deciding whether something is worth fixing, and never entered on the strength of a diagnosis alone.
summary: Take a diagnosed Lionrock defect to a verified, submittable PR
handles: [Internal.OurBug]
---

# Lionrock fix to PR

Opening a PR is a claim: *this change is correct, and I have evidence.* The whole
point of this skill is the gate before that claim, not the `az repos pr create`
call at the end.

## Two things that must both be true before you start

**1. The user asked for THIS fix.** Not "the report mentioned this incident", not
"the diagnosis looks solid". An explicit instruction about a specific defect:
"fix it", "去修", "fix it and open a PR". A diagnosis is never authorisation. When
in doubt you do NOT have it -- say what you would change and ask.

**2. The diagnosis rests on the real error, not on a title.** You must be able to
point at the actual exception or failing assertion, from `OperationLog.Content`,
the Kusto `Log` table, or a test run. If the causal chain has a "probably" in it,
this skill is premature: go back to `oncall-reply` or `icm-investigate`.

## Where this can run

**Both here and on a host.** The container carries the .NET SDK (8.0 and 10.0) and
can restore from the private feed, so checks 1-4 run in the pod. Verified end to
end there: restore, build, and a real test project executing.

Two steps in the container come first, and neither is optional.

**Work in a worktree, never the shared `/data/Projects/Lionrock`.** It is a SHARED
checkout -- other flows edit it at the same time, and branching or building in it
directly races them (two writers overwrite each other with no error). Add a worktree
off an up-to-date `origin/master` and stay in it for everything below:

```bash
R=$HOME/Projects/Lionrock                       # repo is AzureGlobal-DCValidation
WT=$HOME/Worktrees/<task>/Lionrock
git -C "$R" fetch origin
git -C "$R" worktree add "$WT" -b <alias>/<short-description> origin/master
cd "$WT"
```

Use the durable check runner in the container. It runs restore, build and unit tests
in order, with a lock covering the entire worktree. A second start reports the running
job instead of launching another build. It refreshes private-feed authentication in
the same shell as restore, disables compiler-server reuse and limits build parallelism.
When the WebApp frontend exists, it first runs authenticated `npm ci --include=dev` through iris's
ADO workload identity, preserving the repository's script and dependency policies.
This installs real dependencies before MSBuild reaches its local credential-helper
target. An npm failure stops the run before the expensive .NET compilation.

```bash
CHECK="$HOME/.claude/skills/lionrock-fix-pr/bin/check"
"$CHECK" start "$WT" src/Lionrock/test/Lionrock.WebApp.UnitTests/Lionrock.WebApp.UnitTests.csproj
"$CHECK" status "$WT"
```

Choose the test project that covers the change, or the solution for the full unit gate.
`start` returns immediately. Use `status` every 15-30 seconds, then read the reported
stage log; keep individual waits below one minute. Never launch a second raw `dotnet`
command just to collect errors. Never pipe `source nuget-login`: its exports would be
lost in the subshell. Never hide the actual exit code behind `tail` or `grep`.

Only `status: succeeded` means all stages passed. `results` records each exit
code and full log. Confirm `target` covers the requested checks; a running job may be
for another project in the same worktree. Logs, results and NuGet packages live on the
persistent volume. A cl timeout leaves this managed job running; a container restart
marks an unfinished job `interrupted`. On resuming a task, read `status` first, then
start again if interrupted/failed. A new run restores packages before using `--no-restore`,
so stale obj files after a restart cannot masquerade as a complete restore.

On a host the same runner is available at `~/.claude/skills/lionrock-fix-pr/bin/check`.
Authenticate once with `dotnet restore --interactive` if the local credential cache
needs refreshing. Unattended pods use workload-identity auth and never need a browser.

**What still needs a host: check 5, integration tests**, whenever they touch
something the pod cannot reach. Judge that per test rather than assuming: read-only
calls to Kusto, ARM and Geneva work from the pod under the workload identity, so
some integration tests genuinely run here. Anything needing a user credential, a
SAW, or a write does not.

## The gate

Every item is a command with an outcome, so "verified" is not a judgement call.
Run them in this order; the cheap ones fail fastest.

```bash
cd "$WT"                                # the worktree from the top, NOT /data/Projects/Lionrock
```

On a host, use `dotnet restore --interactive` if the feed token is missing or expired.
In the pod, use the runner above. A 401 is an authentication failure: confirm the feed
token is exported to the restore process and refresh it. Repeating `--interactive`
without a token in an unattended container cannot fix that failure.

| # | Check | Command | Must show |
|---|---|---|---|
| 1 | Reproduce | a failing test, or the logged error traced to the line | the defect, before the fix |
| 2 | Build | `dotnet build /v:m` | clean, and see the StyleCop note below |
| 3 | Unit tests | `dotnet test --solution Lionrock.sln /p:RunOnlyUnitTests=true /v:m` | all pass |
| 4 | New-line coverage | the new/changed executable lines are exercised | >= 80%, see below |
| 5 | Integration tests | `dotnet test <path>/<X>.IntegrationTests/*.csproj --filter "TestCategory=Integration"` | pass, when the change touches an external dependency |
| 6 | Frontend, if touched | `npm run build` then `npm test` in the frontend root | both pass |

**Use `RunOnlyUnitTests=true`, not a `--filter`.** It is what CI uses, so a local
pass means the same thing as a green PR build, and it selects by project rather
than by attribute.

The attribute route is easy to get wrong, and the repo's own CLAUDE.md gets it
wrong: it suggests `--filter "Category!=Integration&Category!=Performance"`, but
MSTest's property is **`TestCategory`**, not `Category`. Measured on a project of 9
integration tests: `Category!=Integration` discovers all 9 (the filter matches
nothing, so it excludes nothing), while `TestCategory!=Integration` correctly
discovers 0. A filter that silently excludes nothing is worse than no filter --
it looks like the unit tests passed when integration tests ran too, or the reverse.

**Never pass `-p:StyleCop=Disabled`.** `Directory.Build.props` sets
`TreatWarningsAsErrors` and enables StyleCop, so a local build that skips
analysers hides SA1xxx violations until CI, wasting a whole build cycle. If a rule
genuinely has to be suppressed, do it in `.editorconfig` or
`Directory.Build.props`, not on the command line.

### Coverage: 80% on the diff, and it is enforced

`azurepipelines-coverage.yml` sets `diff: target: 80%` -- coverage of the lines
*changed in the PR*, not of the repo. Repo-wide coverage being high does not help
a PR whose own new lines are untested.

### Integration tests: CI will NOT run them for you

This is the part that has to happen locally, and the pipeline is explicit about
it. The PR gate runs:

```
dotnet test --solution Lionrock.sln --no-restore --no-build /p:RunOnlyUnitTests=true ...
```

`RunOnlyUnitTests=true` makes `Directory.Build.props` exclude every project that
is not a unit-test project, so `.IntegrationTests` / `.AutomationTests` /
`.ScenarioTests` never execute in the PR build. A green PR therefore says nothing
about them.

So when the change touches something that talks to the outside -- Kusto, Geneva
Actions, ARM, storage, the database -- **run the integration tests on your machine
and put the result in the PR description.** Category is by project name
(`.UnitTests`/`.Tests` = unit, `.IntegrationTests`/`.AutomationTests`/`.ScenarioTests`
= integration), and integration tests also carry `[TestCategory("Integration")]`.

If they cannot be run (no VPN, no credential, needs a SAW), **say so in the PR
description and do not imply otherwise**. An unrunnable check is a known gap; a
silently skipped one is a false claim.

## Opening the PR

One logical change per PR. The worktree from the top is already on your branch off
an up-to-date `origin/main`, so just commit and push from it -- never from
`/data/Projects/Lionrock`.

```bash
git -C "$WT" add <paths> && git -C "$WT" commit
git -C "$WT" push -u origin HEAD
```

Then, from inside the worktree:

```bash
az repos pr create --title "..." --description "..." --draft --squash \
  --work-items <id>                          \
  --org https://dev.azure.com/msazure --project One \
  --repository AzureGlobal-DCValidation --target-branch main
```

**Draft, always.** A non-draft PR asks reviewers for their time, and that is the
user's call to make, not yours. They promote it.

**`--work-items` matters.** Repos in this org enforce a work-item linking policy,
and without a linked item the PR sits with that policy rejected -- which looks like
a broken PR rather than a missing field. Link the incident's work item; if there
genuinely is none, say so in the description so a reviewer knows it was considered.

### The description IS the evidence

A reviewer has to be able to check your work without redoing it. Include, in this
order:

1. **The real error, verbatim** -- the exception text, its stack, where it came
   from (`OperationLog`, the `Log` table, a test run). Not a paraphrase.
2. **Why this line** -- how the error text leads to the code you changed.
3. **What the gate showed** -- which commands were run and their results,
   including integration tests by name, and anything that could not be run and why.
4. **The IcM / incident** it came from.

## After the PR merges

Remove the worktree so `/data` does not grow a full checkout per fix, and delete the
branch (only once merged):

```bash
git -C /data/Projects/Lionrock worktree remove "$WT"
git -C /data/Projects/Lionrock branch -D <alias>/<short-description>
git -C /data/Projects/Lionrock push origin --delete <alias>/<short-description>
```

## Never

- branch, build or commit in `/data/Projects/Lionrock` directly -- it is a shared
  checkout; work in a worktree (top of this skill) and remove it after the merge
- open a PR because a diagnosis looked convincing -- the user has to ask
- open a PR that is not a draft
- claim a check passed without having run it, or leave an unrunnable check unsaid
- pass `-p:StyleCop=Disabled` to get a clean build
- rely on the PR build for integration tests -- `RunOnlyUnitTests=true` skips them
- fix more than the defect in the same PR ("while I was in there" is a separate PR)
- guess at a fix for an error you could not reproduce

## About ADO 429

A 429 `exceeding usage of resource 'DBCPU'` from ADO is **the wrong tenant, not
throttling.** Measured from the pod against the same repo URL with the same
identity, varying only which tenant issued the token:

| token | result |
|---|---|
| `ado.adoToken()` | `http=200`, no rate-limit headers at all |
| `wicToken` with the AME tenant (`33e01921`) | `http=429`, `x-ratelimit-remaining=0`, `x-ratelimit-limit=4000`, `retry-after=619` |

An ADO token has to come from the tenant that OWNS the organisation (corp, for
`msazure`). Use the identity's home tenant and you get `remaining=0` on the first
call -- never a 401 -- which reads exactly like a throttled identity and sends you
chasing quota that was never consumed.

So **do not build a retry protocol around it.** Waiting out `Retry-After` and
retrying treats the symptom; the next call from the same wrong tenant returns the
same thing. Fix the token source.

`scripts/git-credential-ado.mjs` already does this correctly per call via
`ado.adoToken()`, which discovers the owning tenant from ADO's own
`x-vss-resourcetenant` header. Anything hand-rolled must too.

## Related

`icm-investigate` (find the code location), `oncall-reply` (answer a question
rather than fix), `oncall-primary` (which surfaces the defects in the first place),
`lionrock-request-retry` (production writes, a different kind of authorisation).
