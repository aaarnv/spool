"use client";

import type { Chapter, Line } from "./Watch";

const pretty = (slug: string) =>
  slug.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// Plain-spool spine: chapters + narration merge into one annotated list and
// every row seeks the video. Shared by the watch page and the embed player.
export default function ChapterSpine({
  chapters,
  lines,
  active,
  seek,
}: {
  chapters: Chapter[];
  lines: Line[];
  active: number;
  seek: (at: number, i: number) => void;
}) {
  const byStep = new Map(lines.map((l) => [l.i, l.narration]));
  return (
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
  );
}
