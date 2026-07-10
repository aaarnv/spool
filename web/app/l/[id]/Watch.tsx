"use client";

import { useRef, useState } from "react";
import EditPanel from "./EditPanel";

export type Chapter = { i: number; name: string; label: string; at: number };
export type Line = { i: number; label: string; narration: string; at: number };

type Props = {
  title: string;
  durationLabel: string;
  src: string;
  poster?: string;
  chapters: Chapter[];
  lines: Line[];
  isOwner: boolean;
  hasSources: boolean;
  spoolId: string;
  rawUrl: string;
  consoleUrl: string;
  signedIn: boolean;
};

const pretty = (slug: string) =>
  slug.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// The watch page: ultra-sparse single column. The player is the one object;
// chapters are a quiet centered row, transcript folds away until wanted.
export default function Watch({
  title,
  durationLabel,
  src,
  poster,
  chapters,
  lines,
  isOwner,
  hasSources,
  spoolId,
  rawUrl,
  consoleUrl,
  signedIn,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState<number>(-1);

  const seek = (at: number, i: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = at + 0.001;
    setActive(i);
    void v.play().catch(() => {});
  };

  return (
    <div className="wv wv-a">
      <header className="wv-top">
        <a className="wv-top-brand" href="/">
          <img src="/logo.svg" width={20} height={20} alt="" />
          <span>spool</span>
        </a>
        <nav className="wv-top-nav">
          {signedIn ? (
            <a className="wv-top-link wv-top-cta" href="/dashboard">
              My spools
            </a>
          ) : (
            <>
              <a className="wv-top-link" href="/sign-in">
                Sign in
              </a>
              <a className="wv-top-link wv-top-cta" href="/sign-up">
                Get started
              </a>
            </>
          )}
        </nav>
      </header>

      <main className="wv-a-shell">
        <div className="wv-a-stage">
          <video
            ref={ref}
            src={src}
            poster={poster}
            controls
            autoPlay
            muted
            playsInline
            preload="metadata"
          />
        </div>

        <div className="wv-a-head">
          <h1 className="wv-a-title">{title}</h1>
          <p className="wv-a-byline">
            {durationLabel}
            <span className="wv-a-dot" />
            recorded by an agent
          </p>
        </div>

        {chapters.length > 0 && (
          <nav className="wv-a-chapters">
            <div className="wv-chapters">
              {chapters.map((c) => (
                <button
                  key={c.i}
                  className="wv-chip"
                  data-active={active === c.i}
                  onClick={() => seek(c.at, c.i)}
                >
                  <span className="wv-chip-n">{pretty(c.name)}</span>
                  <span className="wv-chip-t">{c.label}</span>
                </button>
              ))}
            </div>
          </nav>
        )}

        {lines.length > 0 && (
          <details className="wv-a-fold">
            <summary>
              <span className="wv-caret">›</span> Transcript
            </summary>
            <div className="wv-a-fold-body">
              <div className="wv-transcript">
                {lines.map((l) => (
                  <button
                    key={l.i}
                    className="wv-trow"
                    onClick={() => seek(l.at, l.i)}
                  >
                    <span className="wv-trow-t">{l.label}</span>
                    <span className="wv-trow-n">{l.narration}</span>
                  </button>
                ))}
              </div>
            </div>
          </details>
        )}

        {isOwner && (
          <div className="wv-edit">
            <EditPanel spoolId={spoolId} hasSources={hasSources} videoSrc={src} />
          </div>
        )}

        <details className="wv-agents">
          <summary>
            <span className="wv-caret">›</span>
            For agents
          </summary>
          <div className="wv-agents-body">
            Machine-readable walkthrough data. <code>spool.json</code> indexes
            every step (narration, timings, keyframes);{" "}
            <code>console.jsonl</code> is the browser telemetry captured while
            recording.
            <div className="wv-agents-links">
              <a href={rawUrl}>spool.json →</a>
              <a href={consoleUrl}>console.jsonl →</a>
            </div>
          </div>
        </details>
      </main>
    </div>
  );
}
