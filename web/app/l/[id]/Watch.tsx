"use client";

import { useRef, useState } from "react";
import EditPanel from "./EditPanel";
import type { Chapter, Line } from "./Player";

export type Variant = "a" | "b" | "c" | "d";

type Props = {
  variant: Variant;
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

// One client component that hosts all four redesign directions. The <video>
// seek state is shared across chapter chips / transcript rows; each variant is
// a distinct composition of the same atoms, restyled by its wrapper scope.
export default function Watch(props: Props) {
  const {
    variant,
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
  } = props;

  const ref = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState<number>(-1);

  const seek = (at: number, i: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = at + 0.001;
    setActive(i);
    void v.play().catch(() => {});
  };

  // ---- shared atoms (restyled per variant via wrapper scope) ----

  const TopBar = (
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
  );

  const Video = (
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
  );

  const chaptersEl = chapters.length > 0 && (
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
  );

  const transcriptEl = lines.length > 0 && (
    <div className="wv-transcript">
      {lines.map((l) => (
        <button key={l.i} className="wv-trow" onClick={() => seek(l.at, l.i)}>
          <span className="wv-trow-t">{l.label}</span>
          <span className="wv-trow-n">{l.narration}</span>
        </button>
      ))}
    </div>
  );

  const editEl = isOwner && (
    <div className="wv-edit">
      <EditPanel spoolId={spoolId} hasSources={hasSources} videoSrc={src} />
    </div>
  );

  const agentsEl = (
    <details className="wv-agents">
      <summary>
        <span className="wv-caret">›</span>
        For agents
      </summary>
      <div className="wv-agents-body">
        Machine-readable walkthrough data. <code>spool.json</code> indexes every
        step (narration, timings, keyframes); <code>console.jsonl</code> is the
        browser telemetry captured while recording.
        <div className="wv-agents-links">
          <a href={rawUrl}>spool.json →</a>
          <a href={consoleUrl}>console.jsonl →</a>
        </div>
      </div>
    </details>
  );

  const label = (t: string) => <div className="wv-label">{t}</div>;

  // ---------------------------------------------------------------
  // A — Ultra-sparse single column: maximal air, near-zero chrome, the
  //     player floats as the one object; chapters a quiet inline row,
  //     transcript folded away until wanted.
  // ---------------------------------------------------------------
  if (variant === "a") {
    return (
      <div className="wv wv-a">
        {TopBar}
        <main className="wv-a-shell">
          <div className="wv-a-stage">{Video}</div>
          <div className="wv-a-head">
            <h1 className="wv-a-title">{title}</h1>
            <p className="wv-a-byline">
              {durationLabel}
              <span className="wv-a-dot" />
              recorded by an agent
            </p>
          </div>
          {chaptersEl && <nav className="wv-a-chapters">{chaptersEl}</nav>}
          {transcriptEl && (
            <details className="wv-a-fold">
              <summary>
                <span className="wv-caret">›</span> Transcript
              </summary>
              <div className="wv-a-fold-body">{transcriptEl}</div>
            </details>
          )}
          {editEl}
          {agentsEl}
        </main>
      </div>
    );
  }

  // ---------------------------------------------------------------
  // B — Cinema
  // ---------------------------------------------------------------
  if (variant === "b") {
    return (
      <div className="wv wv-b">
        {TopBar}
        <div className="wv-b-stage">{Video}</div>
        <div className="wv-b-meta">
          <h1 className="wv-b-title">{title}</h1>
          <span className="wv-b-byline">
            {durationLabel} · recorded by an agent
          </span>
        </div>
        <main className="wv-b-rail">
          {chaptersEl && (
            <section className="wv-b-block">
              {label("Chapters")}
              {chaptersEl}
            </section>
          )}
          {transcriptEl && (
            <details className="wv-b-drawer">
              <summary>
                <span className="wv-caret">›</span> Transcript
                <span className="wv-b-count">{lines.length}</span>
              </summary>
              <div className="wv-b-drawer-body">{transcriptEl}</div>
            </details>
          )}
          {editEl && <section className="wv-b-block">{editEl}</section>}
          {agentsEl}
        </main>
      </div>
    );
  }

  // ---------------------------------------------------------------
  // C — Split-doc
  // ---------------------------------------------------------------
  if (variant === "c") {
    return (
      <div className="wv wv-c">
        {TopBar}
        <div className="wv-c-docbar">
          <span className="wv-c-crumb">
            <a href="/dashboard">Spools</a>
            <span className="wv-c-sep">/</span>
            <b>{title}</b>
          </span>
          <span className="wv-c-crumb-meta">
            {durationLabel} · {chapters.length} chapters
          </span>
        </div>
        <main className="wv-c-grid">
          <div className="wv-c-left">
            <div className="wv-c-stage">{Video}</div>
            {chaptersEl && (
              <>
                {label("Chapters")}
                {chaptersEl}
              </>
            )}
            {editEl}
          </div>
          <div className="wv-c-right">
            <h1 className="wv-c-title">{title}</h1>
            {transcriptEl && (
              <>
                {label("Transcript")}
                {transcriptEl}
              </>
            )}
            {agentsEl}
          </div>
        </main>
      </div>
    );
  }

  // ---------------------------------------------------------------
  // D — Timeline spine (my take): sticky player, unified chapter+narration
  //     spine as the single scrollable object; dark indigo immersive.
  // ---------------------------------------------------------------
  const byStep = new Map(lines.map((l) => [l.i, l.narration]));
  return (
    <div className="wv wv-d">
      {TopBar}
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
            <div className="wv-d-stage">{Video}</div>
            {editEl}
            {agentsEl}
          </div>
          <ol className="wv-d-spine">
            {chapters.map((c) => (
              <li
                key={c.i}
                className="wv-d-node"
                data-active={active === c.i}
              >
                <button
                  className="wv-d-node-btn"
                  onClick={() => seek(c.at, c.i)}
                >
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
