"use client";

import { useRef, useState } from "react";

export type Chapter = { i: number; name: string; label: string; at: number };
export type Line = { i: number; label: string; narration: string; at: number };

// Owns the seek interaction: the <video> plus chapter chips and transcript rows
// that seek it. Times (`at`) are already on the final.mp4 clock.
export default function Player({
  src,
  poster,
  chapters,
  lines,
}: {
  src: string;
  poster?: string;
  chapters: Chapter[];
  lines: Line[];
}) {
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
    <>
      <div className="card">
        <video
          ref={ref}
          src={src}
          poster={poster}
          controls
          autoPlay
          muted={false}
          playsInline
          preload="metadata"
        />
      </div>

      {chapters.length > 0 && (
        <>
          <div className="section-label">Chapters</div>
          <div className="chapters">
            {chapters.map((c) => (
              <button
                key={c.i}
                className="chip"
                data-active={active === c.i}
                onClick={() => seek(c.at, c.i)}
              >
                <span>{c.name}</span>
                <span className="t">{c.label}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {lines.length > 0 && (
        <>
          <div className="section-label">Transcript</div>
          <div className="transcript">
            {lines.map((l) => (
              <button key={l.i} className="trow" onClick={() => seek(l.at, l.i)}>
                <span className="t">{l.label}</span>
                <span className="n">{l.narration}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}
