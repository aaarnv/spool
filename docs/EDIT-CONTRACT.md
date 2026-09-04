# Spool edit pipeline — cross-component contract (v1)

Three parties: **CLI** (`spool publish` uploads sources), **web** (edit agent UI + jobs
API on spool-web), **worker** (Fly render worker re-renders). This file is the single
source of truth for the shapes between them. Change it only by changing all three.

## Blob layout (per published spool `{id}`)

Existing final video stays wherever publish puts it today. Sources land under:

```
spools/{id}/src/video.mp4          # normalized CFR recording (render input)
spools/{id}/src/timeline.json      # recording-clock timeline (record contract)
spools/{id}/src/render.json        # rate + bg as used for the published render
spools/{id}/src/bg.jpg             # resolved canvas image (optional; see Backgrounds)
spools/{id}/src/vo/manifest.json
spools/{id}/src/vo/seg_NN.wav
spools/{id}/src/vo/seg_NN.words.json
```

A Plan Spool adds three more, written server-side because they are small and
authoritative. Both of the first two are load-bearing and neither fails loudly on its
own: without `plan.json` the bundle publishes as an ordinary spool with nothing to
decide, and without `plan.script.json` the render silently drops the chapter cards.

```
spools/{id}/src/plan.json          # the PUBLISHED packet (buildSharePlan output)
spools/{id}/src/plan.script.json   # `spool plan generate` output; turns the cards on
spools/{id}/src/evidence.json      # resolved evidence descriptors (optional)
```

A packet render (below) writes what it authored back into the same prefix, so the
video can be reproduced: `beats.json`, `diagrams.json`, `timeline.json`, `render.json`.

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
  hasVideo: true,      // → grant for spools/{id}/src/video.mp4
  hasBg: true          // → grant for spools/{id}/src/bg.jpg (the resolved canvas)
}
```

The publish body also carries `hasFgLayer: true` when the workdir has `layers/fg.webm`,
which grants `l/{id}/layers/fg.webm` beside `final.mp4` (see Background swap).

Spools published before this feature have `has_sources = false` and are not editable
(UI says re-publish to enable editing).

PR guides add `spools/{id}/src/pr/{pr.json,tour.json,diff.patch}` under the same prefix, but
independently of editability — see PR-GUIDE-CONTRACT.md.

## DB (Drizzle, Neon)

```
spools: + has_sources boolean default false
edit_jobs:
  id            uuid pk default random
  spool_id      text fk -> spools.id
  status        text: queued | running | done | error
  instruction   text        # the user's natural-language ask (audit)
  ops           jsonb       # validated ops array (schema below)
  error         text null
  attempts      int default 0        # claims so far; 3 → retired to error
  lease_token   uuid null            # current claim's token (NULL = pre-lease legacy job)
  lease_expires_at timestamptz null  # a running job past this is reclaimable
  started_at / finished_at timestamptz null
  created_at / updated_at timestamptz
-- partial unique index edit_jobs_one_active_per_spool ON (spool_id)
--   WHERE status IN ('queued','running')  -- ≤1 live job per spool (confirm race → 23505 → 409)
```

## Ops JSON (v1) — the entire edit vocabulary

```json
{ "ops": [
  {"op":"remove_step",  "i": 2},
  {"op":"reorder",      "order": [0,2,1]},
  {"op":"set_narration","i": 0, "text": "…"},
  {"op":"set_title",    "title": "…"},
  {"op":"set_zoom",     "i": 1, "zoom": "none" | "auto" | {"x":0,"y":0}},
  {"op":"set_rate",     "rate": 1.25},
  {"op":"set_bg",       "bg": "graphite" | "paper" | "indigo" | "sky"},
  {"op":"set_bounds",   "i": 1, "start": 12.5, "end": 20},
  {"op":"split",        "i": 1, "at": 8.5},
  {"op":"merge",        "i": 2}
]}
```

Indices refer to CURRENT step order at job creation; ops apply sequentially
(remove/reorder/split/merge shift later indices — the applier processes in array order).
Validation (web, before job creation): indices in range, order is a permutation,
rate in [0.75, 2], narration ≤ 600 chars, `bg` one of the three repo presets, at least one op.

**Re-cut ops** (SPL-DECISIONS #59). The take is one continuous video and a step boundary is
a number over it, so these three change in/out points without touching a pixel — the
platform-side half of `spool recut`, and the same one-pass, no-re-encode trade.

- `set_bounds` moves a step's `start`, `end`, or both. Either key may be omitted to keep
  that side. Clicks outside the new window are dropped.
- `split` cuts step `i` at `at`, leaving the head in place and inserting a tail named
  `<name>-b` that carries the clicks after the cut. The tail takes a FRESH recording index
  (`max(i) + 1` over steps and VO segments) because `i` is the timeline↔VO pairing key, and
  it starts un-narrated — the recorded VO belongs to the head.
- `merge` folds step `i` into `i - 1` (0 is an error): the survivor takes the later `end`
  and both click lists. If the folded step was narrated, the joined text is re-TTS'd into the
  survivor's segment; if it was silent, the survivor's existing wav is untouched.

**Clocks.** Times in these ops are on the RECORDING clock, like `src/timeline.json` — NOT the
retimed output clock `spool.json` reports. Web validates shape only (index in range, seconds
finite and ≥ 0, `end` after `start`); the worker holds the timeline and is the authority on
whether a time falls inside the step it names, and rejects the job otherwise. The parse route
therefore feeds the model each step's `recordedStart`/`recordedEnd` from `src/timeline.json`.
`set_bg` is repo-preset-only through the editor — those gradients ship in the repo/worker
image (`assets/bg-<preset>.jpg`). The CLI picks the canvas itself; macOS system wallpapers
and custom image paths reach a local render only through `SPOOL_BG=<wallpaper|path>`. Either
way they're resolved on the author's machine and the resolved pixels ride along as
`src/bg.jpg`, so the Linux worker never needs them.

**Background precedence on re-render** (worker): an explicit `set_bg` op (a repo preset)
wins; else the published `src/bg.jpg` is reused as-is (preserves a macOS wallpaper / custom
canvas across the re-render); else the `render.json` `bg` tag (a repo preset resolves from
the image, a macOS-name tag can't and falls back to `DEFAULT_BG` = `sky`; on a Mac with no spec the default is the Sonoma wallpaper). Spools
published before this feature have no `src/bg.jpg`, so a re-render falls back to `DEFAULT_BG`
— but their existing published video already has the original canvas baked in, so only a
re-render is affected.

**Background swap** (worker fast path). A render writes `layers/fg.webm` next to
`final.mp4`: the whole composite except the wallpaper — card chrome, footage, cursor,
ripples, zoom/pan, captions, hook/CTA — as VP9 with alpha at the final fps. It is
published to `l/{id}/layers/fg.webm`, and `render.json` records `fg: "layers/fg.webm"`.

When an edit job's ops are ALL `set_bg`, the worker downloads that layer plus the
published `final.mp4`, bakes the new canvas the same way a render does, and runs one
ffmpeg pass: canvas under layer, audio copied from the old `final.mp4`. It uploads
`l/{id}/final.mp4` and nothing else — keyframes and `preview.gif` come from the
recording, not the deliverable, so a canvas change cannot alter them. The job result
records `{path: "bg-swap"}`; a full re-render records `{path: "rerender"}`.

The layer is absent for Plan Spools (their canvas is the themed card surface, not a
wallpaper), for `--rate` takes (the layer would need the same speed pass), for previews,
and for anything published before this feature. In every one of those cases a `set_bg`
job falls back to the full re-render, which is also what regenerates the layer.

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

- `GET /api/edit-jobs/next` → 200 `{job: {id, spoolId, ops, leaseToken, attempts}}` or 204.
  Atomically claims the oldest **eligible** job — queued OR a running job whose lease
  expired (crashed worker) — bumping `attempts`, stamping a fresh `lease_token` + 20-min
  `lease_expires_at`. Before claiming it retires jobs that expired on their 3rd attempt
  (→ error `render failed after 3 attempts`). Worker polls every 5s.
- `POST /api/edit-jobs/{id}/uploads` body `{paths: ["l/{spoolId}/final.mp4", …], leaseToken}`
  → `{uploads: [{pathname, token, contentType}]}`. Mints short-lived client-upload grants
  **with `allowOverwrite`** (a re-render replaces the published blob in place; the worker PUT
  also sends `x-allow-overwrite: 1`, api-version 10) so the worker writes outputs straight to
  Blob without a standing token. Rejects paths outside `l/{spoolId}/` (403), a non-running
  job, or a lost lease (409). The web holds the read-write token; the worker never does.
- `PATCH /api/edit-jobs/{id}` body `{status, error?, leaseToken}`. `status:running` = heartbeat
  (extends the lease during a long render; the worker beats every 5min). `done|error` =
  finalize (sets `finished_at`; `done` revalidates the watch page cache tag). All require the
  current `leaseToken` — a reclaimed job's old worker gets 409 (NULL lease = legacy job, accepted).

## Worker (closed source, deployed as part of the hosted service)

Node 20 + ffmpeg + Playwright chromium (the render's static layers are browser
screenshots). Imports the repo's own
`src/vo/tts.mjs`, `src/render/*` as libraries — no logic duplication. Flow per job:
download `spools/{id}/src/*` by **public URL** (`SPOOL_BLOB_BASE`, store access is public —
no token: fixed set then each VO seg named by the manifest) → apply ops to timeline/vo
(set_narration ⇒ re-TTS that segment via OPENAI_API_KEY + whisper words, exactly the CLI's
openai engine path) → renderSpool (windows recompute automatically from the edited
timeline+manifest) → regenerate the share bundle → request upload grants for the changed
`l/{id}/*` outputs (final.mp4, frames, spool.json with steps/narration/durations rewritten
to blob URLs, transcript, console) and PUT via the grants → PATCH done.
Env: EDIT_WORKER_SECRET, OPENAI_API_KEY, SPOOL_HOST, SPOOL_BLOB_BASE (no standing Blob
token — outputs use per-job grants).
Failure ⇒ PATCH error with a one-line reason; sources are immutable (re-edit = new job
from the SAME originals + full ops list — jobs are not cumulative in v1; the web UI
always sends the complete op list relative to the original publish).

### Job kinds

`edit_jobs.kind` says what the worker does with the sources. All four end the same
way: regenerate the share bundle, PUT the `l/{id}/*` outputs through per-job grants,
PATCH done.

| kind | sources it needs | what the worker owns |
| --- | --- | --- |
| `edit` | the full published set | apply ops, re-TTS changed segments, re-render |
| `render` | a capture + `timeline.json` | VO **and** render (`spool finish --cloud`) |
| `render_packet` | `plan.json` alone | script, diagrams, VO and render |
| `render_recap` | nothing — a PR number | fetch the diff, script, diagrams, VO and render |

`render` and `render_packet` are the platform-render pair (SPL-DECISIONS #58): the
agent uploads raw pixels, or nothing at all, and the platform finishes. `render_recap`
(roadmap B2) goes one step further and has no agent at all: a merged pull request is its
only input, and it fetches that itself. All three fill in duration/title from the
`result` the worker reports on `done`.

Neither path calls `/api/publish/{id}/complete`, so the plan lifecycle has to move on
that same `done` callback or the video is unwatchable. **Which edge depends on the
lane, and they are not the same call:**

- a spool that already has a `plan_spools` row came off the `/api/plans` draft lane
  and is in `recording` — guaranteed, because `/api/plans/{id}/render` opens the take
  itself when the plan is still in `draft` rather than making the caller remember
  `/record/start` for a take the platform is the one producing. The edge is
  `recording → published` via `publishRecording`, which also refuses if
  `l/{id}/final.mp4` is not really there.
- a spool with a packet in blob and no row at all is the CLI's `--cloud` finish; the
  lifecycle opens at `awaiting_decision`, because publishing a plan from the CLI IS
  the ask.

Both are idempotent — a repeat reports success with `recorded: false` — so anything
that fails is a plan whose video shipped and whose state did not, and it alerts.

`render_packet` has no capture to work from, so the worker authors the video: the
prompts and the two deterministic gates in `src/packet/` (the same ones
`docs/video/tools/make-video.mjs` runs locally), then the skia comp renderer under
`docs/video/comp`, which the image carries and the published CLI does not. Its
narration IS the output clock, so the timeline it writes carries `retimed: true` and
`buildWindows` returns those times unchanged rather than padding them.

Two enqueue doors, one row shape (`web/lib/renderEnqueue.ts`):
`POST /api/render-jobs` reserves a FRESH spool for the CLI's `--cloud` finish and
leaves the job `uploading` until `/start`; `POST /api/plans/{id}/render` renders a
plan whose spool already exists and queues it immediately, picking the kind from what
is actually in blob rather than from a flag. A third door is not an agent at all: the
GitHub webhook queues a `render_recap` when a merge lands on a repo that opted in
(`repo_feeds.recap_enabled`), and `POST /api/actions/v1/dispatch` queues the same job
from a workflow that would rather trigger it itself. Both run one enqueue under one set
of gates — see CONTRACTS.md "Merged-PR recaps".

`render_recap` uploads nothing and downloads nothing from blob. It asks
`POST /api/edit-jobs/{id}/github-token` for an installation token scoped to the
repository its own payload names, reads the pull request from GitHub, bounds the diff
(`src/recap/pr.mjs`), and authors through the same gates `render_packet` uses with a
different script prompt (`src/packet/RECAPPER.md`). It is the one kind that does NOT
move a plan lifecycle: a recap reports work that already merged, so it opens no
decision, and the `done` callback skips `openPlanLifecycle` outright rather than
relying on there being no packet to find.

**Scale-to-zero.** The single `performance-4x`/8GB machine (restart policy `on-failure`)
exits(0) after ~2min of empty polls, which stops it. The web wakes it on demand: the
confirm route fire-and-forgets a Fly Machines API `start` (env `FLY_WAKE_TOKEN` — an
app-scoped deploy token, `FLY_APP`, `FLY_MACHINE_ID`), and a 10-min vercel.json cron hits
`GET /api/edit-jobs/wake` (authed by `CRON_SECRET`) to start it if any job has sat queued
> 60s. Scale-to-zero therefore REQUIRES those web env vars + the deployed wake route.

## Watch page UI (owner-only panel)

Chat input → POST edit → render the returned summary as a confirm card (ops listed
plainly) → confirm → poll status → on done, cache-busted video reload + toast. On
error, show worker's reason. Non-owners never see the panel.
