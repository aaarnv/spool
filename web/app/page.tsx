import { sans, serif } from "./components/marketing/fonts";
import ShaderBackground from "./components/marketing/ShaderBackground";
import {
  SpoolMark,
  TerminalIcon,
  PlayIcon,
  PlayFill,
  StarIcon,
  LockIcon,
} from "./components/marketing/icons";
import "./components/marketing/landing.css";
import type { Metadata } from "next";

const GITHUB = "https://github.com/aaarnv/spool";

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
            <a href="#docs">Docs</a>
          </span>
          <a className="spool-nav__cta" href="#start">
            Publish a spool
          </a>
        </nav>

        <main className="spool-shell">
          <section className="spool-hero">
            <span className="spool-eyebrow">
              <span className="pip">◆</span>
              Open-source, self-recording walkthroughs for coding agents
            </span>

            <h1 className="spool-h1">
              <span className="line">
                <span className="word">Turn&nbsp;</span>
                <span className="word">
                  <span className="spool-chip spool-chip--blue">
                    <span className="glyph">
                      <TerminalIcon />
                    </span>
                    <span className="txt">agent work</span>
                  </span>
                </span>
                <span className="word">&nbsp;into</span>
              </span>
              <span className="line">
                <span className="word">
                  <span className="spool-chip spool-chip--coral">
                    <span className="glyph">
                      <PlayIcon />
                    </span>
                    <span className="txt">client-ready walkthroughs</span>
                  </span>
                </span>
              </span>
            </h1>

            <p className="spool-sub">
              Your coding agents record, narrate, and publish a real walkthrough of
              everything they ship. No human ever hits record. Every spool is one
              link to watch, for clients, teammates, and other agents.
            </p>

            <div className="spool-cta" id="start">
              <a className="btn-primary" href={GITHUB}>
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
                  spool.dev/l/<b>finishing-lab</b>
                </span>
                <span className="spool-window__live">
                  <i />
                  <span>LIVE</span>
                </span>
              </div>
              {/* Real screenshot of a published spool's watch page. */}
              <img
                className="spool-window__img"
                src="/product-spool.png"
                alt="A published Spool walkthrough of the Finishing Lab app, narrated by the agent that built it"
                width={1600}
                height={1100}
              />
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
