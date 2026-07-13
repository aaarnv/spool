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

## Blob layout (per published spool `{id}`)

PR sources land under `src/pr/` alongside the edit sources (see EDIT-CONTRACT.md):

```
spools/{id}/src/pr/pr.json      # written server-side from publish meta (below)
spools/{id}/src/pr/tour.json    # written server-side from publish meta (below)
spools/{id}/src/pr/diff.patch   # client-upload grant (text/plain), like the edit binaries
```

`pr.json`/`tour.json` ride inline in the publish request; `diff.patch` comes back as a scoped
client-upload grant in the existing `uploads` array. The watch page lazily fetches the diff
from its public blob URL client-side.

## Publish meta `pr` field (CLI → web)

`spool publish` adds a `pr` object to the request body, a sibling of `sources`. It does NOT
depend on the spool being editable:

```jsonc
pr: {
  info: { …pr.json… },   // written to spools/{id}/src/pr/pr.json
  tour: { …tour.json… }, // written to spools/{id}/src/pr/tour.json
  hasDiff: true          // → client-upload grant for spools/{id}/src/pr/diff.patch
}
```

Web rejects with 413 if `JSON.stringify(info).length + JSON.stringify(tour).length` exceeds
~300KB.

## spool.json `pr` summary (web → watch page)

`shareSpool()` attaches a resolved summary to the published `spool.json` so the watch page
never needs `tour.json`. `step` is the index into `spool.steps` (null when unmapped):

```jsonc
pr: {
  number, url, title, additions, deletions, changedFiles,
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
