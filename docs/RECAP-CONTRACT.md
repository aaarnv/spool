# Spool recaps: authoring contract (v1)

A **recap** is a 20 to 40 second vertical spool of what a merged change shipped, built for a
swipeable developer feed. One swipe, one change, caught up.

Two producers make them and they must produce the same artifact:

- **The `spoolkit` GitHub App** (how recaps are actually made today): a PR merge queues a
  `render_recap` job (`web/lib/recapEnqueue.ts`) and the worker (`worker/index.mjs`) renders a
  vertical diagram video from the diff, then comments the watch link on the PR. No capture.
- **Local agent**: an agent records a vertical spool by hand when somebody asks for a
  walkthrough of the change while the app is still running.

A recap is **not a new CLI mode**. It is an ordinary vertical spool (`--format vertical`) with a
fixed shape, a fixed register, and a fixed length budget. This file pins that shape so both
producers converge. The mechanics of the vertical render itself live in `CONTRACTS.md`
("Vertical format"); this file is the authoring contract on top of them.

## Purpose

A recap answers one question: **what changed and why you care.** In 20 to 40 seconds, on a phone,
with the sound possibly off.

It is not a tutorial, not a PR review, not release notes read aloud, and not a product pitch. A
viewer who already knows the product should finish the recap knowing exactly what is different
today and what it lets them do.

## Shape

```
hook card (overlay, first 2.0s)  ->  2 to 4 recorded stops  ->  CTA card (last 1.5s)
```

- **One idea per stop.** A stop that needs "and also" is two stops, or it is cut.
- **2 stops** is a legitimate recap (one change, one payoff). **4 is the ceiling**: past that the
  recap stops being a catch-up and starts being a walkthrough, which is what a wide spool is for.
- The hook card is an **overlay on the first 2 seconds of stop 1**, not a separate segment. The
  footage underneath it is already playing, so stop 1 must open on the changed surface.
- The CTA card is **added time**: it holds over the last 1.5s of the closing freeze.

## The hook

`config.hook` is the one line that earns the next 30 seconds. Seven words or fewer.

It states the **change and its payoff**, never the topic:

| write this | not this |
|---|---|
| Dismiss a coaching card for good | A tour of the dismiss pill |
| Your diffs explain themselves now | New PR guide feature |
| Imports keep the guest's phone number | Guest import improvements |

Two hard rules:

1. **The hook is authored, never inherited.** When `config.hook` is absent the renderer falls back
   to `timeline.title` (the `--title` you passed), which reads like a PR title, not a hook.
2. **The first recorded seconds must show the most visually changed surface.** No login screen, no
   dashboard establishing shot, no "first let me navigate to". Open on the thing that is different.
   Do the navigation in `config.prep` or in a `/js` call before the first `/step`, so it is
   recorded before the recap's clock starts.

## Narration register

Owner voice: the engineer who shipped it, telling someone who uses the product what landed.
They know the product cold and do not read code, so name the change by what it does rather
than how it is wired. Present tense, why first.

| write this | not this |
|---|---|
| The dismiss pill is live now, so a card you kill stays dead. | Let's take a look at the new dismiss feature. |
| Guest imports keep the phone number, so the WhatsApp send just works. | Here we can see that the phone number is now imported. |
| Captures retry on their own now. | I'm going to show you what happens when a capture fails. |

- Present tense, contractions, no filler, no hedging, no marketing.
- Never narrate what the viewer can already read on screen. Narrate why it matters.
- Never claim anything not visible in the footage, and never promise roadmap.
- No em dashes (the lint warns on them).

## Length budget

The renderer sizes each step window to its narration, so **word count is the length control**:

```
duration = sum over stops of max(voDuration + 0.4s, recordedDuration) + 1.0s tail + 1.5s CTA
```

| knob | budget |
|---|---|
| total narration | **55 to 90 words** across the whole recap |
| per stop | 15 to 30 words, one or two short sentences |
| recorded action per stop | under ~10s, and shorter than its narration wherever possible |
| stops | 2 to 4 |
| finished duration | 20 to 40s (ffprobe it) |

Recorded footage longer than its narration is what silently blows the budget: the window is a
`max`, so a 20s fumble in one stop cannot be recovered by trimming words. Keep each stop tight,
and re-record a stop rather than shipping a long one.

The reverse is not a problem, and reads better than authors expect. When a stop's recorded action
is shorter than its narration the video freeze-holds its last frame, but the camera keeps moving:
`sampleCamera` clamps time into the step's whole output window rather than stopping at the recorded
end, so the drift or the click release plays out under the freeze. A 3s take under 9s of narration
lands as a slow push, not dead air. Do not pad a stop with pauses to match its narration.

## Footage rules

**Record the real app whenever a URL exists.** In priority order:

1. A preview deployment of the merged change (CI: `SPOOL_PREVIEW_URL`).
2. Staging.
3. The app running on localhost (the local agent almost always has this already up, warm, and
   authenticated; that is why the local path is first class).
4. The surface where this change's user-visible OUTPUT already lands: a spoolkit.dev watch page
   rendering what the change produces, a dashboard, a generated artifact served somewhere. When
   the output is something you can publish, publish it first and then record the page it lands on.

**"Runnable surface" is scoped to where the result lands, not to whether the merged diff touches
UI.** Reading a diff, seeing only docs, workflows or backend code, and jumping to an explainer is
the most common way to get this wrong. A change with no UI of its own very often still has a live
surface showing what it does. Rule out priority 4 explicitly before falling back.

**Explainer HTML is the fallback ONLY when no runnable surface exists** (a pure refactor, an infra
change, a library with no UI). An explainer recap must show **real artifacts**: actual diff hunks
from `diff.patch`, actual command output, actual config or JSON from the repo, drawn INTO the
diagrams described below rather than pasted onto the screen as text. Bullet slides with the change
described in prose are not a recap and must not be published as one. If the only honest explainer
is three bullets, the change does not warrant a recap.

Two constraints the vertical camera imposes on the driving:

- **One screen region per stop.** The camera cover-crops and pans toward that step's clicks; it
  cannot follow an action that starts top left and ends bottom right. Split the stop, or scroll
  the target into the region first.
- **Seed the capture viewport to 1920x1080 before recording.** The camera upscales the landscape
  capture into a 1056x1616 stage, about 1.5x from 1920x1080 against 1.8x from the 1600x900
  default. Capture sharpness is the whole ballgame.

### Authoring an explainer for the vertical crop

**Every stop's main surface is a DIAGRAM.** A spool is a visual medium, so each stop is carried by
a flow, a pipeline drawn as boxes and arrows, a before and after panel, a labelled anatomy, or an
animated reveal. Text is labels and annotation on top of that shape. Code, yaml, JSON and config
appear only as a small excerpt annotated inside a visual, never as the stop's main surface: a
screenful of syntax-highlighted config is the anti-pattern this rule exists to stop, and it is
still the anti-pattern when the config is real. "Real artifacts" governs where the content comes
from, not how it is drawn.

**The litmus test: if a paused frame would work unchanged as a screenshot in a text doc, the stop
is not visual enough.** Redraw it as a shape that carries the idea, then hang the real strings off
that shape as labels. Staged CSS reveals of diagram elements read especially well here, because
the drift camera is already moving under them.

**Author inside a 640px centred column.** The camera cover-crops the 1920x1080 capture into the
1056x1616 stage (`STAGE` in `src/render/vertical.mjs`), so at rest only about 706px of the
capture's width is on screen, and a step with no clicks drifts to `DRIFT_Z` 1.05, tightening that
to about 672px by the end of every step. A full width page loses roughly two thirds of itself.
Centre one column, size the type for a phone, and let the vertical space run: the full 1080px
capture height stays in frame throughout.

**Reveal by scrolling, not by clicking.** A click sets `CAM_Z_CLICK` 1.25 and pans the camera onto
it, narrowing the visible column to about 565px and pushing it off centre, which crops a centred
layout. `zoom: "auto"` with no recorded clicks falls back to the drift path, so drive each stop's
reveal with `page.evaluate(() => document.getElementById("<stop>").scrollIntoView())` and the whole
column stays framed. Clicks belong in real-app takes, where following the cursor is the point.

## Authoring flow

Both producers run these steps in this order.

### 1. Scaffold

With a merged PR, `spool pr <number>` writes `spool/pr-<n>/` (`pr.json`, `diff.patch`,
`tour.json`, `context.json`, `context.md`, `knowledge.json`, `knowledge-ops.json`). The workdir's
`pr.json` is what makes `spool finish` comment the watch link on the PR, and `tour.json` +
`diff.patch` are what give the recap's watch page the diff and the grounded Q&A.

`spool pr` **refuses to overwrite an existing `tour.json`**. When the PR already has a guide
workdir in this checkout, do not re-scaffold: copy `pr.json`, `diff.patch`, `context.json` and
`context.md` into a sibling recap workdir (`spool/recap-<n>/`) and author the recap's own `tour.json`
there. The guide and the recap are two takes; they cannot share one workdir.

Without a PR (an agent shipping straight to a branch or trunk), any workdir path works and the
recap publishes as an ordinary vertical spool with no diff pane.

### 2. Seed the capture config BEFORE recording

`spool live` reads viewport from an existing `steps.mjs`, so write one first:

```js
export const config = { viewport: { width: 1920, height: 1080 } };
```

Optionally `export SPOOL_CAPTURE=cdp` for the higher-quality CDP screencast.

### 3. Record

```bash
spool live spool/pr-<n> --url <app-url> --format vertical --title "<what shipped>"
```

`--title` is required: vertical renders draw no title card, so `--title` is the **published
spool title** and the hook's fallback. `--format vertical` stamps `format` into the generated
`steps.mjs` and selects the short-form TTS register.

Drive it exactly as the Live path in the skill: one continuous shell script, `POST /step` per
stop, `POST /js` between them, `POST /end` at the finish. Step `name` is the tour stop id.
`zoom: "auto"` points the camera at that step's clicks; `"none"` gives a gentle drift for a
context stop. End the last stop settled with ~2s of `h.pause` so the CTA lands on a finished frame.

### 4. Author the frame AFTER `/end`, BEFORE `spool finish`

**This is the step every producer gets wrong.** The `/end` rewrite of `steps.mjs` preserves only
`url`, `viewport`, `title`, `format` and `prep`. Anything else seeded into `config` beforehand,
including `hook`, `cta` and `music`, is **dropped**. Add them to the generated `steps.mjs` after
recording ends:

```js
export const config = {
  url: "http://localhost:3000/coaching",
  viewport: { width: 1920, height: 1080 },
  title: "Dismissed coaching cards stay dismissed",
  format: "vertical",

  // authored post-record: /end preserves only the four fields above
  hook: "Dismiss a coaching card for good",
  cta: { text: "Follow this repo on spoolkit.dev", url: "spoolkit.dev" },
  music: "uplift",
};
```

**Never omit `cta`.** Its default URL is the hostname of the recorded URL, so a recap recorded on
localhost ships a CTA card that reads `localhost`. Default text is
`Follow this repo on spoolkit.dev` pointing at `spoolkit.dev`; swap in a repo-appropriate
destination (the project's docs, its landing page) when the repo has a better one. The URL must be
somewhere a viewer can actually land today.

`music` is `"uplift"` (default) | `"calm"` | `"none"` | a path to an audio file. The bed sits at
0.3 and ducks to 0.12 under every narration window, so it never fights the voice. Use `"calm"` for
a change that is quiet or serious, `"none"` when the footage carries audio of its own.

### 5. Trim `tour.json` to the recap's stops (PR-linked recaps)

The scaffold seeds one placeholder stop per changed file. A recap has 2 to 4 stops, so rewrite it:

- Exactly one stop per recorded step, in recorded order.
- **`stop.id` must equal the recorded step name.** A stop matching no recorded step is a lint
  **error** and blocks the publish (it would publish with `step: null` and lose its seek anchor).
- `mode` is `"walkthrough"` when the recap recorded the real app, `"explainer"` when it recorded
  `explainer.html`.
- `prose` is the written companion to the narration, not a transcript of it: what a reader who
  opens the watch page needs beyond the 30 seconds.
- Delete `_instructions`.

Lint warns `only N stop(s); 4 to 8 reads best` on a 2 or 3 stop recap. That warning is expected for
this format and does not block publishing. Also author `context.md` and curate `context.json`'s
`related`, exactly as a PR guide does: the recap is short, the watch page Q&A is not.

### 6. Finish and publish

```bash
spool finish spool/pr-<n>
```

`spool finish` runs VO, render, share and **publishes automatically**; the workdir's `pr.json`
makes it comment the watch link on the PR. It takes no format of its own: the format is stamped
at capture, so finish reads `format: "vertical"` out of the generated `steps.mjs`. A recording
made without `--format vertical` renders wide, and the fix is to record it again.

Use `--no-publish` only when you intend to verify keyframes first, then `spool publish <dir> --pr`.
The canvas is house-picked and dark, which is what keeps the captions legible over the visible
border the stage leaves.

### 7. Verify

- **Explainers, BEFORE recording: preview the crop.** Screenshot the page at 1920x1080, then run

  ```bash
  ffmpeg -i page.png -vf "crop=672:1080:624:0,scale=1056:1616" crop-preview.png
  ```

  and read the result. It reproduces exactly what the camera shows at the tightest point of the
  drift. This check exists because neither lint nor ffprobe can see clipped content: a code line a
  few pixels too wide for its card is cut silently by `white-space: pre` plus `overflow: hidden`,
  and ships that way.
- `ffprobe` reads **1080x1920** and a **20 to 40s** duration.
- Read `keyframes/step_NN.png`: the opening frame is the changed surface, the camera is centred on
  the action, captions are legible.
- Word count of all narration is within 55 to 90.

## Publishing and linkage

| the recap has | published as | watch page gets |
|---|---|---|
| `pr.json` + `tour.json` | PR-linked recap | video, tour spine, full diff, grounded Q&A, PR comment |
| `pr.json` only | ordinary spool | video; `--pr` still comments the watch link |
| neither | ordinary spool | video |

The PR-linked shape is the default: it costs one trimmed `tour.json` and it makes the 30 second
recap the entry point to the whole change rather than a dead end.

Publish defaults apply unchanged: automatic at the end of `spool finish`, lint errors block, a 402
means the free plan's published-spool limit is reached (relay that message verbatim, do not retry).
The limit counts LIVE spools published in the current UTC month only, so a failed recap render
never consumes a slot and last month's spools do not either.

## Degradation rules

- **No `hook`** falls back to the spool title, which reads like a PR title. Always author it.
- **No `cta`** falls back to `See the full walkthrough` at the recorded URL's hostname, which is
  `localhost` for a local recording. Always author it.
- **Unresolvable `music`** warns and falls back to `uplift`; `"none"` renders silent under the voice.
- **A tour stop matching no recorded step** is a lint error and blocks publishing. Fix the ids.
- **A workdir with no `tour.json`** publishes as an ordinary spool, byte for byte the normal path.
- **No preview URL and no runnable surface** means explainer mode with real artifacts. It never
  means bullet slides.
