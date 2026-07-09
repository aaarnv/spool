# spool

**Agents record their own spools.** After an agent builds a feature, it drives the app in a
real browser, records a real continuous video (not screenshot stitching), narrates it with
AI voice, and renders a designed, captioned MP4 — no human ever hits record. Think of the
narrated walkthroughs you'd make with screen-recording products like Loom, except the agent
is the producer.

Inspired by [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native)'s Clips,
inverted: there a human records and the agent watches; here the agent is the producer.

## How it works

```
steps.mjs (agent-authored demo script)
   │
   ├── spool vo      →  vo/seg_NN.wav + word timestamps   OpenAI gpt-4o-mini-tts + whisper-1
   │   (in parallel)                                      (bounded concurrency pool)
   └── spool record  →  video.webm + timeline.json        Playwright recordVideo, fake cursor,
   │                                                       human-speed motion, natural timing
spool render  →  final.mp4                                Remotion: retime each step to fit its
                                                          narration, play its capture at 1x then
                                                          freeze-hold, click zooms, word-synced
                                                          captions, VO at each step's offset
```

Sync is **record-first, narrate-parallel, retimed-in-render**: the capture runs at natural
interaction speed while narration is generated concurrently, then the renderer sizes each
step to `max(narration+pad, recorded)` — playing the recording at 1x and freeze-holding its
last frame for the remaining dead air under the voice. Nothing is padded during capture, so a
5-step build drops from ~90s to roughly `max(record, vo) + fast render`.

## Usage (any agent, any project)

Two authoring paths land on the same render.

**Live** — you just drove the flow while verifying a feature, so drive it once more and let
spool record as you go. No steps.mjs to author or debug:

```bash
cd <your-project>
# boots a headless recording browser + an HTTP control server on 127.0.0.1:<port>.
# stdout prints one line: {"port":N,"session":"<dir>"}
spool live spool/my-feature --url http://localhost:3000

# then, per step (narration is required — the renderer fits the window to it):
curl -sX POST 127.0.0.1:$PORT/step -d '{"name":"open","narration":"The dashboard now loads the new flow."}'
curl -sX POST 127.0.0.1:$PORT/js   -d '{"code":"await h.click(\"#open\"); await page.waitForSelector(\".result\")"}'
# … more /step + /js … a bad selector returns {ok:false} without killing the session …
curl -sX POST 127.0.0.1:$PORT/end          # finalizes video.webm + timeline.json + a generated steps.mjs

spool finish spool/my-feature              # vo → render → share → final.mp4 + share/
spool publish spool/my-feature             # → https://<host>/l/<id>
```

`spool live` also writes a **generated `steps.mjs`** capturing the config, per-step
names/narration/zoom, and the js snippets that succeeded — so the take is reproducible and
editable as a scripted spool later.

**Scripted** — reproducible; author the driver up front:

```bash
spool init my-feature                  # scaffolds spool/my-feature/steps.mjs
# author the steps: N steps × { name, narration, zoom, run(page, h) }
spool dry spool/my-feature --headed    # debug the driver cheaply, no VO/video
spool build spool/my-feature           # (vo ‖ record) → render → share → final.mp4 + share/
spool publish spool/my-feature         # → https://<host>/l/<id> — one link, click to watch
```

(`spool build` on a live/recorded session skips recording and finishes it, so `build` works
for both paths.)

`spool publish` uploads the video + share bundle to the hosted watch app (web/ in this
repo, deployable to Vercel + Blob) and returns a single unlisted, unguessable link —
video player, chapters, transcript for humans; raw spool.json on the same page for agents.

## Agent-to-agent sharing (Clips, inverted then completed)

Every build also emits `share/` — a machine-readable bundle so *another agent* can
consume the spool without watching video: `spool.json` (steps, narration, timings, click
coords, keyframe paths), `transcript.txt`, one keyframe PNG per step, and
`console.jsonl` (browser console/pageerror/requestfailed telemetry captured during
recording). A receiving agent runs `spool read <dir>` for an instant digest, then Reads
only the frames it cares about — e.g. to review a demoed feature, file bugs from
console errors, or verify a claimed fix actually renders.

Requirements: node ≥ 20, ffmpeg on PATH, and a voiceover engine. The engine auto-resolves:

- **your own key** — `OPENAI_API_KEY` (env, the project's `.env`, or `openaiKey` in `~/.spool.json`); or
- **hosted (zero-key)** — just the `host` + `token` you already put in `~/.spool.json` for `spool publish`.
  Voice runs on the hosted app with no OpenAI key of your own — the same dashboard token covers both
  publishing and voice (subject to a fair-use daily cap); or
- **local (free)** — `--engine local` with a `SPOOL_VO_SH` script for local TTS/whisper.

Force one with `--engine openai|hosted|local`; omit it to auto-detect in that order.

Setup: `npm install && npm link` in this repo (chromium comes from Playwright's cache,
`npx playwright install chromium` if missing).

## The steps contract

See [CONTRACTS.md](./CONTRACTS.md) for the full data contracts (steps.mjs shape,
timeline.json, vo/manifest.json). The only file an agent authors per spool is `steps.mjs`;
everything else is generated.

## Design notes

- **Capture is an adapter.** v1 = Playwright `recordVideo` (CDP screencast → WebM, ~25fps,
  headless, zero OS permissions). Planned v2 backend: in-page `getDisplayMedia` +
  `MediaRecorder` tab capture for native-framerate quality. Same steps contract.
- **Render is Remotion, not ffmpeg filter graphs.** The recording is composited onto a
  rounded card with gentle zooms toward logged click coordinates (Screen-Studio style) and
  captions are rendered as designed React, not burned SRT. The one hand-written ffmpeg video
  pass (WebM → CFR H264) exists because Remotion seeks VFR VP8 pathologically slowly.
- **Dry-run first (scripted path).** `spool dry` drives the steps with no VO or video so the
  agent can fix selectors/timing before spending TTS calls and render minutes. The live path
  skips this — you drive once and fix fumbles inline (a failed `/js` doesn't kill the take).
- **Live is record-derived.** `spool live` inverts authoring: instead of writing a driver and
  debugging it, the agent drives the real app once over an HTTP control port and the steps are
  derived from the session, then emitted as a reproducible `steps.mjs` snapshot.
