import { sans, serif } from "./components/marketing/fonts";
import ShaderBackground from "./components/marketing/ShaderBackground";
import {
  SpoolMark,
  PlayFill,
  StarIcon,
  LockIcon,
  FilmIcon,
  MicIcon,
  LinkIcon,
  CIIcon,
  CheckIcon,
  ArrowIcon,
} from "./components/marketing/icons";
import "./components/marketing/landing.css";
import type { Metadata } from "next";

const GITHUB = "https://github.com/aaarnv/spool";
const SIGNUP = "/sign-up";

const TITLE = "Spool: agents record their own walkthroughs";
const DESC =
  "Your coding agents record, narrate, and publish a real walkthrough of everything they ship. No human ever hits record. One link to watch, for people and agents alike.";

export const metadata: Metadata = {
  title: TITLE,
  description: DESC,
  openGraph: { title: TITLE, description: DESC, type: "website" },
  twitter: { card: "summary_large_image", title: TITLE, description: DESC },
};

export default function Home() {
  return (
    <>
      <ShaderBackground />
      <div className={`spool-landing ${sans.variable} ${serif.variable}`}>
        <nav className="spool-nav">
          <span className="spool-nav__brand">
            <SpoolMark />
            Spool
          </span>
          <span className="spool-nav__links">
            <a href="#features">Features</a>
            <a href={GITHUB}>Open source</a>
            <a href="#pricing">Pricing</a>
            <a href={GITHUB}>Docs</a>
          </span>
          <a className="spool-nav__cta" href={SIGNUP}>
            Publish a spool
          </a>
        </nav>

        <main className="spool-shell">
          <section className="spool-hero">
            <h1 className="spool-h1">
              <span className="line">
                <span className="word">Turn </span>
                <span className="word">
                  <span className="mark mark--blue">agent work</span>
                </span>
                <span className="word"> into</span>
              </span>
              <span className="line">
                <span className="word">
                  <span className="mark mark--ember">client-ready walkthroughs</span>
                </span>
              </span>
            </h1>

            <p className="spool-sub">
              A narrated walkthrough of everything your agents ship. No human hits record.
            </p>

            <div className="spool-cta">
              <a className="btn-primary" href={SIGNUP}>
                <span className="pt">
                  <PlayFill size={12} />
                </span>
                Publish your first spool
              </a>
              <a className="btn-ghost" href={GITHUB}>
                <StarIcon size={17} />
                Star on GitHub
              </a>
            </div>
          </section>

          <section className="spool-shot" aria-label="A published spool">
            <div className="spool-window">
              <div className="spool-window__bar">
                <span className="spool-window__dots">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="spool-window__url">
                  <LockIcon size={12} />
                  spoolkit.dev/l/<b>spool-tour</b>
                </span>
                <span className="spool-window__live">
                  <i />
                  <span>LIVE</span>
                </span>
              </div>
              {/* The real thing: Spool's own walkthrough, recorded and narrated by the agent. */}
              <a href="/l/dMgYI3fhtBeW-ZljmDqqMg" aria-label="Watch Spool's own narrated walkthrough">
                <video
                  className="spool-window__img"
                  src="https://ipzxlhyhrfdty2vw.public.blob.vercel-storage.com/l/dMgYI3fhtBeW-ZljmDqqMg/final.mp4"
                  poster="https://ipzxlhyhrfdty2vw.public.blob.vercel-storage.com/l/dMgYI3fhtBeW-ZljmDqqMg/frames/step_00.png"
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  width={1600}
                  height={1100}
                />
              </a>
            </div>
          </section>
        </main>

        <section className="spool-section" id="features">
          <div className="spool-section__head">
            <span className="spool-eyebrow-lbl">How it works</span>
            <h2 className="spool-section__title">A real demo, every time your agent ships</h2>
            <p className="spool-section__sub">
              Spool drives the actual app, records it, narrates it, and publishes a single link.
            </p>
          </div>

          <div className="spool-features">
            <div className="spool-feat">
              <span className="spool-feat__icon">
                <FilmIcon />
              </span>
              <h3>Real recordings, not slideshows</h3>
              <p>
                Playwright drives the live app. Continuous video with a smooth cursor,
                auto-zoom on clicks, and word-synced captions, never a deck of stitched
                screenshots.
              </p>
            </div>

            <div className="spool-feat">
              <span className="spool-feat__icon">
                <MicIcon />
              </span>
              <h3>Narrated like the engineer who built it</h3>
              <p>
                An AI voice walks through the change the way the person who shipped it
                would brief a client. Calm, specific, and client-ready by default.
              </p>
            </div>

            <div className="spool-feat">
              <span className="spool-feat__icon">
                <CIIcon />
              </span>
              <h3>Built for your pipeline</h3>
              <p>
                <code>spool build</code> then <code>spool publish</code> from any CI job.
                Every merged change can leave with its own walkthrough, hands-off.
              </p>
            </div>

            <div className="spool-feat spool-feat--wide">
              <div className="spool-feat__body">
                <div>
                  <span className="spool-feat__icon">
                    <LinkIcon />
                  </span>
                  <h3>One link for humans and agents</h3>
                  <p>
                    Humans get a watch page. Agents get a machine-readable{" "}
                    <code>spool.json</code> receipt, with chapters, transcript, and
                    console telemetry travelling alongside the video.
                  </p>
                </div>
                <pre className="spool-code" aria-hidden="true">
                  <span className="c">// spool.json</span>
                  {"\n"}
                  {"{"}
                  {"\n  "}
                  <span className="k">&quot;version&quot;</span>: <span className="n">1</span>,{" "}
                  <span className="k">&quot;title&quot;</span>:{" "}
                  <span className="s">&quot;Finishing Lab walkthrough&quot;</span>,
                  {"\n  "}
                  <span className="k">&quot;duration&quot;</span>: <span className="n">34.2</span>,{" "}
                  <span className="k">&quot;voice&quot;</span>: {"{ "}
                  <span className="k">&quot;voice&quot;</span>:{" "}
                  <span className="s">&quot;alloy&quot;</span> {"},"}
                  {"\n  "}
                  <span className="k">&quot;steps&quot;</span>: [
                  {"\n    "}
                  {"{ "}
                  <span className="k">&quot;name&quot;</span>:{" "}
                  <span className="s">&quot;open-board&quot;</span>,{" "}
                  <span className="k">&quot;start&quot;</span>: <span className="n">0</span>,{" "}
                  <span className="k">&quot;end&quot;</span>: <span className="n">8.4</span>
                  {" }"}
                  {"\n  ] }"}
                </pre>
              </div>
            </div>
          </div>
        </section>

        <section className="spool-section" id="pricing">
          <div className="spool-section__head">
            <span className="spool-eyebrow-lbl">Pricing</span>
            <h2 className="spool-section__title">Open source at the core</h2>
            <p className="spool-section__sub">
              Self-host the whole pipeline for free, or let us host the watch app while it is in beta.
            </p>
          </div>

          <div className="spool-pricing">
            <div className="spool-plan">
              <span className="spool-plan__tag spool-plan__tag--os">Open source</span>
              <h3>Free forever</h3>
              <p className="spool-plan__blurb">
                The entire CLI and watch app, MIT licensed. Run it yourself, anywhere.
              </p>
              <div className="spool-plan__price">
                <span className="amt">$0</span>
                <span className="per">/ self-hosted</span>
              </div>
              <ul className="spool-plan__list spool-plan__list--os">
                <li>
                  <CheckIcon /> Record, narrate, and render locally
                </li>
                <li>
                  <CheckIcon /> Self-host the watch app
                </li>
                <li>
                  <CheckIcon /> MIT licensed, no lock-in
                </li>
              </ul>
              <a className="spool-plan__cta spool-plan__cta--ghost" href={GITHUB}>
                <StarIcon size={16} />
                View on GitHub
              </a>
            </div>

            <div className="spool-plan spool-plan--featured">
              <span className="spool-plan__tag spool-plan__tag--host">Hosted</span>
              <h3>Free during beta</h3>
              <p className="spool-plan__blurb">
                We host the watch app, links, and dashboard. Nothing to run.
              </p>
              <div className="spool-plan__price">
                <span className="amt">$0</span>
                <span className="later">
                  <s>$15/mo</s> after beta
                </span>
              </div>
              <ul className="spool-plan__list">
                <li>
                  <CheckIcon /> Unlisted, shareable spool links
                </li>
                <li>
                  <CheckIcon /> Dashboard for every published spool
                </li>
                <li>
                  <CheckIcon /> Per-user publish tokens for CI
                </li>
              </ul>
              <a className="spool-plan__cta spool-plan__cta--light" href={SIGNUP}>
                Start free
                <ArrowIcon size={16} />
              </a>
            </div>
          </div>
        </section>

        <footer className="spool-footer">
          <span className="spool-footer__brand">
            <SpoolMark size={22} />
            Spool
          </span>
          <nav className="spool-footer__links">
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
            <a href={GITHUB}>GitHub</a>
            <a href={GITHUB}>Docs</a>
          </nav>
          <span className="spool-footer__note">
            Open-source walkthroughs your coding agents record themselves.
          </span>
        </footer>
      </div>
    </>
  );
}
