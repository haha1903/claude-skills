---
name: wiki-query
description: Use when a task needs background knowledge from a mounted LLM wiki (its prompt names WIKI_ROOT and in-scope wikis). Retrieve via three-layer index navigation and log the query. Do NOT grep the wiki blindly — go through this skill so the wiki knows what was asked.
summary: Look something up in a mounted wiki, navigating the index
handles: [Ask.HowItWorks]
---

# Wiki Query

## When to use

Your task prompt names a `WIKI_ROOT` and one or more in-scope wikis (a playbook
declared `wikis:`). When you need background knowledge those wikis would hold —
how a system works, what an entity is, a concept's definition — use this skill
instead of grepping the markdown blindly. Going through it lets the wiki record
what was asked (fuel for future insight pages).

## Where the wiki is

`WIKI_ROOT/<wiki-name>/`. Resolve `WIKI_ROOT` in this order: the path named in
your task prompt, else the `WIKI_ROOT` environment variable, else the default
`~/Projects/wiki`. (The `log-query.py` helper applies the same default, so a
plain local run without `WIKI_ROOT` set just works.)
Each wiki has `index.md` (navigation), `summaries/`, `concepts/`, `entities/`,
and `raw/`. For most wikis `raw/` holds immutable *sources* (ingest input, not
directly consumed). But a wiki can declare its `raw/` to be **directly-queryable
real-time knowledge** — see "Searching raw/" below.

## Three-layer navigation

1. **Read `<wiki>/index.md` first.** It is thematically grouped with navigation
   prose. Use it to decide which pages are relevant — do not scan every page.
2. **Read the matched pages** under `summaries/` / `concepts/` / `entities/`.
3. **Follow in-page links** (e.g. `[Foo](../entities/foo.md)`) into adjacent
   pages when the answer spans several.
4. **Organize the answer from page content, citing the page paths** you used, so
   the answer is traceable back to the wiki.

If `<wiki>/index.md` does not exist, the wiki hasn't been ingested yet: fall back
to reading `<wiki>/raw/`, or tell the user the wiki isn't ready. Do not fail hard.

## Searching raw/

Whether you search `<wiki>/raw/` as part of a query is decided in two layers —
a per-call override wins over the wiki's own default:

1. **Per-call override (highest priority).** If your task prompt / playbook
   instruction explicitly says to include raw (e.g. "search the raw/ root-cause
   pages", "include_raw") — search `raw/`. If it says to skip raw — don't. This
   override wins over the wiki default below.
2. **Wiki default.** If there's no per-call instruction, read `<wiki>/.wikimeta`
   (a small key:value file at the wiki root). If it contains `searchRaw: true`,
   the wiki's `raw/` is real-time queryable knowledge (e.g. an on-call
   root-cause wiki): search `raw/` **alongside** the three-layer index
   navigation — always, even when `index.md` exists. Otherwise (`.wikimeta`
   absent or `searchRaw: false`) `raw/` holds immutable sources: only read it as
   the fallback when `index.md` doesn't exist (as above).

When you do search `raw/`, grep its `.md` files for the query keywords and read
the matching pages just like any other layer, and cite `raw/<page>.md` in your
answer + the log.

## Log the query (always do this last)

After answering, record the query so the wiki knows what was asked. Run:

```bash
python3 <path-to-this-skill>/scripts/log-query.py \
  --wiki <wiki-name> \
  --question "<the question you were answering, verbatim>" \
  --pages "<comma-separated page paths you used, e.g. summaries/x.md,concepts/y.md>" \
  --answered <true|false>
```

- `--answered false` when the wiki did NOT have the answer — that gap is valuable
  (it signals missing content), so log it too.
- The helper derives timestamp, task name, wiki commit, host, and page count for
  you — you only pass what you already know.
- If logging fails it just warns; it never blocks your answer.
