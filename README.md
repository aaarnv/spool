# agent-loom

**Agents record their own Looms.** After an agent builds a feature, it drives the app in a
real browser, records a real continuous video (not screenshot stitching), narrates it with
AI voice, and renders a designed, captioned MP4 — no human ever hits record.

Inspired by [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native)'s Clips,
inverted: there a human records and the agent watches; here the agent is the producer.

## How it works

```
steps.mjs (agent-authored demo script)
   │
loom vo      →  vo/seg_NN.wav + word timestamps     OpenAI gpt-4o-mini-tts + whisper-1
loom record  →  video.webm + timeline.json           Playwright recordVideo, fake cursor,
   │                                                 human-speed motion, per-step timing
loom render  →  final.mp4                            Remotion: padded card canvas, click
                                                     zooms, word-synced captions, VO at
                                                     exact offsets
```

Sync is **VO-first**: narration is generated before recording, and the recorder pads each
step so the screen never outruns the voice; exact step timestamps are logged and the
renderer places each audio segment at its logged offset.

## Usage (any agent, any project)

```bash
cd <your-project>
loom init my-feature          # scaffolds loom/my-feature/steps.mjs
# author the steps: N steps × { name, narration, zoom, run(page, h) }
loom dry loom/my-feature --headed   # debug the driver cheaply, no VO/video
loom build loom/my-feature          # vo → record → render → share → final.mp4 + share/
loom publish loom/my-feature        # → https://<host>/l/<id> — one link, click to watch
```

`loom publish` uploads the video + share bundle to the hosted watch app (web/ in this
repo, deployable to Vercel + Blob) and returns a single unlisted, unguessable link —
video player, chapters, transcript for humans; raw loom.json on the same page for agents.

## Agent-to-agent sharing (Clips, inverted then completed)

Every build also emits `share/` — a machine-readable bundle so *another agent* can
consume the loom without watching video: `loom.json` (steps, narration, timings, click
coords, keyframe paths), `transcript.txt`, one keyframe PNG per step, and
`console.jsonl` (browser console/pageerror/requestfailed telemetry captured during
recording). A receiving agent runs `loom read <dir>` for an instant digest, then Reads
only the frames it cares about — e.g. to review a demoed feature, file bugs from
console errors, or verify a claimed fix actually renders.

Requirements: node ≥ 20, ffmpeg on PATH, `OPENAI_API_KEY` (or `--engine local` with
[video-studio](~/Projects/video-studio) installed for free local TTS/whisper).

Setup: `npm install && npm link` in this repo (chromium comes from Playwright's cache,
`npx playwright install chromium` if missing).

## The steps contract

See [CONTRACTS.md](./CONTRACTS.md) for the full data contracts (steps.mjs shape,
timeline.json, vo/manifest.json). The only file an agent authors per loom is `steps.mjs`;
everything else is generated.

## Design notes

- **Capture is an adapter.** v1 = Playwright `recordVideo` (CDP screencast → WebM, ~25fps,
  headless, zero OS permissions). Planned v2 backend: in-page `getDisplayMedia` +
  `MediaRecorder` tab capture for native-framerate quality. Same steps contract.
- **Render is Remotion, not ffmpeg filter graphs.** The recording is composited onto a
  rounded card with gentle zooms toward logged click coordinates (Screen-Studio style) and
  captions are rendered as designed React, not burned SRT. The one hand-written ffmpeg video
  pass (WebM → CFR H264) exists because Remotion seeks VFR VP8 pathologically slowly.
- **Dry-run first.** `loom dry` drives the steps with no VO or video so the agent can fix
  selectors/timing before spending TTS calls and render minutes.
