---
name: spool
description: Record a real narrated walkthrough video of a web app feature — agent drives the browser, real continuous video (NOT screenshot stitching), AI voiceover, word-synced captions, rendered MP4. Use when asked to "make a spool", "make a loom", "record a walkthrough/demo video with narration", "show this feature as a video", or after shipping a feature the user wants demoed. Prefer this skill whenever narration or a client-ready result matters. It also covers Plan Spools — a recorded PROPOSAL that asks a human to approve or redirect work before it is built, plus the `spool gate`, `spool read --plan` and `spool reply` commands that act on the decision. Use that half when asked to "make a plan spool", "propose this before building", "get this approved first", when the change is risky or the request is ambiguous, when picking up another agent's plan, or when `spool gate check` blocks the work.
---

# spool

The harness is the spool CLI. It handles recording, voice, captions, and rendering. Your job
is only: make the app runnable, drive a good walkthrough, run the pipeline, verify.

## Install (once per machine)

If `spool --help` fails, install it from the repo:

```bash
git clone git@github.com:aaarnv/spool.git ~/.spool/cli
cd ~/.spool/cli && npm install && npm link
npx playwright install chromium
```

Also needs node ≥ 20 and ffmpeg on PATH (macOS: `brew install ffmpeg`).

The repo is PRIVATE, so this needs repo access, and so do `install.sh` and every
`raw.githubusercontent.com` path. `@spoolkit/cli` on npm is frozen at `0.3.1` and is far
behind this CLI, so do not install from npm. Without repo access there is no install today.

## First run (once per repo)

Run bare `spool init` from inside the project you are going to record. It is the whole setup:
environment checks, login, preferences, repo detection, the GitHub App link, and the knowledge
seed scaffold. Each step prints one line and skips itself when already satisfied, so running it
on a set-up machine costs nothing.

```bash
cd <the project you will record>
spool init
```

Read the output before doing anything else:

- **Step 1 fails** → STOP and fix what it names (node, ffmpeg, or chromium). It prints the exact
  command for each. An `openai-key` warning is fine: hosted voice covers it, no key needed.
- **Step 2 says "not connected, and this is not a terminal"** → STOP and ask the human to run
  `spool login` themselves. It opens a browser to sign in and approve, and you cannot complete
  browser auth. If the human has already handed you a raw `spk_` token, write it directly and
  re-run `spool init`:

  ```bash
  # token from https://spoolkit.dev/dashboard → Generate token
  echo '{"host":"https://spoolkit.dev","token":"spk_..."}' > ~/.spool.json
  ```

  or pass it through with `spool init --paste`. In CI, `spool init --no-login` skips the step.
- **Step 5** prints the GitHub App install link. Relay it to the human: installing the App is
  what turns a merged pull request into a recap. You cannot install it yourself.
- **Step 6** scaffolds `spool/project/`. Author it next, per "Project init" below.

One connection covers BOTH publishing and hosted AI voice. The voice engine auto-detects: your
own `OPENAI_API_KEY` (env / project `.env` / `"openaiKey"` in `~/.spool.json`) is used directly
when present; otherwise voice runs hosted through the token. `spool doctor` (add `--json` for a
machine-readable form) re-runs the step 1 checks any time.

## Choosing a path

**Use LIVE.** It is the default: your real working session IS the take, you drive once, and the
step boundaries are derived from what the session did. The **SCRIPTED** path is an escape hatch
for a demo that must replay identically in CI — it costs a dry run plus a record run, so reach
for it only when byte-for-byte repeatability is the point.

Nothing about a boundary is permanent. Capture stores the take plus `signals.jsonl`, and the cut
is derived from that log, so a wrong boundary is fixed with `spool recut` — one pass, no browser,
no re-record. See "Recut".

## Live path (default) — drive once, record as you go

1. **App up.** Start the target app locally (background Bash), wait for HTTP 200. When the page
   is served by a DEV server, curl the URL once before `spool live` so the first compile is
   warm (a cold compile can exceed the 5s goto timeout).
2. **Start the session.** `spool live spool/<slug> --url <app-url>` (add `--title "…"`). It
   prints one stdout line `{"port":N,"session":"<dir>"}`; grab `N`. Handle login/prep by
   sending `/js` BEFORE your first `/step` (those become `config.prep`).

   **Signed-in apps.** Pass a saved Playwright storage state: `spool live spool/<slug>
   --url <app-url> --auth path/to/auth.json` (or set `SPOOL_AUTH_STATE`). Never send cookie
   values through `/js`: those snippets are redacted out of the generated `steps.mjs`.
   Every session writes its own login state to `<dir>/auth.json`, which is gitignored and
   never shared or published, so the next take can reuse it with `--auth <dir>/auth.json`.
3. **Drive it in ONE continuous script.** Write the whole session as a single shell script and
   run it in ONE command — your thinking time between separate tool calls gets RECORDED as dead
   air in the take. Just drive, and drop a `/marker` where a new idea starts. Template:

   ```bash
   P=<port from step 2>
   J() { curl -s -X POST localhost:$P/$1 -H 'content-type: application/json' -d "$2" > /dev/null; }
   J js     '{"code":"await h.move(800,320); await h.pause(2200)"}'
   J marker '{"name":"the-action","narration":"What this click proves.","chapterId":"approach"}'
   J js     '{"code":"await h.click(\"#selector\"); await page.waitForSelector(\"#result\"); await h.pause(1500)"}'
   curl -s -X POST localhost:$P/end -H 'content-type: application/json' -d '{}'
   ```

   `chapterId` must be one of `context`, `outcome`, `approach`, `risks`, `decision`. Anything
   else is recorded as `context` and the reply carries a `warning`; the marker is kept either
   way, so narration is never lost to a typo. Read the responses: the session also prints every
   refused call to stderr.

   A marker names the boundary it lands on and can carry `narration` and `chapterId`. It does
   NOT bracket the work: the cut still comes from the signals (navigations, clicks that change
   the URL, network settle), and every marker survives that inference. Steps you never marked
   still appear, named after what opened them (`click-approve-payment`, `open-inbox`), and an
   un-narrated step simply plays at natural speed with no voice over it.

   `/step` still exists and still brackets the work explicitly. Use it when you want the
   boundaries to be exactly yours; if you send even one, inference is off for that take.

   Rules: narration is REQUIRED on `/step` (the renderer sizes the step window to it); `code` is
   the body of `async (page, h) => { … }`. Use `h.*` helpers for anything visible: `h.move(x, y)`
   takes two floats; `h.click`/`h.hover` take a selector string or `{x, y}`; also `h.type`/
   `h.scroll`/`h.pause`. Raw `page.*` is for waits. A failed `/js` returns `{ok:false}` and does NOT kill the session — fix and retry
   (it fails fast, but those seconds are recorded, so keep fumbles short). End each step
   settled, with ~2s of `h.pause` so the freeze-hold lands on a finished state. `GET /status`
   shows progress. Aim for 4–8 steps, one idea each.
4. **Finish.** `POST /end` → writes `video.webm` + `timeline.json` + `signals.jsonl` +
   `keyframes/` + a generated `steps.mjs`, and reports `inferred: true` when it derived the cut.
   Read the step list it prints before you render: that is the cut. If it is wrong, `spool recut`
   fixes it in one pass. Then `spool finish spool/<slug>` → `final.mp4` (or `spool build`, which detects
   the recorded session and finishes it). Finish/build **publish automatically** when the
   machine is connected (PR workdirs also comment on their PR); pass `--no-publish` to keep a
   take local, e.g. while you verify keyframes first. Note: fumbles you leave on screen are recorded; a
   failed `h.click` fails fast (5s locator timeout in live sessions) but those seconds still
   land in that step's window — retry promptly. The generated `steps.mjs` omits failed snippets, so
   re-running `spool build` on it gives a clean take.
5. **Verify + report** (same as below).

## Change the background without re-rendering

Every render writes `layers/fg.webm` beside `final.mp4`: the whole composite except the
wallpaper (card chrome, footage, cursor, ripples, zoom, captions, hook and CTA) in VP9 with
alpha. `spool bg` composites a new canvas under it in one pass and keeps the existing audio,
so changing the look costs seconds instead of a full render.

```bash
spool bg spool/<slug> graphite     # a repo preset: sky (default) | graphite | paper
spool bg spool/<slug> sonoma       # a macOS wallpaper by name (Mac only)
spool bg spool/<slug> ~/shot.jpg   # any image path
```

With no background given, a render on a Mac uses that machine's real Sonoma wallpaper, and
anywhere else the `sky` preset.

It rewrites `final.mp4` in place and restamps `render.json`. Keyframes and `preview.gif` come
from the recording, not the deliverable, so the share bundle needs no rebuild. A published
workdir needs `--publish` to put the new canvas online, and that mints a new watch link. Plan
Spools and `--rate` takes have no layer, so they still need `spool render`.

## Recut — fix a boundary without recording again

Capture stores one continuous take plus `signals.jsonl`, the log of what the session did on the
video clock. The cut is DERIVED from that log and lives in `timeline.json`, so changing it is a
number change: no browser, no capture, no re-encode. The video file is never even opened.

```bash
spool recut spool/<slug> --dry-run            # print the cut this would produce
spool recut spool/<slug> --trim-start 0@20.4  # drop 20.4s of dead air off the front
spool recut spool/<slug> --merge 2            # fold step 2 into step 1
spool recut spool/<slug> --split 1@8.5        # cut step 1 in two at 8.5s
spool recut spool/<slug> --drop 3             # remove a step; its footage never renders
spool recut spool/<slug> --name '0=open-the-ledger' --narrate '0=Here is the ledger.'
spool recut spool/<slug> --chapter 2=approach --min-step 4
```

Flags are repeatable and apply left to right, each naming a step by its index in the list as it
stands when that flag runs. `--dry-run` first is the cheap habit. The previous cut is kept as
`timeline.prev.json`. Narration is carried across by step NAME, so renumbering does not lose a
voice line; a step you split leaves its narration on the first half. Re-render with
`spool render spool/<slug>` (or `spool finish`, which re-voices only what changed).

This is why dead air is not a re-record. Your own thinking time between tool calls still lands in
the take — trim it here instead of driving the flow again.

`spool recut` works on scripted takes too: a scripted step boundary is written to the signal log
as a marker, so the same command re-derives it.

## Cloud render (`--cloud`)

`spool finish spool/<slug> --cloud` runs the voiceover, the render, the share bundle and the
publish on spoolkit.dev instead of this machine, then prints the watch link. Reach for it when
the box is slow or busy, or when the render toolchain is missing; the local path stays the
default. It needs a connected account (`spool login`) and a finished recording, and it always
publishes, so `--no-publish` is an error. The cloud render is the same job as the local one, on
the same house defaults, and it reads the format the session stamped into `steps.mjs`;
`spool render <dir> --cloud` runs it too. The upload is the take's video (tens of MB) and the
wait is a few minutes; afterwards
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
   `steps.mjs`, and every later command reads it from there. Add the rest of the short's
   furniture to that `config`, then `spool finish spool/<slug>`:

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

## Scripted path — escape hatch for CI-repeatable demos

Reach for this only when the same walkthrough has to replay identically on every run. It costs
the flow twice: a dry run to debug the driver, then the record run. For everything else the live
path is cheaper and the recut covers the mistakes this path avoids by construction.

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
- **If publish exits with a 402 upgrade message** (the free plan's published-spool limit — only
  live spools count, so drafts and failed renders are not the cause), relay that message and its
  upgrade link to the user verbatim rather than retrying the publish.

## Project init (spool init)

When you start using spool on a repo (or are asked to "set up spool for this project"), seed the
project's shared knowledge once so future guides and recordings start warm. This is what makes
later recordings instant: the next session reads the recording topics instead of re-deriving the
dev-server and auth story.

1. **Scaffold.** Bare `spool init` does this as its last step: it detects the repo owner/name via
   `gh`, fetches the current project store into `spool/project/knowledge.json` (read-only
   reference), and writes an empty seed ops file `spool/project/knowledge-ops.json`. Needs `gh` on
   PATH and `gh auth login`. Re-running `spool init` never overwrites ops you have authored.
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

`spool init <slug>` is a different command and is unchanged: it scaffolds
`spool/<slug>/steps.mjs` for the scripted path.

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

## Recaps (after you ship)

You do not record recaps. The `spoolkit` GitHub App does.

When a pull request MERGES on a repo with the App installed, the webhook queues a
`render_recap` job (`web/lib/recapEnqueue.ts`). The Fly worker (`worker/index.mjs`) fetches the
diff, authors and renders a vertical diagram video from it (`src/packet/`,
`docs/video/comp/skia/`), publishes it, and comments a poster frame plus the watch link on the
PR (`web/lib/githubComment.ts`). No browser, no capture, no agent in the loop. There is no
recap workflow in `.github/workflows/`.

So after a merge your only job is to READ the result:

- read the PR comment the App left, or
- run `spool list` and take the row for that PR.

The comment can take a few minutes: the worker polls, and the render is real work. If it never
arrives, check the App is installed on the repo and that the PR actually merged — a closed but
unmerged PR queues nothing. Do not hand-author a replacement recap workdir.

A hand-recorded vertical spool is still the right answer when somebody ASKS for a walkthrough
of a shipped change. That is the Live path above with `--format vertical`; see "Short-form
vertical spools" for the constraints.

## Plan Spools — proposing work before you build it

A Plan Spool asks a human for a decision instead of showing finished work. The video
explains the proposal, `plan.json` carries the semantics, and the decision comes back as
machine-readable status. You read that status before you write any code.

Reach for one when the work is worth a short proposal:

- **a risky change** — a migration, an auth or billing path, anything hard to undo;
- **an ambiguous request** — two credible readings, and picking one for the human is a guess;
- **a handoff** — another agent, or a later session, has to act on your reasoning;
- **any time `spool gate check` blocks you**: the gate is saying this project wants a
  decision before this work starts.

Four worked examples — the prompt, the full command sequence, and where you stop — are in
[PLAN-EXAMPLES.md](PLAN-EXAMPLES.md): new feature, risky change, ambiguous request, agent
handoff. Read the one that matches before your first plan.

### 1. Ask the gate before you start

`spool gate check` answers one question: may this work start? Ask it BEFORE you write code,
and declare the files you are about to touch — they do not exist yet, so the gate cannot
find them on its own:

```bash
spool gate check --paths web/db/migrations/0021_dismissals.sql --command "npm run db:migrate" --json
```

Exit codes are the contract: **0 may proceed, 1 blocked, 2 the check could not run.** A
blocked run prints the policy and where it came from, the plan it read, the reason, and the
watch link to get a decision. `spool gate policy` prints what is in force here and why.
`spool gate run -- <command>` is the same check with the command attached, so a blocked
command never runs.

`--bypass --reason "…"` is the only way past a policy, and every use is recorded — in
`.spool/audit.jsonl` and on the plan itself. It is the human's call, never yours. Ask, quote
the reason they give, and never invent one.

### 2. Write the packet

`spool plan init <slug> --goal "…" --task <url-or-id>` writes `spool/<slug>/plan.json` plus
`evidence.json`, and fills `links.repo`, `links.branch` and `links.commit` from the
checkout. Then replace every `TODO:` line. What the validator holds you to:

- Required: `goal`, `outcome`, `approach` (1 to 24 steps, kebab-case unique ids), `risks`,
  `decision.prompt`, `links`.
- **Absent alternatives are a statement, not a silence.** With no `alternatives` you must
  write `noAlternativesReason`. "No credible alternative: the schema is fixed by the
  existing contract" is an answer; a blank line is not.
- **Decision options are actionable**: `approve`, `redirect`, `ask-question`, `needs-input`,
  or `alternative:<id>` naming an alternative you declared. An `approval` decision must
  offer `approve`; a `selection` decision must offer at least one `alternative:<id>`. Use
  `selection` when the human is choosing between approaches, not approving one.
- **Evidence is referenced, never pasted.** A descriptor is `{id, kind, label, ref}` with
  `kind` in `file | url | image | test | commit | console`. `ref` is a repo-relative path, an
  absolute `http(s)` URL, a 7 to 40 character SHA, or the single-line command that produced
  the output. Pin a file with `revision` (or `links.commit`) so the reviewer opens what you
  read. A source a stranger cannot open gets `"visibility": "private"`: the label ships, the
  ref does not.
- **`approach[].id` is an anchor.** Questions, replies and revision deltas point at it, so
  keep it stable across revisions.

**Do not retype the proof — collect it.** You already changed files, ran a test and
recorded the browser:

```bash
spool plan evidence spool/<slug>                          # diff, commit, console, keyframes
spool plan evidence spool/<slug> --test "npm test"        # exit status, duration, output tail
spool plan evidence spool/<slug> --base main              # what the pull request shows
```

Every collector runs on every call, and each one skips itself when its source is absent, so a
bare run is the normal run. Then cite the ids it prints from the claims they support:
`"evidence": ["ev-test-npm-test"]` on an outcome, an approach step or a risk. Collecting evidence and citing none of it now
warns (`uncited-evidence`), and `spool plan validate --strict` turns that warning into an
error, so one citation is the minimum. Each descriptor gets a plain-language `summary`
the reviewer reads first, and the raw diff or output sits behind "Show source". Everything
is redacted and size-capped on the way in, so a credential in real command output never
reaches the packet — but the caps are real: the command prints anything it refused to
attach, and "12 of 300 files" is what you must claim if that is what it says.

### 3. Validate before anything costs time

```bash
spool plan validate spool/<slug> --strict      # 0 valid, 1 invalid, 2 not a plan workdir
```

An unedited `TODO:` is a warning, and `--strict` turns warnings into errors, so a strict run
is what stops you shipping a template. `--json` gives one diagnostic per field path. The
same validator runs again at `spool share` and at the server, so an invalid packet never
costs a recording or a voiceover.

### 4. Generate the narration

```bash
spool plan generate spool/<slug> --steps --url http://localhost:3000/coach
```

This writes `plan.script.json`: one chapter per plan chapter, its narration, the visual it
shows, and the decision card. It copies **your** sentences verbatim and only adds fixed
lead-ins that carry no facts, so every claim traces to a packet field; a claim that traces
to nothing fails as an `invented-source` error. `--steps` also writes the `steps.mjs` that
records it. When the wording is wrong, fix `plan.json` and regenerate — generation is
deterministic, so the same packet always gives the same script.

### 5. Record the five chapters

context, outcome, approach, risks, decision — in order, 45 to 120 seconds. Show the thing
you are talking about (the file, the page, the failing test); a card-only take is fine where
no live surface exists.

**Tag every step with its chapter**: `chapterId: "approach"` in `steps.mjs`, or
`POST /step {name, narration, chapterId}` live. `chapterId` is the only anchor between the
plan and the video, and it is what lets a reviewer click part of the plan and jump to the
moment you explained it. One chapter may span several steps; an unknown id is rejected.
`spool plan generate --steps` writes the tags for you.

### 6. Build, publish, then stop

```bash
spool plan build spool/<slug>
```

It validates, then runs the ordinary build and publish. The workdir's `plan.json` makes it a
plan spool (`kind: "plan"`), and publish opens revision 1 awaiting a decision. `--cloud` is
refused on a plan workdir: the cloud worker never sees the packet.

**Then stop.** Do not start implementing while the plan is `awaiting_decision`. Report the
watch link and hand the decision to the human.

### 7. Point the pull request at the plan

If the work has a pull request, put the plan on it, so a reviewer arriving at the diff finds
the proposal instead of hunting for a link:

```bash
spool plan pr spool/<slug>                     # or --pr <number|url> to name it
```

It renders one compact comment — status, goal, the decision it asks for, the source
revision, the staleness verdict, the watch link — and refreshes that same comment in place
on every later run. It also writes the pull request into `links.pr` the first time.

Two rules to know before you run it:

- **The repository must opt in.** Without `{"github": {"comment": true}}` in
  `spool.config.json`, the command prints the comment and posts nothing. That is the
  configured answer, not a failure: do not work around it.
- **It never fails anything.** A rate limit or an outage is reported on stderr and the
  command still exits 0. `--dry-run` shows the comment without posting.

### 8. Check the plan is still about this code

Before you act on an approved plan — and especially when you pick up somebody else's — ask
whether the branch has moved past the code the plan reasoned about:

```bash
spool plan stale spool/<slug> --json           # 0 current, 1 stale, 2 unknown
```

Stale means one of four things: the plan's commit is no longer in the branch's history, a
file the packet cites has changed, the branch has moved further than the project's
tolerance, or the plan is older than it. **Unknown is not current** — it means the packet
pins no commit, or this clone cannot see it.

A stale plan is not a blocked one, but it is a plan you must not silently implement: re-read
the changed code, and revise the packet (step 10) when the proposal no longer matches it.

### 9. Read the decision back

```bash
spool read spool/<slug> --plan --json          # or a watch URL, or a bare spool id
```

One call carries the whole answer:

- **`status`** — `published`, `awaiting_decision`, `approved`, `redirected`, `needs_input`,
  `revised`, `implementing`, `proved`, `draft` (never published), or `unknown` (the host
  was unreachable).
- **`decision.type`** — `approved_with_notes` unblocks the work AND carries a caveat you
  must honour. Read `decision.notes` and follow it.
- **`nextAction`** — the one thing this reader may do next, with the endpoint that does it.
  Act on this, not on your own reading of `status`.
- **`may`** — every other call you are allowed to make.
- **`changeSummary` / `changes`** — what moved since the revision you last read, so you
  never diff two packets or rewatch to find out.
- **`openQuestions`** — each with the `replyTo` that answers it.

`--offline` answers from the local bundle and never contacts a host. `--transcript` adds the
narration; the default leaves it out, because you already hold the plan in structured form.

**`unknown` is not an approval, and neither is `draft`.** Both come back with a `nextAction`
that refuses implementation. Treat them as a stop.

### 10. Revise when you are redirected

Revision is lineage, not overwrite. `redirected` or `needs_input` sends the plan back to
you: read `decision.notes`, edit the packet, and publish revision N+1. Revision N stays
readable, and the plan keeps one watch link.

A change to `goal`, `outcome`, `approach`, `risks`, `decision`, or to an alternative you
offered as an option, is **material**: it changes what the video argues, so it needs a new
recording. Everything else — current-state facts, assumptions, evidence descriptors, links —
is a correction and keeps the recording. Publishing a material change against the old
recording is refused with `reason: "recording_required"`, naming the fields.

### 11. Reply: answer, status, proof

A reply is a child spool that addresses ONE moment of a plan, so an answer lands where the
question was asked instead of arriving as a second, unrelated link:

```bash
spool reply <watch-url> --questions                     # pick a live question id
spool reply <watch-url> --kind answer --question <question-id> \
  --summary "It takes a brief lock; here it is against a copy."
spool live spool/answer-<parent-id-8>
spool publish spool/answer-<parent-id-8>
```

The workdir is always `spool/<kind>-<first 8 characters of the parent id>`, and the command
prints the path it wrote; `--dir <path>` puts it somewhere else.

`--kind` is `answer` (any discussable state), `revision` (`redirected`, `needs_input`,
`revised`) or `proof` (`approved`, `implementing`, `proved`). A status has its own command
(below), because it carries a verdict `spool reply` has no flags for. Anchor a reply with
`--question`, `--chapter`, `--approach`, `--evidence` or `--range`; a question anchor opens
on the moment that question was asked. `spool reply` reads the parent first and refuses a
reply the parent cannot take, so you find out before you record, not after.

**Status says where the work is.** Record one only at a material milestone, at a blocker,
or when the work needs a new decision — never per commit, and never as a habit:

```bash
spool status <watch-url> --verdict on_plan --done <approach-id> --next "Wire the API."
spool status <watch-url> --verdict blocked --blocked "Staging is down." --next "Ask ops."
spool status <watch-url> --verdict changed --no-plan-holds --reason decision \
  --changed "The queue has to move to the worker."
```

`--verdict` is the first thing the reviewer reads: `on_plan`, `changed` or `blocked`. Add
`--no-plan-holds` when the approved plan no longer stands, and say what changed. `--reason`
is `milestone`, `blocker` or `decision` (it defaults from the verdict). The command
scaffolds `reply.json` AND a `steps.mjs` whose narration is already ordered verdict → done
→ changed or blocked → next; edit the driver, then `spool live` and `spool publish` it.

A status cannot contradict itself, and the CLI refuses it before you record: on-plan while
the plan no longer holds, a change nobody described, a blocked report with nothing blocking
it, a milestone that finished no approach step.

**Proof closes the loop, and a proof enumerates.** When approved work runs, record it
against the plan that approved it — and say, item by item, what it verified:

```bash
# everything shipped as proposed
spool reply <watch-url> --kind proof --verifies all \
  --summary "The dismissal survives a re-login."

# something differed — say which item, and state the deviation
spool reply <watch-url> --kind proof \
  --verifies outcome --verifies data \
  --verifies ui:partial="the empty state is unstyled" \
  --deviation approach:ui="The empty state ships in a follow-up." \
  --summary "The dismissal survives a re-login."
```

Then record and publish that workdir. It publishes as a proof spool linked to the approved
revision, and a plan that is `implementing` moves to `proved`.

- `--verifies` takes `all`, `outcome`, or `<approachId>[:verified|partial|unmet][=note]`,
  and is repeatable. **Every approach step of the plan needs a verdict** — a step you leave
  out is refused, because on the reviewer's card silence reads like a pass.
- **Any verdict that is not `verified` needs a `--deviation`** naming it
  (`outcome=…`, `plan=…`, or `approach:<id>=…`). Never bury a deviation in the narration:
  the card shows the fields, and a reviewer who skims sees exactly what differed.
- `--mode evidence` for low-visibility infrastructure work, where the evidence carries the
  claim and there is no walkthrough worth watching. Default is `video`.
- A proof of a plan nobody approved, or of a revision that has been replaced, is refused.
  If it is genuinely right, say so out loud: `--override unapproved` or
  `--override superseded`, with `--override-reason "<why>"`. The reason is shown to the
  reviewer beside the proof — an override is never silent.

Name the items you actually proved. A proof that claims something else is exactly what this
chain exists to make visible.

### Narration rubric for plans

The [narration style](#narration-style) rules all still hold. Three more apply to a plan,
and they outrank the rest:

- **Proposal language, always.** "We'd add a dismissal record", "this would run in one
  statement". Never "we added", never "here's the new panel". The work does not exist yet.
- **Never say what the packet does not.** Every sentence traces to a packet field. If you
  want it in the video, put it in `plan.json` first.
- **The decision chapter asks for one thing.** Name the exact action the reviewer takes and
  what each option means. Never end on a summary.

The generator and `spool lint` enforce the mechanics: `context`, `approach`, `risks` and
`decision` always present, 3 to 6 chapters, 45 to 120 seconds, 8 to 60 words per chapter, no
em dashes.

### Refusal rules

Stop and hand back to the human when:

- **`spool gate check` blocks** and no approved plan exists. Write the plan; do not bypass.
- **The plan is `awaiting_decision`, `redirected`, `needs_input` or `revised`.** No
  implementation, and no partial start "while we wait".
- **`spool read --plan` reports `unknown` or `draft`.** An unreachable host is not an
  approval, and an unpublished packet was never seen.
- **`spool plan stale` reports `stale` on a plan you were about to implement.** The
  approval was for the code as it was. Re-read what changed and say what it means for the
  plan; revise the packet when the proposal no longer matches the branch.
- **The request has two credible readings.** Offer them as `alternatives` under a
  `selection` decision and let the human choose. Choosing one yourself and noting it is not
  a decision.
- **A packet field needs a fact you do not have** — the real risk, the real task link, why
  no alternative was credible. Ask for it; never write a plausible sentence instead.
- **Only a human can authorise it**: a bypass, a production action, a spend, a credential.

When a plan is open, the deliverable is the watch link plus the exact thing you need. It is
never a half-built branch.

### When a command fails

Every record, render, publish and plan read is journalled locally. Ask the journal what
broke before you guess:

```bash
spool reliability             # what failed, why, and the runbook that recovers it
spool reliability --json      # the same report, machine-readable
```

The report names one runbook per failure point; the steps are in
`docs/PLAN-SPOOLS-RUNBOOKS.md`. Two rules matter more than the rest:

- **A failed publish is resumed, never restarted.** Re-run `spool publish <workdir>`: the
  completing call is idempotent, so it finishes the publish instead of duplicating it.
- **A failed read is never an approval.** `spool read --plan` retries, then falls back to
  the local bundle with `status: unknown`. Treat that as a refusal, not as a green light.

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
