# Spool PR guides: cross-component contract (v1)

Two parties: **CLI** (`spool pr` scaffolds a guide workdir; `spool publish` uploads it) and
**web** (the watch page renders the tour + diff, and the public ask API answers questions
grounded in the diff). No render worker is involved: a PR guide reuses the ordinary record
and render pipeline. This file is the single source of truth for the shapes between CLI and
web. Change it only by changing both.

A guide is additive: "is a PR guide" derives entirely from `spool.pr` in the published
`spool.json` (the blob is authoritative). There is no `spools` table column for it.

## Workdir layout (a `spool pr` scaffold)

`spool pr <number|url>` fetches the PR via `gh` and writes a flat workdir:

```
spool/pr-<n>/pr.json         # gh pr view --json … (body trimmed to ~10k chars)
spool/pr-<n>/diff.patch      # gh pr diff <n> (the exact bytes both agent and web parse)
spool/pr-<n>/tour.json       # scaffolded placeholder; the agent authors it (schema below)
spool/pr-<n>/context.json    # captured deep context; the agent curates `related` (schema below)
spool/pr-<n>/context.md      # product-brief template; the agent authors it (becomes `brief`)
spool/pr-<n>/explainer.html  # optional: a self-contained page recorded for non-UI PRs
```

The workdir is then recorded and finished like any spool (`spool live` → `spool finish`),
adding the usual `video.*`, `timeline.json`, `vo/*`, `final.mp4`, `share/`.

`pr.json` is `gh pr view --json number,title,body,url,author,baseRefName,headRefName,`
`additions,deletions,changedFiles,files,commits`. A body over ~10k chars is sliced and
marked `bodyTruncated: true`.

## tour.json (v1)

```jsonc
{
  "version": 1,
  "pr": 123,
  "mode": "walkthrough" | "explainer" | null,
  "stops": [
    {
      "id": "why-the-change",      // slug; ALSO the recorded step name that maps to it
      "heading": "Why this exists",
      "prose": "Guiding, why-first comprehension text. NOT a review.",
      "files": [{ "path": "src/foo.ts", "hunks": [0, 2] }]  // hunks optional; omitted = whole file
    }
  ]
}
```

The scaffold seeds one placeholder stop per changed file in diff order plus an
`_instructions` field. The authoring agent reorders stops into narrative reading order (why
→ entrypoint → core change → ripples → tests), writes `prose`, sets `mode`, and deletes
`_instructions`. Target 4–8 stops. No em dashes anywhere in authored content.

**Tour ↔ video mapping (by step name).** Each stop `id` is the name of the live `/step` that
illustrates it. `shareSpool()` resolves `stop.step ?? stop.id` against `timeline.steps[].name`
and records the matched step's index as `stop.step` in the published summary.

**Tour ↔ diff mapping.** `files[].hunks` are positional indices within that file's section of
`diff.patch` (both CLI and web parse the same bytes). Omitting `hunks` means the whole file.

**Degradation rules (never fail).**
- A stop whose id/step matches no recorded step → `step: null` in the summary → the watch page
  shows its prose + diff only (no seek anchor). `shareSpool()` prints a `console.error` warning
  listing the unmapped stop ids.
- A stop file path absent from `diff.patch` renders quietly (no diff for that file).
- A workdir without `pr.json` + `tour.json` publishes as an ordinary (non-PR) spool, byte for
  byte unchanged.

## context.json (v1)

`spool pr` captures deep context (best-effort, never fails the scaffold) so the watch-page
Q&A can understand the product, not just the diff. Bodies are fetched via `gh api` raw accept
at `headRefOid` (avoids base64 + the 1MB JSON cap). Caps: 100KB per file/doc text, 5KB per
issue body, 6MB per pack. The published shape (after publish merges the authored brief and
resolves `related`):

```jsonc
{
  "version": 1,
  "brief": "<agent-authored context.md text | null>",
  "pr": { "owner", "repo", "headRefOid", "isCrossRepository" },
  "readme": { "path", "text" } | null,
  "docs": [ { "path", "text" } ],               // <=10 .md from docs/, README excluded
  "files": {                                    // post-change contents of changed + related files
    "<path>": { "text" } | { "omitted": "too-large" | "deleted" | "fetch-failed" }
  },
  "related": [ "<path>" ],                      // agent-curated; contents live in files{}
  "commits": [ { "sha", "message" } ],          // message = headline + (body ? "\n\n" + body : "")
  "issues": [ { "number", "title", "body" } ]   // <=5, parsed from PR body + commit messages
}
```

**`related` (agent curation contract).** The scaffold writes `related: []`. Before publishing,
the authoring agent lists the files a reader needs beyond the diff: the modules the changed
code calls into, the callers of changed functions, the config or schema it touches, the types
it implements. 5 to 20 paths is typical. At publish, `buildPrBundle` resolves any `related`
path not already in `files{}`: local checkout read first (resolved against `process.cwd()`;
paths containing `..` or absolute paths are rejected), else `gh api` raw at `headRefOid`;
failures record `{omitted:"fetch-failed"}`. This is what grounds the watch-page Q&A, so the
skill marks curating it mandatory.

**`brief`.** `context.md` is a product-brief template the agent authors (removing every TODO
line). At publish its text becomes `brief`.

**Pack cap.** The merged pack is trimmed to 6MB least-valuable first (docs, then issues, then
readme, then related file texts, then changed-file texts); changed files survive longest.
Trimmed file texts become `{omitted:"too-large"}`.

## Blob layout (per published spool `{id}`)

PR sources land under `src/pr/` alongside the edit sources (see EDIT-CONTRACT.md):

```
spools/{id}/src/pr/pr.json      # written server-side from publish meta (below)
spools/{id}/src/pr/tour.json    # written server-side from publish meta (below)
spools/{id}/src/pr/diff.patch   # client-upload grant (text/plain), like the edit binaries
spools/{id}/src/pr/context.json # client-upload grant (application/json) when pr.hasContext
```

`pr.json`/`tour.json` ride inline in the publish request; `diff.patch` and (when present) the
merged `context.json` come back as scoped client-upload grants in the existing `uploads`
array. The CLI maps the `context.json` grant to the staged `.spool-context.json` (the merged
pack, not the raw workdir file). The watch page lazily fetches diff + context from their
public blob URLs client-side.

## Publish meta `pr` field (CLI → web)

`spool publish` adds a `pr` object to the request body, a sibling of `sources`. It does NOT
depend on the spool being editable:

```jsonc
pr: {
  info: { …pr.json… },   // written to spools/{id}/src/pr/pr.json
  tour: { …tour.json… }, // written to spools/{id}/src/pr/tour.json
  hasDiff: true,         // → client-upload grant for spools/{id}/src/pr/diff.patch
  hasContext: true       // → client-upload grant for spools/{id}/src/pr/context.json (merged pack)
}
```

`hasContext` is present (and true) only when the workdir has a `context.json`. A workdir
without one publishes exactly as before: `pr` is `{info, tour, hasDiff}` with no `hasContext`
key, byte-identical to phase 1.

Web rejects with 413 if `JSON.stringify(info).length + JSON.stringify(tour).length` exceeds
~300KB.

## spool.json `pr` summary (web → watch page)

`shareSpool()` attaches a resolved summary to the published `spool.json` so the watch page
never needs `tour.json`. `step` is the index into `spool.steps` (null when unmapped):

```jsonc
pr: {
  number, url, title, additions, deletions, changedFiles,
  owner, repo,                  // parsed from url; null if unparseable
  headRefOid: "<sha>" | null,   // for future re-fetch / display
  mode: "walkthrough" | "explainer" | null,
  stops: [
    { id, heading, prose, files: [{ path, hunks? }], step: 1 | null }
  ]
}
```

## Ask API (public Q&A, web)

`POST /api/spools/{id}/ask`, no auth (public, anyone with the link).

```jsonc
// request
{ "question": "≤500 chars", "history": [ { "role": "user"|"assistant", "content": "≤2000" } ] }  // history ≤6 turns
// response
{ "answer": "…", "usage": { "remainingToday": 24 } }
```

404 unless the spool has `spool.pr`. Answers are grounded only in the PR context (title/body,
tour stops, step narrations, and the diff budgeted to ~60k chars prioritizing files referenced
by tour stops); the model says plainly when the answer is not in the diff, gives no verdicts,
and uses no em dashes. Very large diffs may drop the file a question targets (acceptable in
v1).

**Grounding tiers.** A guide published with a `context.json` answers in the `bundle` tier: the
model reads the pack (brief, readme, docs, changed + related file contents) through a small
`list_files` / `read_file` tool loop, on top of the diff. A guide without one answers in the
`diff` tier, which is exactly the phase-1 path (diff only, no tools). Every `read_file` that
misses the pack is logged web-side (`[ask] bundle-miss`); frequent misses are the tripwire
that would justify the parked GitHub App (see tasks/todo.md). The web side owns the tiers, the
tool loop, and the miss logging.

**Rate limiting.** `ip_hash = sha256(ASK_IP_SALT + first x-forwarded-for)`. Two caps, each an
atomic per-day counter in `ask_usage`:

```
ask_usage: pk (spool_id, ip_hash, day)
  spool_id text, ip_hash text, day text, count int default 0
  -- ip_hash = "*" is the per-spool global daily counter
```

`ASK_IP_DAILY_CAP` (default 25) limits one IP per spool per day; `ASK_SPOOL_DAILY_CAP`
(default 200, the `ip_hash = "*"` row) limits the whole spool per day. Over either → 429.

## Guide PR comment (CLI, `spool publish --pr`)

When `spool.pr` is present the `--pr` comment uses a guide variant instead of the walkthrough
variant:

```
### 🧭 PR guide: <title>
[![watch the guided tour](<previewUrl>)](<url>)
**Watch the guided tour:** <url> (<duration>s, narrated)

| at | stop |
|---|---|
| m:ss | <stop heading> |   # timestamp = the matched step's start; blank when step is null

<sub>A guided reading of this change, not a review. The watch page has the tour, the full
diff, and Q&A grounded in the diff. Built via spool.</sub>
```

No em dashes in the generated body.

## Project knowledge (v1)

Every PR guide is an island; the project knowledge store lets guides for the same repo share
one accumulating world so the ask gets smarter over time. It is a keyed, provenance-stamped
store patched by validated ops at publish (the same pattern as the edit ops), not a living
markdown brief. A project is formed automatically, with no create step.

**Seeding a project up front (`spool init`).** A project can be warmed before any guide exists.
Bare `spool init` (no slug — the slugged form scaffolds a scripted recording instead) detects the
repo owner/name via `gh repo view` and scaffolds a `spool/project/` workdir:

```
spool/project/knowledge.json      # current store fetched from the GET API (read-only reference)
spool/project/knowledge-ops.json  # { "_instructions" (seed-oriented), "ops": [] } — the agent authors
```

The agent surveys the repo, authors seed ops (overview, subsystems, vocabulary, and — after
booting the app — `recording` topics), then runs `spool init --apply`. Apply reads
`knowledge-ops.json`, resolves host/token from `resolveConfig`, and POSTs directly to the
knowledge API (the spk-token path, not a publish): `POST /api/projects/knowledge` with
`Authorization: Bearer <spk>` and body `{ owner, repo, ops }` → `200 { knowledge, applied, skipped }`.
It prints `seeded: N op(s) applied, M skipped`, the project page URL
`<host>/dashboard/p/<owner>/<repo>`, refreshes the workdir `knowledge.json` from the response
store, and rewrites `knowledge-ops.json` to `ops: []` so a re-run cannot double-apply. A non-200
prints the status and the server's error body verbatim and exits non-zero. Seed ops are stamped
with provenance `pr: 0` (a manual/seed write, distinct from a real PR number). A project may thus
exist with knowledge but zero guides; the sibling-guide list is simply empty until the first
`spool publish`.

**Project identity.** A project is the triple `(ownerId, owner, repo)`:
- `ownerId` is the Clerk publisher (the spk token owner). Forgery only pollutes the forger's
  own namespace.
- `owner`/`repo` are the GitHub repo owner and name, **lowercased** everywhere (GitHub is
  case-insensitive). The server re-derives them from `meta.pr.info.url` (authoritative); it
  never trusts a client-supplied owner/repo.

**Storage.** Postgres table `project_knowledge` (composite PK ownerId + repoOwner + repoName,
`store` jsonb). The store is mutable read-modify-write state, so it cannot live in Blob: the
CDN serves stale content after an in-place overwrite, and blob URLs reject cache-busting
query params. All reads and writes go through the web app (lib/knowledge.ts).

**Store schema.**

```jsonc
{
  "version": 1,
  "overview": { "text", "pr", "updatedAt" } | null,
  "subsystems": { "<name>": { "text", "pr", "updatedAt" } },
  "vocabulary": { "<term>": { "text", "pr", "updatedAt" } },
  "recording":  { "<topic>": { "text", "pr", "updatedAt" } },
  "decisions":  [ { "what", "why", "pr", "date" } ]
}
```

`recording` is operational memory for the AUTHORING AGENT, not the chat: how to boot this
repo's app (command, port, envs, seed), auth handling (dev-login endpoints, test accounts),
what URL/flows to record against, known flaky elements and pre-warm steps. Conventional
free-form topics: `run`, `auth`, `record-tips`, `gotchas`. The CLI puts it in front of the
agent at `spool pr` scaffold time (the workdir `knowledge.json` reference plus the scaffold
summary's topic list), and the skill has the agent read and write it around recording.

**Caps.** Publish never fails on caps; overruns skip and report (see cap-skip semantics).

| section | count cap | key cap | text cap |
|---|---|---|---|
| overview | 1 | n/a | text ≤500 |
| subsystems | ≤40 | name ≤80 | text ≤1000 |
| vocabulary | ≤60 | term ≤60 | text ≤500 |
| recording | ≤20 | topic ≤80 | text ≤1000 |
| decisions | last 50 (append-only) | n/a | what ≤300, why ≤500 |

Also ≤20 ops per publish. Worst-case store is ~130KB.

**Op vocabulary (9 ops).** Agent-authored in `knowledge-ops.json`. The server stamps `pr` and
`date`; agents never write provenance.

```
set_overview    { text }            set_subsystem  { name, text }   remove_subsystem { name }
set_term        { term, text }      remove_term    { term }
set_recording   { topic, text }     remove_recording { topic }
add_decision    { what, why }       remove_decision  { index }
```

`remove_decision` deletes the decision at `index` (out of range → skipped `missing`); it exists
for manual management from the dashboard, not for the CLI (decisions stay append-only there).

Per-field caps match the store caps above (overview/subsystem/term/recording text and
name/term/topic key lengths; decision what ≤300, why ≤500).

**Workdir files** (both written by `spool pr` after context capture):
- `knowledge.json` is the current store fetched from the GET API, a **read-only reference** for
  the authoring agent. When the fetch degrades it is the empty store.
- `knowledge-ops.json` (`{ "_instructions", "ops": [] }`) is the file the agent **authors**.
  `_instructions` is ignored at publish. The agent reads `knowledge.json` first and UPDATES
  existing entries rather than duplicating; it leaves `ops: []` when nothing durable changed.

**Publish meta.** When `knowledge-ops.json` has a non-empty `ops` array, `buildPrBundle`
attaches it as `pr.knowledgeOps` (a sibling of `info`/`tour`, independent of the context pack):

```jsonc
pr: { info, tour, hasDiff, hasContext?, knowledgeOps?: [ { op, … } ] }
```

**Fail-fast.** If `pr.knowledgeOps` is present the web validates it BEFORE any blob writes:
`parseProjectRef(info)` must resolve (a PR url) and `validateKnowledgeOps` must pass, else the
publish is rejected **400** with the exact validation reason and nothing is written. This is
intentional: a malformed ops batch never half-applies.

**Apply + response.** After the blob writes and db insert, the web fetches the store, applies
the ops (provenance `{pr, date: today}`), and puts it back, then returns
`knowledge: { applied, skipped }` in the publish response (the CLI prints
`[publish] knowledge: N op(s) applied` plus `, M skipped (caps)` when any skipped). Apply-stage
failures are caught and logged; they never fail the publish.

**GET `/api/projects/knowledge?owner=&repo=`.** Bearer spk token. The server resolves `ownerId`
from the token (the CLI never learns it), validates `owner`/`repo` against
`/^[A-Za-z0-9._-]{1,100}$/` and lowercases them. Returns `200 { knowledge }` (the empty store
when absent), `400` on bad params, `401` without a valid token. The CLI calls this best-effort
with a ~5s timeout; any failure degrades to the empty store.

**Cap-skip semantics.** A `set_*` op that introduces a NEW key past its section's count cap is
skipped with reason `cap`; an update to an EXISTING key always applies (it does not grow the
section). `remove_*` on a missing key is skipped. `decisions` is truncated to the last 50.
Publish never fails on caps; skips are reported in the response and logged.

**Ask grounding.** The chat gets an inline project index appended to its system context: the
overview text, the subsystem NAMES, the vocabulary TERMS, the last 5 decisions with provenance,
and the sibling guide list (`PR #n: title`). Full entries are read on demand via
`read_knowledge { key }` (`overview` | `decisions` | `subsystems/<name>` | `vocabulary/<term>`);
sibling guides are toured via `read_guide { pr }`. `recording` topics are **excluded** from the
inline index (operational, not comprehension) but remain readable via
`read_knowledge { key: "recording/<topic>" }`.

**Degradation.** A workdir WITHOUT `knowledge-ops.json` (or with `ops: []`) produces a publish
request byte-identical to the pre-knowledge shape: no `knowledgeOps` key, no store fetch or
apply. Old spools with NULL project columns behave identically (knowledge works off the parsed
url; siblings need the columns).

**Concurrency.** The blob read-modify-write has no compare-and-set, so concurrent publishes to
the same project are **last-writer-wins**: the later put can drop the earlier publish's ops. The
keyed store bounds the blast radius to one publish's ops, and single-owner workflows make this
rare. Revisit with a revision column if multi-agent publishing to one project becomes real.

**No secrets.** Knowledge (including `recording` topics: dev-login tricks, test accounts, boot
commands) must not contain secrets, tokens, or credentials. Record the shape of the auth flow,
never the values. Entries surface in the public watch-page chat via read_knowledge.
