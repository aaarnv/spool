# Spool edit pipeline — cross-component contract (v1)

Three parties: **CLI** (`spool publish` uploads sources), **web** (edit agent UI + jobs
API on spool-web), **worker** (Fly render worker re-renders). This file is the single
source of truth for the shapes between them. Change it only by changing all three.

## Blob layout (per published spool `{id}`)

Existing final video stays wherever publish puts it today. Sources land under:

```
spools/{id}/src/video.mp4          # normalized CFR recording (render input)
spools/{id}/src/timeline.json      # recording-clock timeline (record contract)
spools/{id}/src/render.json        # rate etc as used for the published render
spools/{id}/src/vo/manifest.json
spools/{id}/src/vo/seg_NN.wav
spools/{id}/src/vo/seg_NN.words.json
```

Upload happens inside the existing `spool publish` bearer-token API flow, following
the app's existing split (Vercel functions cap request bodies ~4.5MB, and publish
already mints client-upload grants for big binaries): the CLI sends a `sources`
object with the SMALL JSON artifacts inline; web writes those to `spools/{id}/src/*`,
sets `spools.has_sources = true`, and returns client-upload grants (in the existing
`uploads` array) for the binaries.

```jsonc
sources: {
  timeline: {...}, render: {...},
  vo: { manifest: {...}, words: { "0": {...}, "1": {...} } },
  segments: [0,1,2],   // → grants for spools/{id}/src/vo/seg_NN.wav
  hasVideo: true       // → grant for spools/{id}/src/video.mp4
}
```

Spools published before this feature have `has_sources = false` and are not editable
(UI says re-publish to enable editing).

## DB (Drizzle, Neon)

```
spools: + has_sources boolean default false
edit_jobs:
  id          uuid pk default random
  spool_id    text fk -> spools.id
  status      text: queued | running | done | error
  instruction text        # the user's natural-language ask (audit)
  ops         jsonb       # validated ops array (schema below)
  error       text null
  created_at / updated_at timestamptz
```

## Ops JSON (v1) — the entire edit vocabulary

```json
{ "ops": [
  {"op":"remove_step",  "i": 2},
  {"op":"reorder",      "order": [0,2,1]},
  {"op":"set_narration","i": 0, "text": "…"},
  {"op":"set_title",    "title": "…"},
  {"op":"set_zoom",     "i": 1, "zoom": "none" | "auto" | {"x":0,"y":0}},
  {"op":"set_rate",     "rate": 1.25}
]}
```

Indices refer to CURRENT step order at job creation; ops apply sequentially
(remove/reorder shift later indices — the applier processes in array order).
Validation (web, before job creation): indices in range, order is a permutation,
rate in [0.75, 2], narration ≤ 600 chars, at least one op.

## Web API (spool-web)

- `POST /api/spools/{id}/edit` — owner-only (Clerk session; the spool's owner).
  Body `{instruction}`. Calls Claude (`claude-haiku-4-5`, ANTHROPIC_API_KEY env,
  tool-forced structured output against the ops schema, spool.json steps in context)
  → returns `{ops, summary}` (human-readable per-op summary). NO side effects.
- `POST /api/spools/{id}/edit/confirm` — owner-only. Body `{ops}`. Re-validates,
  inserts edit_jobs row (queued). One active (queued|running) job per spool — 409 else.
- `GET /api/spools/{id}/edit/status` — owner-only. Latest job {id, status, error}.

## Worker API (web side, consumed by Fly worker)

Auth: `Authorization: Bearer ${EDIT_WORKER_SECRET}` (env on both sides).

- `GET /api/edit-jobs/next` → 200 `{job: {id, spoolId, ops}}` (atomically flips
  queued→running) or 204. Worker polls every 5s.
- `POST /api/edit-jobs/{id}/uploads` body `{paths: ["l/{spoolId}/final.mp4", …]}` →
  `{uploads: [{pathname, token, contentType}]}`. Mints short-lived client-upload grants
  (the publish route's `mintToken` helper) so the worker PUTs outputs straight to Blob
  without a standing token. Rejects any path outside the job's published prefix
  `l/{spoolId}/` (403) or a non-running job (409). The web holds the read-write token; the
  worker never does.
- `PATCH /api/edit-jobs/{id}` body `{status: done|error, error?}`. On `done` the worker
  has already overwritten the published final.mp4/spool.json/frames via the grants above,
  so web just revalidates the watch page cache tag.

## Worker (worker/ dir in this repo, deployed as Fly app `spool-render`, region syd)

Node 20 + ffmpeg + Remotion-capable chromium deps. Imports the repo's own
`src/vo/tts.mjs`, `src/render/*` as libraries — no logic duplication. Flow per job:
download `spools/{id}/src/*` by **public URL** (`SPOOL_BLOB_BASE`, store access is public —
no token: fixed set then each VO seg named by the manifest) → apply ops to timeline/vo
(set_narration ⇒ re-TTS that segment via OPENAI_API_KEY + whisper words, exactly the CLI's
openai engine path) → renderSpool (windows recompute automatically from the edited
timeline+manifest) → regenerate the share bundle → request upload grants for the changed
`l/{id}/*` outputs (final.mp4, frames, spool.json with steps/narration/durations rewritten
to blob URLs, transcript, console) and PUT via the grants → PATCH done.
Env: EDIT_WORKER_SECRET, OPENAI_API_KEY, SPOOL_HOST, SPOOL_BLOB_BASE (no standing Blob
token — outputs use per-job grants). `SPOOL_RENDER_CONCURRENCY` caps render concurrency
(os.cpus() reports host cores in a container, so the default over-subscribes RAM).
Failure ⇒ PATCH error with a one-line reason; sources are immutable (re-edit = new job
from the SAME originals + full ops list — jobs are not cumulative in v1; the web UI
always sends the complete op list relative to the original publish).

## Watch page UI (owner-only panel)

Chat input → POST edit → render the returned summary as a confirm card (ops listed
plainly) → confirm → poll status → on done, cache-busted video reload + toast. On
error, show worker's reason. Non-owners never see the panel.
