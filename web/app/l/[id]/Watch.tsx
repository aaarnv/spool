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

// The watch page: timeline spine. Sticky player (plus owner edit and agent
// receipts) on the left; on the right, chapters and narration merge into one
// annotated spine — the walkthrough's structure IS the navigation. Every
// spine row seeks the video.
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

  const byStep = new Map(lines.map((l) => [l.i, l.narration]));

  return (
    <div className="wv wv-d">
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

      <main className="wv-d-shell">
        <div className="wv-d-head">
          <div className="wv-d-eyebrow">Recorded by an agent</div>
          <h1 className="wv-d-title">{title}</h1>
          <p className="wv-d-byline">
            {durationLabel} · {chapters.length} chapters · one continuous take
          </p>
        </div>

        <div className="wv-d-cols">
          <div className="wv-d-sticky">
            <div className="wv-d-stage">
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
                Machine-readable walkthrough data. <code>spool.json</code>{" "}
                indexes every step (narration, timings, keyframes);{" "}
                <code>console.jsonl</code> is the browser telemetry captured
                while recording.
                <div className="wv-agents-links">
                  <a href={rawUrl}>spool.json →</a>
                  <a href={consoleUrl}>console.jsonl →</a>
                </div>
              </div>
            </details>
          </div>

          <ol className="wv-d-spine">
            {chapters.map((c) => (
              <li key={c.i} className="wv-d-node" data-active={active === c.i}>
                <button className="wv-d-node-btn" onClick={() => seek(c.at, c.i)}>
                  <span className="wv-d-dot" />
                  <span className="wv-d-node-body">
                    <span className="wv-d-node-head">
                      <span className="wv-d-node-name">{pretty(c.name)}</span>
                      <span className="wv-d-node-t">{c.label}</span>
                    </span>
                    {byStep.get(c.i) && (
                      <span className="wv-d-node-narr">{byStep.get(c.i)}</span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </main>
    </div>
  );
}
