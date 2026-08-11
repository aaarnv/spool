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

Then check the connection FIRST — run `spool doctor --json` and read the `token` check. One
connection covers BOTH publishing and hosted AI voice, so no OpenAI key is required.

- If the token check is **ok**, you're connected; continue.
- If it is **not ok**, STOP and ask the human to run `spool login` (it opens a browser to sign
  in and approve — you cannot complete browser auth yourself).
- If the human has already handed you a raw `spk_` token, write it directly (no browser needed):

  ```bash
  # token from https://spoolkit.dev/dashboard → Generate token
  echo '{"host":"https://spoolkit.dev","token":"spk_..."}' > ~/.spool.json
  ```

  or pass it via `spool login --paste`.

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
   the recorded session and finishes it). Finish/build **publish automatically** when the
   machine is connected (PR workdirs also comment on their PR); pass `--no-publish` to keep a
   take local, e.g. while you verify keyframes first. Note: fumbles you leave on screen are recorded; a
   failed `h.click` fails fast (5s locator timeout in live sessions) but those seconds still
   land in that step's window — retry promptly. The generated `steps.mjs` omits failed snippets, so
   re-running `spool build` on it gives a clean take.
5. **Verify + report** (same as below).

## Cloud render (`--cloud`)

`spool finish spool/<slug> --cloud` runs the voiceover, the render, the share bundle and the
publish on spoolkit.dev instead of this machine, then prints the watch link. Reach for it when
the box is slow or busy, or when the render toolchain is missing; the local path stays the
default. It needs a connected account (`spool login`) and a finished recording, and it always
publishes, so `--no-publish` and `--preview` are errors. `--rate`, `--bg`, `--format`,
`--voice`, `--speed` and `--hq` all carry over, and `spool render <dir> --cloud` runs the same
job. The upload is the take's video (tens of MB) and the wait is a few minutes; afterwards
`spool open spool/<slug>` reopens the link.

## Short-form vertical spools

For launch clips and social posts: a 1080x1920 cut, 15 to 45 seconds, one idea, hook first.
Recording, voice, captions and publishing are unchanged; only the render is vertical. Keep the
wide default for client walkthroughs and PR guides.

1. **Seed the capture before recording.** Write `spool/<slug>/steps.mjs` containing only
   `export const config = { viewport: { width: 1920, height: 1080 } };` (live reads an existing
   config for its viewport), and export `SPOOL_CAPTURE=cdp`. The vertical camera cover-crops and
   upscales the landscape capture, about 1.5x from 1920x1080 against 1.8x from the 1600x900
   default, so capture sharpness is the whole ballgame here.
2. **Record.** `spool live spool/<slug> --url <app-url> --format vertical`, then drive it exactly
   as in the Live path above, with these constraints:
   - 3 to 5 steps, and keep each step's action in ONE screen region. The camera cannot follow an
     action that starts top-left and ends bottom-right.
   - ONE sentence of narration per step, 90 words TOTAL across the spool. That word budget is
     what lands the finished cut between 15 and 45 seconds.
   - `zoom: { selector: "..." }` drives the camera to that element; `"none"` (the default)
     gives a gentle wide drift; `"auto"` follows that step's clicks. Same field, new job.
   - End the last step settled, with ~2s of `h.pause` under the CTA.
3. **Author the frame.** `--format vertical` already stamped `format` into the generated
   `steps.mjs`. Add the rest of the short's furniture to its `config`, then
   `spool finish spool/<slug>`:

   ```js
   hook: 'Your diffs explain themselves now',    // <= 7 words, the payoff
   cta: { text: 'See the full walkthrough', url: 'spoolkit.dev' },
   music: 'uplift',                              // 'uplift' | 'calm' | 'none' | path to a file
   ```

   The hook is a title card over the first ~2s, so it has to be the PAYOFF, not the topic:
   "Your diffs explain themselves now", never "A tour of the new PR guide". Both `hook` and
   `cta` fall back to the spool title and URL when omitted.
4. **Verify + report** (below). ffprobe should read 1080x1920 and a 15 to 45s duration.

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
- Publishing happens automatically at the end of `spool finish`/`spool build` (a PR workdir's
  `pr.json` also triggers the PR comment: watch link + step index via `gh`, so the reviewer
  gets the narrated demo inline). If you finished with `--no-publish`, run
  `spool publish <dir>` (add `--pr` when a PR exists) once you've verified the take.
- **If publish exits with a 402 upgrade message** (the free plan's 3-spool limit), relay that
  message and its upgrade link to the user verbatim rather than retrying the publish.

## Project init (spool init)

When you start using spool on a repo (or are asked to "set up spool for this project"), seed the
project's shared knowledge once so future guides and recordings start warm. This is what makes
later recordings instant: the next session reads the recording topics instead of re-deriving the
dev-server and auth story.

1. **Scaffold.** Bare `spool init` (no slug) detects the repo owner/name via `gh`, fetches the
   current project store into `spool/project/knowledge.json` (read-only reference), and writes an
   empty seed ops file `spool/project/knowledge-ops.json`. Needs `gh` on PATH and `gh auth login`.
2. **Survey and author `knowledge-ops.json`.** Read the README, docs, and code layout, then author
   seed ops: one `set_overview`; a `set_subsystem` for each major module a reader needs (5-15); a
   `set_term` for each piece of domain vocabulary; one `add_decision` only if the repo embodies a
   foundational decision. Read `knowledge.json` first and UPDATE existing entries rather than
   duplicating. No em dashes.
3. **BOOT the app and confirm it serves**, then record what you learned as `set_recording` topics
   (`run`: the exact command, port, and env needs; `auth`: the dev-login or test-account shape,
   never secret values; `record-tips`: what flows demo well; `gotchas`: flaky bits, pre-warm
   needs). This operational memory is the whole point of seeding.
4. **Apply.** `spool init --apply` reads `knowledge-ops.json`, POSTs the ops to the project store
   with your spk token, prints the applied/skipped counts and the project page URL, refreshes
   `knowledge.json`, and resets the ops file to `ops: []` so a re-run cannot double-apply.

After seeding, any `spool pr` or `spool live` session on this repo starts from the recording
topics (they arrive in the scaffold's `knowledge.json` and summary). Keep them current: when the
boot command, dev-login, or a flaky element changes, record the new reality with `set_recording`
ops (via `spool pr`'s `knowledge-ops.json`, or a fresh `spool init`).

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
4. **Author project knowledge (`knowledge-ops.json`).** The scaffold also wrote
   `knowledge.json` (the repo's accumulated cross-PR store, read-only) and an empty
   `knowledge-ops.json`. Read `knowledge.json` FIRST, then record only the durable truths this
   PR changes about the repo, not PR narration:
   - UPDATE the existing `subsystem`/`term` entries the PR touched (`set_subsystem`/`set_term`
     with the same name) rather than duplicating them; the server re-stamps provenance.
   - Add vocabulary (`set_term`) only for genuinely new concepts a future reader needs.
   - Add exactly one `add_decision` when the PR embodies a real decision (a tradeoff, a
     direction), and none otherwise.
   - Leave `ops: []` when nothing durable changed. This ships regardless of the video mode.
5. **Choose the video mode.**
   - **Before recording, read `knowledge.json`'s `recording` topics** (run, auth, record-tips,
     gotchas) and follow them: how to boot this repo's app, the dev-login trick, any pre-warm
     the flow needs, and the known flaky elements to avoid. This is operational memory left by
     the last agent that recorded this repo.
   - **UI-surface change** (`mode:"walkthrough"`) → live-record the running feature as usual
     (Live path above), naming steps after stop ids.
   - **Non-UI change** (refactor, backend, infra; `mode:"explainer"`) → author a
     self-contained single-file `explainer.html` in the workdir (designed for the 1600x900
     live viewport: dark, big type, one section per stop), then record it:
     `spool live spool/pr-<n> --url file:///abs/path/explainer.html`. If the page needs local
     assets, serve it with `python3 -m http.server` and use the `http://localhost:PORT/…` URL
     instead of `file://`. Drive one section reveal per step.
6. **Mapping rule (critical).** Each live `/step` name MUST equal the tour stop id it
   illustrates. That is the only link between the tour and the video. Not every stop needs a
   step (an unmapped stop degrades to prose + diff on the watch page); steps without a matching
   stop are fine too.
7. **Finish + publish.** If the recording session taught you something operational (a dev-login
   trick, a selector gotcha, a pre-warm need), write it back into `knowledge-ops.json` via
   `set_recording` ops so the next agent records this repo without re-deriving it. Then
   `spool finish spool/pr-<n> --no-publish` → verify keyframes → `spool publish spool/pr-<n> --pr <n>`
   (or let `spool finish` publish directly; it reads `pr.json` and comments on the PR itself).
   Publish merges `context.md` into the bundle and resolves the `related` files, attaches the
   tour + diff, applies the knowledge ops to the project store, and the `--pr` comment posts a
   guide variant (stop table timestamped to the video) on the PR.

## Ship reels (after you ship)

When you finish a user-visible change, offer a **ship reel**: a 20 to 40 second vertical spool of
what shipped, for the swipeable feed. You are the best producer of one because the app is already
running, already authenticated, and you still remember what you changed. Full contract:
`docs/SHIP-REEL-CONTRACT.md` in the spool repo. The shape is fixed:

```
hook card (first 2s)  ->  2 to 4 stops, one idea each  ->  CTA card (last 1.5s)
```

Owner voice, present tense, why-first ("the dismiss pill is live now"), never discovery voice
("let's take a look at"). 55 to 90 words of narration TOTAL, which is what lands the cut between
20 and 40s. Record the REAL app whenever a URL exists (localhost, staging, preview, or the
surface where the change's own output lands); explainer HTML is the fallback only when nothing
runnable exists, and it must show real artifacts (actual diff hunks, actual output), never bullet
slides. A vertical explainer is authored inside a 640px centred column and reveals by scrolling
rather than clicking; the contract's "Authoring an explainer for the vertical crop" section has
the numbers and why.

1. **Scaffold.** With a merged PR: `spool pr <n>` → `spool/pr-<n>/`. That workdir's `pr.json` is
   what comments the watch link on the PR, and `tour.json` + `diff.patch` give the reel's watch
   page the diff and the Q&A. It refuses to overwrite an existing `tour.json`, so when the PR
   already has a guide workdir, copy `pr.json`/`diff.patch`/`context.*` into `spool/reel-<n>/` and
   author the reel there instead. No PR: any workdir, it publishes as an ordinary vertical spool.
2. **Seed the viewport BEFORE recording.** Write `spool/<dir>/steps.mjs` containing only
   `export const config = { viewport: { width: 1920, height: 1080 } };` (live reads viewport from
   an existing config). The camera crops the landscape capture, so the 1600x900 default renders
   soft. `export SPOOL_CAPTURE=cdp` for the sharper screencast.
3. **Record against the running app.**
   `spool live spool/<dir> --url <app-url> --format vertical --title "<what shipped>"`.
   `--title` is required: vertical draws no title card, so it is the published title and the
   hook's fallback. Then drive it as in the Live path, with 2 to 4 steps, ONE sentence each, each
   step's action inside ONE screen region. The FIRST recorded seconds must show the surface you
   changed most; do any navigation before the first `/step`.
4. **Author the frame AFTER `/end`, BEFORE `spool finish`.** The `/end` rewrite keeps only `url`,
   `viewport`, `title`, `format` and `prep`, so seeding these earlier silently loses them. Add to
   the generated `steps.mjs` config:

   ```js
   hook: 'Dismiss a coaching card for good',  // <= 7 words, the payoff, not the topic
   cta: { text: 'Follow this repo on spoolkit.dev', url: 'spoolkit.dev' },
   music: 'uplift',                           // 'uplift' | 'calm' | 'none' | path
   ```

   Never omit `cta`: its default URL is the recorded URL's hostname, so a localhost recording
   ships a card reading `localhost`.
5. **Trim `tour.json`** (PR-linked reels only) to exactly the stops you recorded, one per step,
   `stop.id` equal to the step name, `mode` `"walkthrough"` or `"explainer"`. A stop matching no
   recorded step is a lint ERROR and blocks the publish. The `only N stop(s)` warning on a 2 or 3
   stop reel is expected. Author `context.md` and curate `related` as for any guide.
6. **Finish.** `spool finish spool/<dir> --format vertical` → renders 1080x1920, publishes, and
   comments the watch link on the PR. Verify with ffprobe (1080x1920, 20 to 40s) and by reading
   `keyframes/step_NN.png`.

CI runs the same flow on merge (`.github/workflows/ship-reel.yml`), so a repo gets reels whether
or not an agent was in the loop.

## Consuming a spool another agent made

`spool read <workdir-or-share-dir>` prints the digest: steps, narration, timings, click
coords, console errors, keyframe paths. Then Read the specific `share/frames/step_NN.png`
you need. Use this instead of parsing the MP4 — the `share/` bundle (auto-written by
`spool build`) exists exactly so agents can review each other's demos, verify claimed
fixes, and file bugs from the captured `console.jsonl`.

## Narration style

**Voice: the engineer who built it, updating a client who knows the product cold but does not
read code.** They have full context on what the product is and how it behaves, so never
introduce it. They do not know how it is built, and do not need to.

- Assume the product, explain the change. "The session tab" needs no introduction; what
  changed about it does.
- Say what it does, not how it is wired: "the report card updates the moment a session ends",
  NOT "the effect refetches on sessionEnd". Keep file names, symbols, types, tables, hooks and
  framework names out of the narration unless one is on screen and is the point of that step.
- Speak about state and changes, not discovery: "the session board feeds the report card now",
  "we've wired up all nine drill modes", NOT "this is X", "let's peek at", "looks like".
- Confident and specific. Call things by the names the client already uses for them. No
  marketing tone, no hedging.
- Never claim anything not visible on screen, and never promise roadmap to a client.
- Mechanics: present tense, contractions always, no em dashes, 1 to 2 short sentences per step.
  Capture is record-first: each step is recorded at natural speed, then the renderer sizes its
  window to `max(narration+pad, recorded)` and freeze-holds the last frame under the voice, so
  narration much longer than the on-screen action means a static freeze; keep it proportional.

**Exception: PR guides.** A `spool pr` tour is read by an engineer reviewing the diff, so file
and symbol names are the substance there rather than jargon to avoid. Every other rule above
still holds.

## steps.mjs gotchas

- `h.*` helpers (click/type/scroll/hover/pause) produce the smooth cursor — use them for
  anything visible. Raw `page.*` is fine for waits/assertions.
- `zoom` defaults to `"none"`. To zoom, name the thing the narration is about:
  `zoom: { selector: ".hero h1" }`. It resolves to that element's box at the end of the step
  and the renderer frames it, scaling to how big the element is. A selector that does not
  resolve logs and renders unzoomed rather than aiming somewhere wrong.
  `"auto"` still exists and aims at that step's clicks, but a click is usually navigation, so
  it tends to frame a nav link or dead space instead of the subject. Reach for it only when
  the thing clicked IS the subject.
- End steps in a settled state (`waitForSelector`), not mid-animation.
- Full contract: `CONTRACTS.md` in the spool repo.
