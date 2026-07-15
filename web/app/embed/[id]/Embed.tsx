"use client";

import { useRef, useState } from "react";
import TourSpine from "../../l/[id]/TourSpine";
import ChapterSpine from "../../l/[id]/ChapterSpine";
import type { Chapter, Line, TourNode, PrMeta } from "../../l/[id]/Watch";

type Props = {
  spoolId: string;
  title: string;
  durationLabel: string;
  src: string;
  poster?: string;
  chapters: Chapter[];
  lines: Line[];
  pr?: PrMeta;
  tour?: TourNode[];
  diffUrl?: string;
  prJsonUrl?: string;
  tourJsonUrl?: string;
};

// Iframe-sized player: video + seekable spine only, plus a persistent link out
// to the full watch page. Header, edit, ask and agent sections are dropped.
export default function Embed({ spoolId, src, poster, chapters, lines, pr, tour, diffUrl }: Props) {
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
    <div className="wv wv-embed">
      <div className="wv-d-stage wv-embed-stage">
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

      <div className="wv-embed-spine">
        {pr && tour ? (
          <TourSpine tour={tour} active={active} seek={seek} diffUrl={diffUrl} />
        ) : (
          <ChapterSpine chapters={chapters} lines={lines} active={active} seek={seek} />
        )}
      </div>

      <a
        className="wv-embed-footer"
        href={`https://spoolkit.dev/l/${spoolId}`}
        target="_blank"
        rel="noreferrer"
      >
        <img src="/logo.svg" width={14} height={14} alt="" />
        <span>Watch on Spool → spoolkit.dev/l/{spoolId}</span>
      </a>
    </div>
  );
}
