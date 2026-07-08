# spool data contracts (v1)

Every layer communicates only through these files inside a per-spool **workdir**
(conventionally `<project>/spool/<slug>/`). If you change a format, bump it here first.

## Workdir layout

```
spool/<slug>/
├── steps.mjs            # agent-authored demo script (the only human/agent-written file)
├── vo/
│   ├── manifest.json    # written by `spool vo`
│   ├── seg_00.wav       # 24kHz mono, loudnormed -16 LUFS
│   └── seg_00.words.json
├── video.webm           # written by `spool record` (raw Playwright capture)
├── timeline.json        # written by `spool record`
├── video.mp4            # written by `spool render` (normalize pass, CFR 30fps H264)
└── final.mp4            # written by `spool render` (the deliverable)
```

## steps.mjs (authored per spool)

```js
export const config = {
  url: "http://localhost:4747",            // required
  viewport: { width: 1600, height: 900 },  // optional, this is the default (16:9 fills the rendered frame best)
  title: "Finishing Lab walkthrough",      // optional, used for title card
  // optional: runs before step 0, recorded but not narrated (login, seeding)
  prep: async (page, h) => {},
};

export const steps = [
  {
    name: "open-board",                    // kebab-case id, unique
    narration: "Here's the finishing lab — every rep gets tracked on this board.",
    zoom: "auto",                          // "auto" (zoom to clicks in this step) | "none" | {x,y,scale}
    run: async (page, h) => {
      await h.click("text=Start");
      await page.waitForSelector(".board");
    },
  },
];
```

Helper API passed as `h` (implemented in src/record/cursor.js):
`h.move(x,y)`, `h.click(selectorOrPoint)`, `h.type(selector, text)`, `h.hover(selector)`,
`h.scroll(dy)`, `h.pause(ms)`. All produce smooth, human-speed motion and are logged.

Pipeline: `spool build` runs **vo and record in parallel** (record no longer waits
on VO), then render, then share. The capture is at natural interaction speed; the
renderer retimes each step to fit its narration (see "Render layer inputs").

## vo/manifest.json (spool vo ‖ spool record, → spool render)

```json
{
  "engine": "openai",
  "voice": "alloy",
  "segments": [
    {
      "i": 0,
      "name": "open-board",
      "narration": "Here's the finishing lab — every rep gets tracked on this board.",
      "wav": "vo/seg_00.wav",
      "words": "vo/seg_00.words.json",
      "duration": 4.32
    }
  ]
}
```

`seg_NN.words.json`: `[{ "word": "Here's", "start": 0.0, "end": 0.31 }, ...]`
(times are local to that segment's wav; seconds, float).

## timeline.json (spool record → spool render)

```json
{
  "version": 1,
  "title": "Finishing Lab walkthrough",
  "url": "http://localhost:4747",
  "viewport": { "width": 1600, "height": 900 },
  "fps": null,
  "video": "video.webm",
  "steps": [
    {
      "i": 0,
      "name": "open-board",
      "start": 1.02,
      "end": 2.31,
      "zoom": "auto",
      "clicks": [ { "x": 512, "y": 340, "t": 1.60 } ]
    }
  ],
  "total": 8.7
}
```

- All times in **seconds relative to video t=0** (context/page creation), at
  **natural interaction speed** — steps are not padded to the narration anymore.
- `steps[i].end` includes a short post-step settle so the step's final UI state is
  painted and captured (the renderer freeze-holds that last frame).
- `clicks[].t` is when the click fired; coords are viewport CSS pixels.
- No `voDuration` field: VO is produced in parallel and the renderer retimes.

## console.jsonl (spool record → spool share)

Browser telemetry captured during recording, one JSON object per line, times in
seconds relative to video t=0 (same clock as timeline.json):

```json
{"t": 3.41, "kind": "console", "level": "error", "text": "Uncaught TypeError: ..."}
{"t": 5.02, "kind": "pageerror", "text": "ReferenceError: foo is not defined"}
{"t": 7.80, "kind": "requestfailed", "text": "GET http://localhost:4747/api/x net::ERR_..."}
```

Levels for kind=console mirror Playwright's msg.type(). Always written (empty file
when nothing fired) so consumers can rely on its presence.

## share/ bundle (spool share → any consuming agent)

The agent-consumable artifact. `spool share <workdir>` (auto-run at the
end of `spool build`) writes:

```
spool/<slug>/share/
├── spool.json         # the single machine-readable index (below)
├── transcript.txt     # "[mm:ss] narration" per step — cheap skim for an agent
├── frames/step_NN.png # one keyframe per step (mid-step, post-click when clicks exist)
└── console.jsonl      # copied from the workdir
```

`spool.json`:

```json
{
  "version": 1,
  "kind": "spool",
  "title": "Finishing Lab walkthrough",
  "url": "http://localhost:4747",
  "video": "../final.mp4",
  "duration": 29.0,
  "voice": { "engine": "openai", "voice": "alloy" },
  "steps": [
    {
      "i": 0,
      "name": "open-board",
      "narration": "Here's the finishing lab — every rep gets tracked on this board.",
      "start": 1.02,
      "end": 6.10,
      "clicks": [ { "x": 512, "y": 340, "t": 2.41 } ],
      "frame": "frames/step_00.png"
    }
  ],
  "console": { "errors": 0, "warnings": 2, "log": "console.jsonl" }
}
```

Consumption: `spool read <workdir-or-share-dir>` prints an agent-oriented digest
(title, url, per-step narration + timings + frame paths, console error summary) so
a receiving agent can orient in one command and Read only the frames it needs.
Paths inside spool.json are share-dir-relative; the bundle is self-contained apart
from the ../final.mp4 pointer.

## Render layer inputs

`spool render <workdir> [--rate 1]` reads `timeline.json` + `vo/manifest.json`, runs
the normalize pass (`video.webm` → `video.mp4`, CFR 30fps, H264, yuv420p, +genpts),
then renders the Remotion `SpoolComposition` with `{ workdir-relative props }` (1920x1080
macOS-wallpaper-style gradient canvas, recording on a near-full-bleed rounded card,
subtitle-style intro title, captions/VO/zoom on the OUTPUT clock below).

**Retiming (record-first).** The capture is natural-speed; the renderer maps each step
onto an output window and concatenates them from t=0:

- `window_i = max(voDuration_i + 0.4, recordedDuration_i)`, `outStart_i = Σ_{k<i} window_k`.
- Video: the step's recorded slice (`[start_i, end_i]`) plays at **1x** at `outStart_i`,
  then its **last frame freeze-holds** for the rest of the window (window is a max, so the
  played portion always fits; video is never sped up). A ~1s tail holds the final frame.
- Audio: `vo seg_i` is placed at `outStart_i`. Captions offset each segment's word times by
  `outStart_i`. A click logged at recording time `t` in step `i` maps to `outStart_i + (t − start_i)`.

`--rate` defaults to **1.0** (pacing is narration-driven; dead air in a window is a freeze
under continuing narration). When `rate ≠ 1` the whole clip is sped up (video setpts +
pitch-preserved atempo) → `final.mp4`, and `final.mp4` then runs on a compressed clock.

Bookkeeping: `video.mp4` and all times in `timeline.json` / `console.jsonl` stay on the
**recording** clock; `spool.json` step `start`/`end`/`clicks` and `duration` are on the
**output** clock. `spool share` extracts keyframes from `video.mp4` (recording clock) but
reports output-timeline step times, `duration` from `final.mp4`, and a top-level `rate`.

Render is bundle-cached: the Remotion webpack bundle is persisted under the OS tmpdir keyed
by a hash of `src/render/**` + the remotion version, and reused across builds when unchanged.
