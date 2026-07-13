"use client";

import { useState } from "react";
import { parseDiff, type DiffFile } from "../../../lib/diff";
import type { TourNode } from "./Watch";

// One shared fetch+parse of the diff.patch per url, resolved lazily the first
// time any stop is expanded and reused by every other stop.
const diffCache = new Map<string, Promise<DiffFile[]>>();
function loadDiff(url: string): Promise<DiffFile[]> {
  let p = diffCache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.text() : ""))
      .then(parseDiff)
      .catch(() => []);
    diffCache.set(url, p);
  }
  return p;
}

const pretty = (slug: string) =>
  slug.replace(/[-_]/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function StopDiff({ stop, files }: { stop: TourNode; files: DiffFile[] }) {
  return (
    <div className="wv-diff">
      {stop.files.map((f, fi) => {
        const df = files.find((d) => d.path === f.path);
        if (!df) {
          return (
            <div key={fi} className="wv-diff-file">
              <div className="wv-diff-path">{f.path}</div>
              <div className="wv-diff-missing">not in diff</div>
            </div>
          );
        }
        const hunks =
          f.hunks && f.hunks.length
            ? f.hunks.map((i) => df.hunks[i]).filter(Boolean)
            : df.hunks;
        return (
          <div key={fi} className="wv-diff-file">
            <div className="wv-diff-path">{df.path}</div>
            {hunks.length === 0 ? (
              <div className="wv-diff-missing">no textual changes</div>
            ) : (
              hunks.map((h, hi) => (
                <div key={hi} className="wv-diff-hunk">
                  <div className="wv-diff-hunkhead">{h.header}</div>
                  {h.lines.map((l, li) => (
                    <div
                      key={li}
                      className={`wv-diff-line wv-diff-${
                        l.kind === "+" ? "add" : l.kind === "-" ? "del" : "ctx"
                      }`}
                    >
                      <span className="wv-diff-gutter">{l.kind === " " ? "" : l.kind}</span>
                      <span className="wv-diff-text">{l.text || " "}</span>
                    </div>
                  ))}
                </div>
              ))
            )}
          </div>
        );
      })}
    </div>
  );
}

function StopNode({
  stop,
  index,
  active,
  seek,
  diffUrl,
}: {
  stop: TourNode;
  index: number;
  active: number;
  seek: (at: number, i: number) => void;
  diffUrl?: string;
}) {
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<DiffFile[] | null>(null);
  const anchored = stop.at != null;

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && !files && diffUrl) setFiles(await loadDiff(diffUrl));
  };

  const head = (
    <>
      <span className="wv-d-dot" />
      <span className="wv-d-node-body">
        <span className="wv-d-node-head">
          <span className="wv-d-node-name">{stop.heading || pretty(stop.id)}</span>
          {stop.label && <span className="wv-d-node-t">{stop.label}</span>}
        </span>
        {stop.prose && <span className="wv-d-node-narr">{stop.prose}</span>}
      </span>
    </>
  );

  return (
    <li className="wv-d-node" data-active={active === index}>
      {anchored ? (
        <button className="wv-d-node-btn" onClick={() => seek(stop.at as number, index)}>
          {head}
        </button>
      ) : (
        <div className="wv-d-node-btn wv-d-node-static">{head}</div>
      )}
      {stop.files.length > 0 && (
        <div className="wv-diff-toggle-row">
          <button className="wv-diff-toggle" onClick={toggle} aria-expanded={open}>
            <span className="wv-caret">›</span>
            {open ? "Hide changes" : "View changes"}
          </button>
        </div>
      )}
      {open && (files ? <StopDiff stop={stop} files={files} /> : <div className="wv-diff-loading">Loading diff…</div>)}
    </li>
  );
}

// The tour IS the reading order: PR-guide stops render as spine nodes in place
// of chapters, each seekable when anchored and expandable to its diff slice.
export default function TourSpine({
  tour,
  active,
  seek,
  diffUrl,
}: {
  tour: TourNode[];
  active: number;
  seek: (at: number, i: number) => void;
  diffUrl?: string;
}) {
  return (
    <ol className="wv-d-spine">
      {tour.map((stop, i) => (
        <StopNode key={stop.id || i} stop={stop} index={i} active={active} seek={seek} diffUrl={diffUrl} />
      ))}
    </ol>
  );
}
