# spool

**Agents record their own spools.** After an agent builds a feature, it drives the app in a
real browser, records a real continuous video (not screenshot stitching), narrates it with
AI voice, and renders a designed, captioned MP4 — no human ever hits record. Think of the
narrated walkthroughs you'd make with screen-recording products like Loom, except the agent
is the producer.

Inspired by [BuilderIO/agent-native](https://github.com/BuilderIO/agent-native)'s Clips,
inverted: there a human records and the agent watches; here the agent is the producer.

Recaps are the exception, and nothing records them. When a PR merges on a repo with the
`spoolkit` GitHub App installed, the webhook queues a `render_recap` job and the worker renders
a vertical diagram video straight from the diff, then comments the watch link on the PR.

## Install

```bash
npm i -g @spoolkit/cli
npx playwright install chromium
```

You also need `ffmpeg` on PATH (macOS: `brew install ffmpeg`) and node >= 20. Run `spool doctor`
anytime to check your environment and get fix hints for anything missing.

`0.4.0` is the first npm release since `0.3.1`, and it ships the current CLI. The repo is
[aaarnv/spool](https://github.com/aaarnv/spool).

To work on spool itself, install from a clone instead:

```bash
git clone git@github.com:aaarnv/spool.git && cd spool
npm install && npm link
npx playwright install chromium
```

### Preferences

`spool setup` writes first-class defaults to `~/.spool.json` (alongside `host`/`token`):

```bash
spool setup                                   # interactive on a TTY
spool setup --browser chrome --engine hosted --yes   # non-interactive
spool setup --show                            # print effective config (token masked)
```

| Key | Values | Default | Effect |
| --- | --- | --- | --- |
| `browser` | `chromium` \| `chrome` \| `edge` | `chromium` | recording browser (Playwright channel) |
| `target` | `browser` \| `os` | `browser` | default `spool live` capture target |
| `engine` | `auto` \| `openai` \| `hosted` \| `local` | `auto` | default VO engine |

Precedence is explicit flag > env (`SPOOL_BROWSER`/`SPOOL_TARGET`/`SPOOL_ENGINE`) > prefs >
default. `spool doctor` reports the active profile and its sources. Everything else the
renderer decides for itself — see [Defaults](#defaults).

## First run

Bare `spool init` is the whole setup, on this machine and on this repo. Run it once from
inside the project you want to record:

```bash
cd <your-project>
spool init
```

It walks six steps, prints one line each, and skips any step that is already satisfied:

1. **Environment** runs the `spool doctor` checks. A missing node, ffmpeg, or chromium stops
   the run and prints that check's fix. A missing OpenAI key is only a warning: hosted voice
   covers it.
2. **Login** starts the browser device flow when `~/.spool.json` has no token. Add `--paste`
   to type an `spk_` token instead. Off a terminal it prints the command to run and stops.
   `--no-login` skips this step for CI.
3. **Preferences** writes the defaults in [Preferences](#preferences) when you have never set
   one, then prints the effective config.
4. **Repository** reads the GitHub owner and name with `gh`. Outside a repo, steps 5 and 6 are
   skipped.
5. **GitHub App** prints the install link. Installing it is what turns a merged pull request
   into a recap.
6. **Knowledge** scaffolds `spool/project/`, where you author what this repo is so later
   recordings start warm. Nothing is sent until you run `spool init --apply`.

`spool init <slug>` is unrelated and unchanged: it scaffolds `spool/<slug>/steps.mjs` for the
scripted path.

## How it works

```
steps.mjs (agent-authored demo script)
   │
   ├── spool vo      →  vo/seg_NN.wav + word timestamps   OpenAI gpt-4o-mini-tts + whisper-1
   │   (in parallel)                                      (bounded concurrency pool)
   └── spool record  →  video.webm + timeline.json        Playwright recordVideo, fake cursor,
   │                                                       human-speed motion, natural timing
spool render  →  final.mp4                                ffmpeg: retime each step to fit its
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

**Live (OS target)** — capture the whole macOS desktop instead of a browser tab, for demos
that leave the browser (native apps, the terminal, multiple windows). Same control protocol,
no `page` driver — you drive the desktop yourself (osascript/cliclick/your own tools) between
steps and use `/sh` to run terminal-visible commands:

```bash
spool live spool/my-demo --target os --title "…"   # ffmpeg avfoundation full-display capture
curl -sX POST 127.0.0.1:$PORT/step -d '{"name":"open","narration":"…","zoom":"none"}'
# … drive the desktop out-of-band, then optionally log terminal commands …
curl -sX POST 127.0.0.1:$PORT/sh   -d '{"cmd":"ls src/record"}'   # returns + logs stdout/exit
curl -sX POST 127.0.0.1:$PORT/end                                  # capture.mp4 + timeline.json + steps.os.md
spool finish spool/my-demo
```

Arrange your desktop first (hide unrelated windows, bring the app you're demoing to the
front — the capture is the whole display). `zoom` defaults to `"none"` on the OS target;
pass `{"x":…,"y":…}` (capture-pixel coords) to zoom toward a point. **Screen Recording
permission** is required: if capture comes back black, spool fails fast telling you to grant
it to your terminal in System Settings → Privacy & Security → Screen Recording, then restart
the terminal. The first "Capture screen" device is the one recorded.

**Scripted** — reproducible; author the driver up front:

```bash
spool init my-feature                  # scaffolds spool/my-feature/steps.mjs
# author the steps: N steps × { name, narration, zoom, run(page, h) }
spool dry spool/my-feature             # debug the driver cheaply in a visible browser
spool build spool/my-feature           # (vo ‖ record) → render → share → final.mp4 + share/
spool publish spool/my-feature         # → https://<host>/l/<id> — one link, click to watch
spool publish spool/my-feature --pr    # …and comment the link on the branch's GitHub PR
```

(`spool build` on a live/recorded session skips recording and finishes it, so `build` works
for both paths.)

**Plan Spools** — a proposal a human watches and an agent reads. The workdir carries a
`plan.json` packet beside the media, so the summary on the watch page and the packet an
agent acts on cannot drift:

```bash
spool plan init my-feature --goal "..." --task SPL-14   # scaffolds plan.json + evidence.json
spool plan validate spool/my-feature                    # terse report; --json for diagnostics
spool plan build spool/my-feature                       # validate, then the build above
```

`spool plan validate` exits `0` when the packet is valid, `1` when it is invalid, and `2`
when the workdir carries no plan. An invalid plan never costs a recording or a voiceover
run. See [CONTRACTS.md](./CONTRACTS.md) → "Plan Spools".

**The implementation gate** — how much approval an agent needs before it builds. Set the
policy in `spool.config.json` (`off`, `advisory`, `high_risk_required`, `required`); with
no config a project is `advisory`:

```bash
spool gate policy                     # what is in force here, and why
spool gate check --command "npm run migrate"   # exit 0 allowed, 1 blocked, 2 could not run
spool gate run -- npm run migrate     # check, then run it (blocked: it never runs)
spool gate status --pr                # publish the verdict as a GitHub commit status
```

A blocked run names the command, the policy and the plan, and links the plan to get a
decision on. Work that starts without an approved plan is recorded either way — under
`advisory` too — in `.spool/audit.jsonl` and on the plan. `--bypass --reason "..."` is the
one way past a policy, and it says so in the log. See
[CONTRACTS.md](./CONTRACTS.md) → "Implementation gate".

**On a pull request** — one comment carries the plan, and one check says whether the plan
is still about this code:

```bash
spool plan pr spool/my-feature        # post/refresh the compact plan comment on the PR
spool plan stale spool/my-feature     # exit 0 current, 1 stale, 2 unknown
```

The comment names the status, the decision, the source revision and the watch link, and
every later run rewrites that same comment instead of posting another. It is **opt-in per
repository** — add `{"github": {"comment": true}}` to `spool.config.json` — and no GitHub
failure can fail a build. A plan reads stale when its branch moved past the commit it was
written against, when a file it cites changed, or when it simply got old; the tolerance is
`github.stale` in the same file. See [CONTRACTS.md](./CONTRACTS.md) → "GitHub integration".

`spool publish` uploads the video + share bundle to the hosted watch app (spoolkit.dev,
developed in a separate repo, deployable to Vercel + Blob) and returns a single unlisted, unguessable link —
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
- **local (free)** — a `SPOOL_VO_SH` script for local TTS/whisper.

They are tried in that order. Pin one with `spool setup --engine openai|hosted|local`, or
`SPOOL_ENGINE` for a single run.

Setup: `npm install && npm link` in this repo (chromium comes from Playwright's cache,
`npx playwright install chromium` if missing).

## Use it from any agent

`skills/spool/SKILL.md` is an [agent skill](https://agentskills.io) teaching any
skill-aware agent (Claude Code, Codex, etc.) the full workflow — live driving, OS capture,
narration voice rules, verification, PR comments. Copy it out of this repo into your agent's
skills directory (`~/.claude/skills/spool/` or `~/.codex/skills/spool/`). It is not part of
the npm package, so it needs repo access.

## GitHub Action

The root `action.yml` is the composite setup action this repo's own workflows use through
`uses: ./`: it installs the CLI, ffmpeg and headless chromium on a runner and writes
`~/.spool.json` from the `token` input (store your spk_ token as a repo secret).

This repo is private, so it serves that action to nobody else. Workflows in other repos use
the public shim in [`public-action/`](./public-action), which installs `@spoolkit/cli` from
npm rather than cloning anything, and which can instead notify the platform and install
nothing at all. [docs/PUBLISH-PUBLIC-ACTION.md](./docs/PUBLISH-PUBLIC-ACTION.md) is how it
gets pushed out as `spoolkit/action`; until that happens, the `uses:` line below resolves
for nobody.

```yaml
- uses: spoolkit/action@v1
  with:
    token: ${{ secrets.SPOOL_TOKEN }}
```

[docs/examples/pr-guide.yml](./docs/examples/pr-guide.yml) is a copy-paste workflow that
pairs it with `anthropics/claude-code-action` to author and publish a narrated PR guide on
every opened pull request (`spool pr`, tour + explainer authoring, headless record,
`spool publish --pr`).

## Defaults

Spool has one way to make a video, and it is the good one. There is no `--hq` and no `--rate`,
and no render flag picks a background: every knob below is decided for you, and every one of
them was a flag somebody had to get right before. (Changing the canvas after the fact is its
own command, `spool bg`, because it costs seconds instead of a render.)

| What | House default | Why it is not a flag |
| --- | --- | --- |
| Frame rate | 60fps | The renderer retimes to the narration either way; 30 only ever looked worse. |
| Encode | hardware H264 for a `--preview` draft, libx264 `-preset slow -crf 17` for every `final.mp4` | The tier follows the purpose: a draft nobody publishes, or a master that gets published. |
| Format | `wide` for walkthroughs, `vertical` for packet videos | Stamped into the session at capture by `spool live --format`, then read from the workdir by everything downstream. |
| Background | the machine's real Sonoma wallpaper on a Mac, else the `sky` preset; packet videos get an ambient clip hashed from the packet | The video sits on the desktop it was recorded on, and nobody picks a wallpaper per video. |
| Narration | house voice, tempo 1.0, engine auto-detected (your key → hosted → local) | One voice is the product's voice. The engine is whichever one this machine can actually reach. |
| Plan narration | rewritten by `gpt-5`, falling back to the deterministic script | The fallback is silent and always correct, so there was never a reason to opt in. |
| Plan theme | `warm-briefing` | The founder picked it (SPL-DECISIONS #17). |
| Evidence | every collector runs (diff, commit, console, keyframes) | Each one skips itself when its source is absent, so choosing between them was work with no answer. |
| Publish | `spool build`/`finish` publish when they finish | A spool nobody can watch is not finished. `--no-publish` is the one exception, for verification runs. |
| Gate audit | every `spool gate` run is recorded to `.spool/audit.jsonl` | An unaudited run is indistinguishable from one that never happened. |

### Escape hatches

Environment variables, for recovery and debugging. None of them belong in a script you
commit.

| Variable | Effect |
| --- | --- |
| `SPOOL_HOST`, `SPOOL_TOKEN` / `SPOOL_PUBLISH_TOKEN` | Where to publish and as whom. Auth, not a knob — also settable via `spool login` and `spool setup --host`. |
| `SPOOL_RENDER_FPS` | Render at another frame rate. `30` roughly halves render time when you are iterating. |
| `SPOOL_RENDER_CONCURRENCY` | Cap parallel ffmpeg work. The GitHub Action sets it. |
| `SPOOL_BG` | Override the canvas for one local render (preset name, macOS wallpaper name, or an image path). |
| `SPOOL_FORMAT` | Force `wide` or `vertical` when a workdir has no stamp of its own. |
| `SPOOL_ENGINE`, `SPOOL_VO_SH` | Pin the VO engine; point at a local TTS/whisper script. |
| `SPOOL_PLAN_VOICE`, `SPOOL_PLAN_VISUALS`, `SPOOL_PLAN_MODEL` | The plan narration profile and the model that rewrites it. |
| `SPOOL_BROWSER`, `SPOOL_TARGET` | Playwright channel and capture target for one run (`spool setup` is the durable form). |
| `SPOOL_V0_ENGINE` | Fall back to the Chrome rasteriser when Skia misbehaves. |
| `SPOOL_SKIA_WORKERS` | Cap packet-render stripe workers when the machine's memory is smaller than its core count suggests. |
| `SPOOL_MCP_NOTIFY`, `SPOOL_MCP_WAKE_CMD`, `SPOOL_MCP_HOME` | `spool mcp watch`: notify on wake, what to run per event, where the cursor lives. |
| `SPOOL_PILOT_ROOTS` | Colon-separated workdir roots, to collect one pilot dataset across several worktrees. |
| `SPOOL_RELIABILITY=off` | Stop journalling attempts (tests that fail on purpose). |
| `SPOOL_PR_COMMENT_VIA_APP=0` | Platform-side setting: hand the PR comment back to the publisher's `gh`. The GitHub App writes it by default ([docs/GITHUB-APP.md](./docs/GITHUB-APP.md) §5). |

## The steps contract

See [CONTRACTS.md](./CONTRACTS.md) for the full data contracts (steps.mjs shape,
timeline.json, vo/manifest.json). The only file an agent authors per spool is `steps.mjs`;
everything else is generated.

## Editing a published spool

Publishing now also uploads the render sources (normalized `video.mp4`, `timeline.json`,
`render.json`, and the `vo/` segments) alongside the final video, so a spool can be edited
after the fact without re-recording. On the watch page the owner describes a change in
plain language ("drop the third step", "re-record the intro narration", "speed it up 1.25x");
that becomes a validated ops list and an `edit_jobs` row. A small always-on render worker
(closed source, part of the hosted service) polls for jobs, pulls the sources, applies the
ops — re-generating only changed narration segments via the same OpenAI TTS path — re-renders
with the repo's own `renderSpool`, and overwrites the published video/bundle in Blob. Spools
published before this feature (no sources) show as re-publish-to-edit. Full shapes:
[docs/EDIT-CONTRACT.md](./docs/EDIT-CONTRACT.md).

## Design notes

- **Capture is an adapter.** `--target browser` (default) = Playwright `recordVideo` (CDP
  screencast → WebM, ~25fps, headless, zero OS permissions). `--target os` = macOS
  full-display `ffmpeg avfoundation` capture (real cursor, 30fps CFR H264, long edge capped
  at 2560), which needs Screen Recording permission. Both emit the same timeline/render
  contract; the OS target adds `target:"os"` + `capture.mp4` and drops the `page` driver.
- **Render is one ffmpeg filtergraph, with the design rasterised by a browser.** The
  recording is composited onto a rounded card with gentle zooms toward logged click
  coordinates (Screen-Studio style). Every static layer — card chrome, caption pills,
  plan cards, hook/CTA — is screenshotted once by Playwright from the product's own CSS,
  so captions stay designed type rather than burned SRT, while ffmpeg does the per-frame
  compositing. The WebM → CFR H264 pass exists because VFR VP8 seeks badly.
- **The canvas is house-picked.** The background behind the card is this machine's real Sonoma
  wallpaper on a Mac, and the `sky` preset everywhere else (`src/render/bg-resolve.mjs`); packet
  videos get an ambient clip chosen deterministically from the packet, so the same plan always
  looks the same. A rendered spool is re-skinned in seconds with `spool bg <workdir> <bg>`, which
  composites a new canvas under the saved `layers/fg.webm`; published spools can also be re-skinned
  from the web editor via the `set_bg` op (repo presets only), and `SPOOL_BG` overrides one local
  render.
- **Dry-run first (scripted path).** `spool dry` drives the steps in a visible browser with
  no VO or video, so the agent can fix selectors/timing before spending TTS calls and render
  minutes. The live path
  skips this — you drive once and fix fumbles inline (a failed `/js` doesn't kill the take).
- **Live is record-derived.** `spool live` inverts authoring: instead of writing a driver and
  debugging it, the agent drives the real app once over an HTTP control port and the steps are
  derived from the session, then emitted as a reproducible `steps.mjs` snapshot.

## License

Spool is open core. The CLI, the agent skill, the MCP server, the render pipeline and the
GitHub Action are in this repository under the [Functional Source
License](LICENSE), version 1.1 with an Apache 2.0 future license (`FSL-1.1-Apache-2.0`,
which upstream now names `FSL-1.1-ALv2`).

Use it for anything except a Competing Use: shipping it as a commercial product or service
that substitutes for Spool or for spoolkit.dev. Internal use, non-commercial education,
non-commercial research and professional services all count as Permitted Purposes. Every
version converts to Apache 2.0 two years after it ships.

The hosted app on spoolkit.dev — the feed, the GitHub App, the render worker and billing —
is closed source and stays in a private repository.

Earlier releases are unaffected: `@spoolkit/cli` up to 0.3.1 on npm remains MIT.

The two bundled music beds in `assets/` are CC0 from FreePD.com ("Arpent" and "Wisdom in
the Sun" by Kevin MacLeod), trimmed and gain-matched. CC0 waives attribution; this note is
provenance only.
