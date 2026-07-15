"use client";

import { useRef, useState } from "react";
import EditPanel from "./EditPanel";
import TourSpine from "./TourSpine";
import ChapterSpine from "./ChapterSpine";
import AskPanel from "./AskPanel";

export type Chapter = { i: number; name: string; label: string; at: number };
export type Line = { i: number; label: string; narration: string; at: number };
export type TourNode = {
  id: string;
  heading: string;
  prose: string;
  files: { path: string; hunks?: number[] }[];
  at: number | null;
  label: string | null;
};
export type PrMeta = {
  number: number;
  url: string;
  title: string;
  additions: number;
  deletions: number;
  changedFiles: number;
};

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
  pr?: PrMeta;
  tour?: TourNode[];
  diffUrl?: string;
  prJsonUrl?: string;
  tourJsonUrl?: string;
  grounding?: "bundle" | "diff";
};

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
  pr,
  tour,
  diffUrl,
  prJsonUrl,
  tourJsonUrl,
  grounding,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState<number>(-1);
  const [copied, setCopied] = useState(false);

  const seek = (at: number, i: number) => {
    const v = ref.current;
    if (!v) return;
    v.currentTime = at + 0.001;
    setActive(i);
    void v.play().catch(() => {});
  };

  // Owner affordance: copy a paste-ready iframe snippet for /embed/{id}.
  const copyEmbed = () => {
    const tag = `<iframe src="https://spoolkit.dev/embed/${spoolId}" width="800" height="480" frameborder="0" allowfullscreen></iframe>`;
    navigator.clipboard
      .writeText(tag)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <div className="wv wv-d">
      <header className="wv-top">
        <a className="wv-top-brand" href="/">
          <img src="/logo.svg" width={20} height={20} alt="" />
          <span>spool</span>
        </a>
        <nav className="wv-top-nav">
          {isOwner && (
            <button type="button" className="wv-top-link wv-top-embed" onClick={copyEmbed}>
              {copied ? "Copied" : "Embed"}
            </button>
          )}
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
          <div className="wv-d-head-text">
            <div className="wv-d-eyebrow">Recorded by an agent</div>
            <h1 className="wv-d-title">{title}</h1>
            <p className="wv-d-byline">
              {pr && tour
                ? `${tour.length} stops · guided tour of PR #${pr.number}`
                : `${durationLabel} · ${chapters.length} chapters · one continuous take`}
            </p>
          </div>
          {pr && (
            <a className="wv-pr-link" href={pr.url} target="_blank" rel="noreferrer">
              <span className="wv-pr-num">PR #{pr.number}</span>
              <span className="wv-pr-stat wv-pr-add">+{pr.additions}</span>
              <span className="wv-pr-stat wv-pr-del">−{pr.deletions}</span>
              <span className="wv-pr-files">
                {pr.changedFiles} file{pr.changedFiles === 1 ? "" : "s"}
              </span>
            </a>
          )}
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

            {pr && (
              <div className="wv-ask-mount">
                <AskPanel spoolId={spoolId} grounding={grounding} />
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
                  {diffUrl && <a href={diffUrl}>diff.patch →</a>}
                  {tourJsonUrl && <a href={tourJsonUrl}>tour.json →</a>}
                  {prJsonUrl && <a href={prJsonUrl}>pr.json →</a>}
                </div>
              </div>
            </details>
          </div>

          {pr && tour ? (
            <TourSpine tour={tour} active={active} seek={seek} diffUrl={diffUrl} />
          ) : (
            <ChapterSpine chapters={chapters} lines={lines} active={active} seek={seek} />
          )}
        </div>
      </main>
    </div>
  );
}
