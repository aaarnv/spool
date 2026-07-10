---
name: spool
description: Record a real narrated walkthrough video of a web app feature — agent drives the browser, real continuous video (NOT screenshot stitching), AI voiceover, word-synced captions, rendered MP4. Use when asked to "make a spool", "make a loom", "record a walkthrough/demo video with narration", "show this feature as a video", or after shipping a feature the user wants demoed. Prefer this skill whenever narration or a client-ready result matters.
---

# spool

The harness is the spool CLI (this repo: `npm install && npm link` puts `spool` on PATH;
see README for requirements). It handles recording, voice, captions, and rendering. Your job is
only: make the app runnable, drive a good walkthrough, run the pipeline, verify.

There are two paths. **Prefer LIVE** when you've just driven the flow in a browser (e.g. right
after verifying a feature you built) — you drive once and the steps are derived from the
session. Use the **SCRIPTED** path when you want a reproducible, debuggable driver up front.

## Live path (recommended) — drive once, record as you go

1. **App up.** Start the target app locally (background Bash), wait for HTTP 200.
2. **Start the session.** `spool live spool/<slug> --url <app-url>` (add `--title "…"`). It
   prints one stdout line `{"port":N,"session":"<dir>"}`; grab `N`. Handle login/prep by
   sending `/js` BEFORE your first `/step` (those become `config.prep`).
3. **Drive it in ONE continuous script.** Write ALL steps as a single shell script (a `J()`
   curl helper + every /step and /js call back-to-back) and run it in ONE Bash call — your
   thinking time between separate tool calls gets RECORDED as dead air in the take. Per step:
   `POST /step {name, narration, zoom?}` (narration
   REQUIRED — the renderer fits the step window to it), then one or more `POST /js {code}` where
   `code` is the body of `async (page, h) => { … }` (use the `h.*` helpers for anything visible).
   A failed `/js` returns `{ok:false}` and does NOT kill the session — fix the selector and
   retry. `GET /status` shows progress. Aim for 4–8 steps, one idea each.
4. **Finish.** `POST /end` → writes `video.webm` + `timeline.json` + `keyframes/` + a generated
   `steps.mjs`. Then `spool finish spool/<slug>` → `final.mp4` (or `spool build`, which detects
   the recorded session and finishes it). Note: fumbles you leave on screen are recorded; a
   failed `h.click` fails fast (5s locator timeout in live sessions) but those seconds still
   land in that step's window — retry promptly. The generated `steps.mjs` omits failed snippets, so
   re-running `spool build` on it gives a clean take.
5. **Verify + report** (same as below).

## OS capture path — record the whole desktop (macOS)

Use this when the demo leaves the browser: native apps, the terminal, multi-window flows.
It's `spool live` with `--target os` — full-display `ffmpeg avfoundation` capture, same control
protocol, but **no `page` driver**. You drive the desktop yourself between steps.

1. **Arrange the desktop first.** Clean it up: hide unrelated windows, quiet notifications,
   and bring the app you're demoing to the front. The capture is the entire display, so
   whatever's frontmost is what lands in the video (focus doesn't auto-steal — raise windows
   explicitly, e.g. `osascript -e 'tell app "Finder" to activate'`).
2. **Start.** `spool live spool/<slug> --target os --title "…"` → one stdout line with the
   `port`. It fails fast if Screen Recording permission is missing (grant it to your terminal
   in System Settings → Privacy & Security → Screen Recording, then restart the terminal).
3. **Drive it.** Per step: `POST /step {name, narration, zoom?}` (narration REQUIRED; `zoom`
   defaults to `"none"` — pass `{"x":…,"y":…}` in capture-pixel coords to zoom a point). Then
   perform the action with your own tools (osascript/System Events/cliclick, `open`, MCPs).
   Use `POST /sh {cmd}` for terminal-visible demos — it runs the command AND logs its stdout
   to `console.jsonl`. Leave a beat (~2–4s of real action) inside each step so there's footage.
4. **Finish.** `POST /end` → `capture.mp4` + `timeline.json` + `keyframes/` + `steps.os.md`
   (there's no `steps.mjs` — nothing to re-drive). Then `spool finish spool/<slug>`.
5. **Verify + report** (below; keyframes are full-display `screencapture` PNGs you can Read).

## Scripted path — reproducible driver

1. **App up** (as above). Handle auth in `config.prep` (dev-login endpoints, seeded sessions).
2. **Script first.** `spool init <slug>` → `spool/<slug>/steps.mjs`. Write 4–8 steps.
3. **Dry-run until clean.** `spool dry spool/<slug>` — fix selectors/waits here. Never burn TTS
   money or render minutes on an undebugged driver. (Dry is only for THIS path.)
4. **Build.** `spool build spool/<slug>` → `spool/<slug>/final.mp4`.

## Verify + report (both paths)

- **Verify before reporting.** ffprobe duration sanity; extract 2–3 frames at click moments
  and READ them (cursor visible? zoom centered? captions legible?). Listen is impossible —
  check `timeline.json` step starts vs `vo/manifest.json` durations instead. Live sessions
  drop `keyframes/step_NN.png` you can Read immediately.
- Report the mp4 path. Share (Discord/Slack/etc.) only if asked.
- **If the demoed change has an open PR**, publish with `spool publish <dir> --pr` (or
  `--pr <number>`) — it comments the watch link + step index on the PR via `gh`, so the
  reviewer gets the narrated demo inline. Do this by default when a PR exists.

## Consuming a spool another agent made

`spool read <workdir-or-share-dir>` prints the digest: steps, narration, timings, click
coords, console errors, keyframe paths. Then Read the specific `share/frames/step_NN.png`
you need. Use this instead of parsing the MP4 — the `share/` bundle (auto-written by
`spool build`) exists exactly so agents can review each other's demos, verify claimed
fixes, and file bugs from the captured `console.jsonl`.

## Narration style

**Voice: the engineer who built it, updating a client — never a first-time viewer.** These
spools get sent to clients; the narrator owns this codebase and speaks with that familiarity.

- Speak about state and changes, not discovery: "the session board feeds the report card now",
  "we've wired up all nine drill modes" — NOT "this is X", "let's peek at", "looks like".
- Assume shared context with the listener: "the session tab" (they know the product), not
  "there's a tab called session".
- Confident and specific; name the things by their real names. No marketing tone, no hedging.
- Never claim anything not visible on screen, and never promise roadmap to a client.
- Mechanics: present tense, contractions always, no em dashes, 1–2 short sentences per step.
  Capture is record-first: each step is recorded at natural speed, then the renderer sizes its
  window to `max(narration+pad, recorded)` and freeze-holds the last frame under the voice — so
  narration much longer than the on-screen action means a static freeze; keep it proportional.

## steps.mjs gotchas

- `h.*` helpers (click/type/scroll/hover/pause) produce the smooth cursor — use them for
  anything visible. Raw `page.*` is fine for waits/assertions.
- `zoom: "auto"` zooms toward clicks in that step; use `"none"` for full-page context steps.
- End steps in a settled state (`waitForSelector`), not mid-animation.
- Full contract: `CONTRACTS.md` in the spool repo.
