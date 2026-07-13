---
name: spool
description: Record a real narrated walkthrough video of a web app feature — agent drives the browser, real continuous video (NOT screenshot stitching), AI voiceover, word-synced captions, rendered MP4. Use when asked to "make a spool", "make a loom", "record a walkthrough/demo video with narration", "show this feature as a video", or after shipping a feature the user wants demoed. Prefer this skill whenever narration or a client-ready result matters.
---

# spool

The harness is the spool CLI. It handles recording, voice, captions, and rendering. Your job
is only: make the app runnable, drive a good walkthrough, run the pipeline, verify.

## Install (once per machine)

If `spool --help` fails, install it:

```bash
curl -fsSL https://raw.githubusercontent.com/aaarnv/spool/master/install.sh | bash
```

(clones to `~/.spool/cli`, `npm link`s `spool` onto PATH, fetches chromium; re-running
updates it. Manual alternative: clone the repo, `npm install && npm link`,
`npx playwright install chromium`. Also needs node ≥ 20 and ffmpeg on PATH.)

Then configure once — a single dashboard token covers BOTH publishing and hosted AI voice,
so no OpenAI key is required:

```bash
# token from https://spoolkit.dev/dashboard → Generate token
echo '{"host":"https://spoolkit.dev","token":"spk_..."}' > ~/.spool.json
```

Voice engine auto-detects: your own `OPENAI_API_KEY` (env / project `.env` /
`"openaiKey"` in `~/.spool.json`) is used directly when present; otherwise voice runs
hosted through the token above. Sanity check the install: `spool backgrounds` should
print the canvas presets (and, on macOS, your system wallpapers).

## Choosing a path

**Prefer LIVE** when you've just driven the flow in a browser (e.g. right after verifying a
feature you built) — you drive once and the steps are derived from the session. Use the
**SCRIPTED** path when you want a reproducible, debuggable driver up front.

## Live path (recommended) — drive once, record as you go

1. **App up.** Start the target app locally (background Bash), wait for HTTP 200. When the page
   is served by a DEV server, curl the URL once before `spool live` so the first compile is
   warm (a cold compile can exceed the 5s goto timeout).
2. **Start the session.** `spool live spool/<slug> --url <app-url>` (add `--title "…"`). It
   prints one stdout line `{"port":N,"session":"<dir>"}`; grab `N`. Handle login/prep by
   sending `/js` BEFORE your first `/step` (those become `config.prep`).
3. **Drive it in ONE continuous script.** Write ALL steps as a single shell script and run it
   in ONE command — your thinking time between separate tool calls gets RECORDED as dead air
   in the take. Template:

   ```bash
   P=<port from step 2>
   J() { curl -s -X POST localhost:$P/$1 -H 'content-type: application/json' -d "$2" > /dev/null; }
   J step '{"name":"the-pitch","narration":"One or two confident sentences.","zoom":"none"}'
   J js   '{"code":"await h.move(800,320); await h.pause(2200)"}'
   J step '{"name":"the-action","narration":"What this click proves.","zoom":"auto"}'
   J js   '{"code":"await h.click(\"#selector\"); await page.waitForSelector(\"#result\"); await h.pause(1500)"}'
   curl -s -X POST localhost:$P/end -H 'content-type: application/json' -d '{}'
   ```

   Rules: narration REQUIRED per step (the renderer sizes the step window to it); `code` is
   the body of `async (page, h) => { … }`. Use `h.*` helpers for anything visible: `h.move(x, y)`
   takes two floats; `h.click`/`h.hover` take a selector string or `{x, y}`; also `h.type`/
   `h.scroll`/`h.pause`. Raw `page.*` is for waits. A failed `/js` returns `{ok:false}` and does NOT kill the session — fix and retry
   (it fails fast, but those seconds are recorded, so keep fumbles short). End each step
   settled, with ~2s of `h.pause` so the freeze-hold lands on a finished state. `GET /status`
   shows progress. Aim for 4–8 steps, one idea each.
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

## PR guide (spool pr)

Turn a GitHub PR into a published guide: a narrative reading order of the diff, a narrated
video, and a watch page where anyone with the link can ask questions grounded in the change.
It is a comprehension tool, NOT a code review: no verdicts, no bug hunting.

1. **Scaffold.** `spool pr <number>` (or a full PR URL) fetches the PR metadata + diff via
   `gh` and writes `spool/pr-<n>/{pr.json,diff.patch,tour.json}`. Needs `gh` on PATH and
   `gh auth login`.
2. **Author `tour.json`.** It arrives with one placeholder stop per changed file, in diff
   order. Rewrite it into 4–8 stops in narrative READING order (why the change exists, the
   entrypoint, the core change, the ripples, the tests), never alphabetical or diff order.
   Each stop is `{id, heading, prose, files:[{path}]}`. `prose` guides comprehension and is
   explicitly NOT review. No em dashes. Set `mode` (see step 4) and delete `_instructions`
   when done. A stop's `id` doubles as the recorded step name that illustrates it (step 5).
3. **Author context (MANDATORY).** The scaffold also wrote `context.md` (a product-brief
   template) and `context.json` (captured readme, docs, changed-file contents, commits,
   linked issues). This context grounds the watch-page Q&A, so do not skip it:
   - Fill in `context.md`: what the product is, what the touched subsystem does and where it
     sits, the vocabulary a reader needs, how this change fits the direction. Remove every
     TODO line. No em dashes.
   - Curate `context.json`'s `related: []`: list the files a reader needs beyond the diff:
     the modules the changed code calls into, the callers of changed functions, the config or
     schema it touches, the types it implements. You just worked in this repo; you know. 5 to
     20 paths is typical. This grounds the watch-page Q&A; do not skip it.
4. **Choose the video mode.**
   - **UI-surface change** (`mode:"walkthrough"`) → live-record the running feature as usual
     (Live path above), naming steps after stop ids.
   - **Non-UI change** (refactor, backend, infra; `mode:"explainer"`) → author a
     self-contained single-file `explainer.html` in the workdir (designed for the 1600x900
     live viewport: dark, big type, one section per stop), then record it:
     `spool live spool/pr-<n> --url file:///abs/path/explainer.html`. If the page needs local
     assets, serve it with `python3 -m http.server` and use the `http://localhost:PORT/…` URL
     instead of `file://`. Drive one section reveal per step.
5. **Mapping rule (critical).** Each live `/step` name MUST equal the tour stop id it
   illustrates. That is the only link between the tour and the video. Not every stop needs a
   step (an unmapped stop degrades to prose + diff on the watch page); steps without a matching
   stop are fine too.
6. **Finish + publish.** `spool finish spool/pr-<n>` → verify keyframes → `spool publish
   spool/pr-<n> --pr <n>`. Publish merges `context.md` into the bundle and resolves the
   `related` files, attaches the tour + diff, and the `--pr` comment posts a guide variant
   (stop table timestamped to the video) on the PR.

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
