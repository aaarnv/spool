import { sans, serif } from "../components/marketing/fonts";
import ShaderBackground from "../components/marketing/ShaderBackground";
import { SpoolMark } from "../components/marketing/icons";
import "../components/marketing/landing.css";
import "./docs.css";
import type { Metadata } from "next";

const GITHUB = "https://github.com/aaarnv/spool";
const SIGNUP = "/sign-up";

export const metadata: Metadata = {
  title: "Docs · spool",
  description:
    "Install, configure, and drive spool: how agents record narrated walkthroughs and PR guides, the full CLI reference, and the machine-readable surfaces built for agents.",
};

const NAV = [
  {
    label: "Get started",
    links: [
      { href: "#install", text: "Install" },
      { href: "#setup", text: "Setup" },
    ],
  },
  {
    label: "Record",
    links: [
      { href: "#record", text: "Record a walkthrough" },
      { href: "#pr-guides", text: "PR guides" },
      { href: "#projects", text: "Projects" },
    ],
  },
  {
    label: "Reference",
    links: [
      { href: "#cli", text: "CLI reference" },
      { href: "#agents", text: "For agents" },
      { href: "#pricing", text: "Pricing & self-host" },
    ],
  },
];

const COMMANDS: [string, React.ReactNode][] = [
  ["spool init [slug]", "With a slug, scaffold spool/<slug>/steps.mjs. Bare, seed this repo's shared project knowledge (--apply writes it)."],
  ["spool live <dir>", <>Drive the app once over an HTTP control server and derive the steps. <code>--url</code>, <code>--title</code>, <code>--target browser|os</code>, <code>--headed</code>.</>],
  ["spool record <dir>", <>Record a scripted <code>steps.mjs</code> at natural speed. <code>--headed</code>.</>],
  ["spool dry <dir>", <>Drive the steps with no VO or video to debug selectors and timing. <code>--headed</code>.</>],
  ["spool build <dir>", <>End to end: (vo &#8214; record) then render then share. Detects a live/recorded session and finishes it. <code>--engine</code>, <code>--voice</code>, <code>--speed</code>, <code>--rate</code>, <code>--bg</code>, <code>--headed</code>.</>],
  ["spool finish <dir>", <>vo then render then share on an existing session, no re-record. <code>--engine</code>, <code>--voice</code>, <code>--speed</code>, <code>--rate</code>, <code>--bg</code>, <code>--preview</code>.</>],
  ["spool render <dir>", <>Normalize and Remotion-render the final mp4. <code>--rate</code>, <code>--bg</code>, <code>--preview</code> (fast half-scale draft).</>],
  ["spool vo <dir>", <>Generate voiceover segments and word timestamps. <code>--engine</code>, <code>--voice</code>, <code>--speed</code>.</>],
  ["spool share <dir>", "Write the agent-consumable share/ bundle (spool.json, transcript, keyframes, console log)."],
  ["spool read <dir>", "Print an agent-oriented digest of a spool (accepts a workdir or its share/ dir)."],
  ["spool publish <dir>", <>Upload the spool and get one watch link. Pre-lints and blocks on errors. <code>--pr [n]</code> comments the link on the PR, <code>--host</code>, <code>--token</code>, <code>--force</code>.</>],
  ["spool pr <n|url>", "Scaffold a PR guide workdir (fetches PR metadata and diff via gh)."],
  ["spool lint [dir]", <>Fast static checks on a workdir (steps, timeline, tour, vo), no browser. <code>--json</code>.</>],
  ["spool doctor", <>Check the environment (deps, config, host, token) with actionable fixes. <code>--json</code>.</>],
  ["spool open [dir]", "Open the published watch link, or the dashboard when there is none."],
  ["spool backgrounds", "List the render backgrounds: repo presets plus this machine's macOS wallpapers."],
];

export default function Docs() {
  return (
    <>
      <ShaderBackground />
      <div className={`spool-landing spool-docs ${sans.variable} ${serif.variable}`}>
        <nav className="spool-nav">
          <a className="spool-nav__brand" href="/">
            <SpoolMark />
            Spool
          </a>
          <span className="spool-nav__links">
            <a href="/#features">Features</a>
            <a href={GITHUB}>Open source</a>
            <a href="/#pricing">Pricing</a>
            <a href="/docs">Docs</a>
          </span>
          <a className="spool-nav__cta" href={SIGNUP}>
            Publish a spool
          </a>
        </nav>

        <header className="spool-docs__masthead">
          <span className="spool-docs__eyebrow">Documentation</span>
          <h1 className="spool-docs__title">Ship the walkthrough with the code</h1>
          <p className="spool-docs__lede">
            Spool is a CLI your coding agent drives. It records a real browser walkthrough of
            what it just built, narrates it, and publishes one link that both people and agents
            can consume. Install it, point it at your app, and you are recording.
          </p>
        </header>

        <div className="spool-docs__wrap">
          <aside className="spool-docs__side">
            <nav className="spool-docs__nav" aria-label="Docs sections">
              {NAV.map((group) => (
                <div key={group.label}>
                  <div className="spool-docs__nav-lbl">{group.label}</div>
                  {group.links.map((l) => (
                    <a key={l.href} href={l.href}>
                      {l.text}
                    </a>
                  ))}
                </div>
              ))}
            </nav>
          </aside>

          <main className="spool-docs__main">
            <section className="doc-section" id="install">
              <h2>Install</h2>
              <p className="doc-kicker">
                Node 20 or newer, ffmpeg on PATH, and a headless Chromium. The global npm
                package is the fastest path.
              </p>
              <div className="doc-pre">
                <code>
                  <span className="c"># the CLI, published as @spoolkit/cli</span>
                  {"\n"}npm i -g @spoolkit/cli{"\n"}npx playwright install chromium
                </code>
              </div>
              <p>
                Prefer a single command? The installer clones the repo, links <code>spool</code>{" "}
                onto your PATH, and fetches Chromium for you.
              </p>
              <div className="doc-pre">
                <code>curl -fsSL https://raw.githubusercontent.com/aaarnv/spool/master/install.sh | bash</code>
              </div>
              <h3>Prerequisites</h3>
              <ul>
                <li>
                  <strong>Node 20+</strong> and <strong>ffmpeg</strong> on PATH (on macOS,{" "}
                  <code>brew install ffmpeg</code>).
                </li>
                <li>
                  <strong>Chromium</strong> from Playwright&apos;s cache:{" "}
                  <code>npx playwright install chromium</code>.
                </li>
              </ul>
              <h3>Verify the environment</h3>
              <p>
                Run <code>spool doctor</code> anytime to check deps, config, host, and token.
                It prints an actionable fix for anything missing, and <code>--json</code>{" "}
                makes it machine-readable for an agent.
              </p>
              <div className="doc-pre">
                <code>spool doctor</code>
              </div>
            </section>

            <section className="doc-section" id="setup">
              <h2>Setup</h2>
              <p className="doc-kicker">
                One dashboard token covers both publishing and hosted voice. Generate it once,
                drop it in <code>~/.spool.json</code>, and you are configured.
              </p>
              <p>
                Sign in at{" "}
                <a className="link" href="/dashboard">
                  spoolkit.dev/dashboard
                </a>{" "}
                and choose <strong>Generate token</strong>. The token is shown once, so save it
                straight into your config file.
              </p>
              <div className="doc-pre">
                <code>
                  <span className="c"># ~/.spool.json</span>
                  {"\n"}
                  {"{ "}
                  <span className="k">&quot;host&quot;</span>:{" "}
                  <span className="s">&quot;https://spoolkit.dev&quot;</span>,{" "}
                  <span className="k">&quot;token&quot;</span>:{" "}
                  <span className="s">&quot;spk_...&quot;</span>
                  {" }"}
                </code>
              </div>
              <div className="doc-note">
                <strong>Hosted voice needs no OpenAI key.</strong> The voice engine
                auto-resolves: your own <code>OPENAI_API_KEY</code> (env, project{" "}
                <code>.env</code>, or <code>openaiKey</code> in <code>~/.spool.json</code>) is
                used when present, otherwise voice runs on the hosted app through the same token,
                subject to a fair-use daily cap. Force one with{" "}
                <code>--engine openai|hosted|local</code>.
              </div>
            </section>

            <section className="doc-section" id="record">
              <h2>Record a walkthrough</h2>
              <p className="doc-kicker">
                Live mode is the drive-once path. You just verified a feature in a browser, so
                drive it one more time and spool records as you go. No <code>steps.mjs</code> to
                author or debug.
              </p>
              <p>
                Start a session against your running app. Spool boots a headless recording
                browser and an HTTP control server on <code>127.0.0.1:&lt;port&gt;</code>, then
                prints one line of stdout with the port.
              </p>
              <div className="doc-pre">
                <code>spool live spool/my-feature --url http://localhost:3000</code>
              </div>
              <h3>The control server</h3>
              <p>You drive the take by posting to the control port:</p>
              <ul>
                <li>
                  <code>POST /step</code>:{" "}
                  <code>{"{ name, narration, zoom }"}</code>. Narration is required; the renderer
                  sizes each step window to it.
                </li>
                <li>
                  <code>POST /js</code>: runs the body of{" "}
                  <code>async (page, h) =&gt; {"{ … }"}</code>. Use the <code>h.*</code> helpers
                  (<code>click</code>, <code>move</code>, <code>type</code>, <code>scroll</code>,{" "}
                  <code>pause</code>) for anything visible.
                </li>
                <li>
                  <code>GET /status</code>: progress so far.
                </li>
                <li>
                  <code>POST /end</code>: finalizes <code>video.webm</code>,{" "}
                  <code>timeline.json</code>, keyframes, and a generated <code>steps.mjs</code>{" "}
                  snapshot.
                </li>
              </ul>
              <h3>Drive it in one continuous script</h3>
              <p>
                Write every step as a <strong>single shell script and run it in one command</strong>.
                Thinking time between separate tool calls is recorded as dead air in the take.
                End each step settled, with about two seconds of <code>h.pause</code>, so the
                freeze-hold lands on a finished state. Aim for four to eight steps, one idea each.
              </p>
              <div className="doc-pre">
                <code>
                  <span className="c"># each step is one /step then one /js</span>
                  {"\n"}curl -sX POST 127.0.0.1:$PORT/step -d &apos;{"{"}&quot;name&quot;:&quot;open&quot;,&quot;narration&quot;:&quot;The dashboard loads the new flow.&quot;{"}"}&apos;
                  {"\n"}curl -sX POST 127.0.0.1:$PORT/js   -d &apos;{"{"}&quot;code&quot;:&quot;await h.click(\&quot;#open\&quot;); await page.waitForSelector(\&quot;.result\&quot;)&quot;{"}"}&apos;
                  {"\n"}curl -sX POST 127.0.0.1:$PORT/end
                </code>
              </div>
              <div className="doc-note">
                <strong>Failure forensics.</strong> A failed <code>/js</code> returns{" "}
                <code>{"{ ok: false }"}</code> without killing the session, and it comes back with
                a <strong>screenshot path</strong>, the recent <strong>console</strong>{" "}
                telemetry, and <strong>selector candidates</strong> when the error looks
                locator-shaped. Fix and retry inline; those seconds are recorded, so keep fumbles
                short.
              </div>
              <h3>Finish and publish</h3>
              <p>
                <code>spool finish</code> runs voice, render, and share on the recorded session
                without re-recording, producing <code>final.mp4</code> plus the{" "}
                <code>share/</code> bundle.
              </p>
              <div className="doc-pre">
                <code>
                  spool finish spool/my-feature{"\n"}spool publish spool/my-feature
                </code>
              </div>
              <p>
                Prefer a reproducible driver? The scripted path is{" "}
                <code>spool init my-feature</code> to scaffold a <code>steps.mjs</code>,{" "}
                <code>spool dry</code> to debug it cheaply, then <code>spool build</code>. To
                leave the browser (native apps, the terminal) capture the whole macOS desktop
                with <code>spool live --target os</code>.
              </p>
            </section>

            <section className="doc-section" id="pr-guides">
              <h2>PR guides</h2>
              <p className="doc-kicker">
                Turn a pull request into a narrated, navigable reading of the change. A guide is
                a comprehension tool, not a review: no verdicts, no bug hunting.
              </p>
              <p>
                Scaffold the workdir from the PR number or URL. It fetches the metadata and diff
                via <code>gh</code> and writes <code>tour.json</code>, <code>context.json</code>,
                and a <code>context.md</code> brief.
              </p>
              <div className="doc-pre">
                <code>spool pr 128</code>
              </div>
              <p>
                Rewrite <code>tour.json</code> into four to eight stops in narrative reading
                order (why the change exists, the entrypoint, the core change, the ripples, the
                tests). Each stop is <code>{"{ id, heading, prose, files }"}</code>.
              </p>
              <ul>
                <li>
                  <strong>UI-surface change:</strong> live-record the running feature, naming each{" "}
                  <code>/step</code> after the tour stop id it illustrates. Stop ids are the only
                  link between the tour and the video.
                </li>
                <li>
                  <strong>Non-UI change</strong> (refactor, backend, infra): author a
                  self-contained <code>explainer.html</code> in the workdir and record that page,
                  one section reveal per step.
                </li>
              </ul>
              <p>
                Run <code>spool lint</code> to catch structural breaks and unmatched tour stops,
                then publish with <code>--pr</code>. Publishing comments the guide, a stop table
                timestamped to the video, on the pull request.
              </p>
              <div className="doc-pre">
                <code>
                  spool lint spool/pr-128{"\n"}spool publish spool/pr-128 --pr 128
                </code>
              </div>
            </section>

            <section className="doc-section" id="projects">
              <h2>Projects</h2>
              <p className="doc-kicker">
                Seed a repo&apos;s shared knowledge once so future guides and recordings start
                warm instead of re-deriving the app every time.
              </p>
              <p>
                Bare <code>spool init</code> (no slug) detects the repo owner and name via{" "}
                <code>gh</code>, fetches the current project store into{" "}
                <code>spool/project/knowledge.json</code>, and writes an empty ops file for you to
                author. Record the overview, the subsystems a reader needs, the domain vocabulary,
                and, after booting the app, the <code>recording</code> topics: how to run it, the
                dev-login shape, and any flaky spots.
              </p>
              <div className="doc-pre">
                <code>
                  spool init{"          "}<span className="c"># scaffold the seed ops</span>
                  {"\n"}spool init --apply{"  "}<span className="c"># apply them to the project store</span>
                </code>
              </div>
              <p>
                Once seeded, every <code>spool pr</code> and <code>spool live</code> session on
                the repo starts from those recording topics, and each published guide grounds its
                watch-page chat in the accumulated project knowledge.
              </p>
            </section>

            <section className="doc-section" id="cli">
              <h2>CLI reference</h2>
              <p className="doc-kicker">
                Every command, with its most common flags. Run <code>spool &lt;command&gt; --help</code>{" "}
                for the full option list.
              </p>
              <div className="doc-table-wrap">
                <table className="doc-table">
                  <thead>
                    <tr>
                      <th>Command</th>
                      <th>What it does</th>
                    </tr>
                  </thead>
                  <tbody>
                    {COMMANDS.map(([cmd, desc]) => (
                      <tr key={cmd}>
                        <td>{cmd}</td>
                        <td>{desc}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            <section className="doc-section" id="agents">
              <h2>For agents</h2>
              <p className="doc-kicker">
                Spool is built for agents to consume, not just produce. Every build emits a
                machine-readable bundle so another agent can review a demo without watching video.
              </p>
              <ul>
                <li>
                  <strong>
                    <code>share/spool.json</code>
                  :</strong>{" "}
                  steps, narration, timings, click coordinates, and keyframe paths, with{" "}
                  <code>transcript.txt</code> and one keyframe PNG per step alongside it.
                </li>
                <li>
                  <strong>
                    <code>console.jsonl</code>
                  :</strong>{" "}
                  browser console, page errors, and failed requests captured during
                  recording. File bugs straight from it or verify a claimed fix renders clean.
                </li>
                <li>
                  <strong>
                    <code>spool read &lt;dir&gt;</code>
                  :</strong>{" "}
                  an instant digest of a spool (steps, narration, timings, console
                  errors, keyframe paths). Read only the frames you care about after that.
                </li>
                <li>
                  <strong>
                    <code>--json</code>
                  :</strong>{" "}
                  both <code>spool lint --json</code> and <code>spool doctor --json</code>{" "}
                  emit structured output for programmatic checks.
                </li>
              </ul>
              <div className="doc-note">
                <strong>One-paste onboarding.</strong> The{" "}
                <a className="link" href="/dashboard">
                  dashboard
                </a>{" "}
                mints a token and copies a full agent prompt to your clipboard, so getting an
                agent set up is a single paste into Claude Code or Codex. The full workflow also
                ships as an{" "}
                <a className="link" href={`${GITHUB}/blob/master/skills/spool/SKILL.md`}>
                  agent skill
                </a>{" "}
                you can drop into your agent&apos;s skills directory.
              </div>
            </section>

            <section className="doc-section" id="pricing">
              <h2>Pricing &amp; self-host</h2>
              <p className="doc-kicker">Open source at the core, hosted when you want it managed.</p>
              <p>
                The free plan publishes <strong>3 spools</strong> with every feature included, and
                the links stay live forever. <strong>Pro is $8/mo</strong> for unlimited published
                spools, PR guides, shared projects, hosted voice, and per-user CI tokens.{" "}
                <strong>Self-hosting is free forever</strong>: the entire CLI and watch app are MIT
                licensed, so you can record, narrate, render, and host the whole pipeline yourself
                with no lock-in. See the{" "}
                <a className="link" href="/#pricing">
                  pricing section
                </a>{" "}
                or the{" "}
                <a className="link" href={GITHUB}>
                  repository
                </a>
                .
              </p>
            </section>
          </main>
        </div>

        <footer className="spool-footer">
          <span className="spool-footer__brand">
            <SpoolMark size={22} />
            Spool
          </span>
          <nav className="spool-footer__links">
            <a href="/#features">Features</a>
            <a href="/#pricing">Pricing</a>
            <a href={GITHUB}>GitHub</a>
            <a href="/docs">Docs</a>
          </nav>
          <span className="spool-footer__note">
            Open-source walkthroughs your coding agents record themselves.
          </span>
        </footer>
      </div>
    </>
  );
}
