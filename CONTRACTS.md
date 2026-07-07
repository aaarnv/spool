# agent-loom data contracts (v1)

Every layer communicates only through these files inside a per-loom **workdir**
(conventionally `<project>/loom/<slug>/`). If you change a format, bump it here first.

## Workdir layout

```
loom/<slug>/
├── steps.mjs            # agent-authored demo script (the only human/agent-written file)
├── vo/
│   ├── manifest.json    # written by `loom vo`
│   ├── seg_00.wav       # 24kHz mono, loudnormed -16 LUFS
│   └── seg_00.words.json
├── video.webm           # written by `loom record` (raw Playwright capture)
├── timeline.json        # written by `loom record`
├── video.mp4            # written by `loom render` (normalize pass, CFR 30fps H264)
└── final.mp4            # written by `loom render` (the deliverable)
```

## steps.mjs (authored per loom)

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

## vo/manifest.json (loom vo → loom record, loom render)

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

## timeline.json (loom record → loom render)

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
      "end": 6.10,
      "voDuration": 4.32,
      "zoom": "auto",
      "clicks": [ { "x": 512, "y": 340, "t": 2.41 } ]
    }
  ],
  "total": 24.8
}
```

- All times in **seconds relative to video t=0** (context/page creation).
- `clicks[].t` is when the click fired; coords are viewport CSS pixels.
- Invariant: `steps[i].end - steps[i].start >= voDuration + 0.4` (padding), so VO
  segments placed at `steps[i].start` never overlap.

## console.jsonl (loom record → loom share)

Browser telemetry captured during recording, one JSON object per line, times in
seconds relative to video t=0 (same clock as timeline.json):

```json
{"t": 3.41, "kind": "console", "level": "error", "text": "Uncaught TypeError: ..."}
{"t": 5.02, "kind": "pageerror", "text": "ReferenceError: foo is not defined"}
{"t": 7.80, "kind": "requestfailed", "text": "GET http://localhost:4747/api/x net::ERR_..."}
```

Levels for kind=console mirror Playwright's msg.type(). Always written (empty file
when nothing fired) so consumers can rely on its presence.

## share/ bundle (loom share → any consuming agent)

The Clips-style agent-consumable artifact. `loom share <workdir>` (auto-run at the
end of `loom build`) writes:

```
loom/<slug>/share/
├── loom.json          # the single machine-readable index (below)
├── transcript.txt     # "[mm:ss] narration" per step — cheap skim for an agent
├── frames/step_NN.png # one keyframe per step (mid-step, post-click when clicks exist)
└── console.jsonl      # copied from the workdir
```

`loom.json`:

```json
{
  "version": 1,
  "kind": "agent-loom",
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

Consumption: `loom read <workdir-or-share-dir>` prints an agent-oriented digest
(title, url, per-step narration + timings + frame paths, console error summary) so
a receiving agent can orient in one command and Read only the frames it needs.
Paths inside loom.json are share-dir-relative; the bundle is self-contained apart
from the ../final.mp4 pointer.

## Render layer inputs

`loom render <workdir>` reads `timeline.json` + `vo/manifest.json`, runs the normalize
pass (`video.webm` → `video.mp4`, CFR 30fps, H264, yuv420p, +genpts), then renders the
Remotion `LoomComposition` with `{ workdir-relative props }` to `final.mp4`
(1920x1080 canvas, recording centered on padded rounded-corner card, VO `<Audio>` at
`steps[i].start`, captions driven by words.json offset by segment start, zoom eased
around `clicks`).
