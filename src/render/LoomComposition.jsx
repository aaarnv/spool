import React from "react";
import {
  AbsoluteFill,
  Audio,
  OffthreadVideo,
  Sequence,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const FPS = 30;
const CANVAS_W = 1920;
const CANVAS_H = 1080;

// Canvas layout: near-full-bleed — the card fills most of the frame with a slim
// border of canvas, and a compact bottom band keeps captions off the UI.
// A 16:9 recording viewport (e.g. 1600x900) fills the frame best.
const PAD_X = 40;
const PAD_TOP = 24;
const CAPTION_BAND = 92;

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

// durationInFrames = timeline length + a 1s tail so the last caption/VO can land.
export const calculateLoomMetadata = ({ props }) => {
  const total = props?.timeline?.total ?? 0;
  return { durationInFrames: Math.max(1, Math.ceil((total + 1) * FPS)) };
};

// Geometry of the centered card, derived once from the viewport size.
function cardLayout(viewport) {
  const vw = viewport?.width ?? 1600;
  const vh = viewport?.height ?? 900;
  const availW = CANVAS_W - 2 * PAD_X;
  const availH = CANVAS_H - PAD_TOP - CAPTION_BAND;
  const scale = Math.min(availW / vw, availH / vh);
  const w = vw * scale;
  const h = vh * scale;
  const x = (CANVAS_W - w) / 2;
  const y = PAD_TOP + (availH - h) / 2;
  return { vw, vh, scale, w, h, x, y };
}

// Map a viewport-space click to canvas-space coords through the card transform.
function clickToCanvas(click, card) {
  return {
    x: card.x + click.x * card.scale,
    y: card.y + click.y * card.scale,
  };
}

// A single eased zoom envelope: rests at 1, ramps to peak around the click,
// holds, then eases back. Kept gentle on purpose (no whiplash).
function envelope(t, start, peakAt, holdEnd, end, peak) {
  if (t <= start || t >= end) return 1;
  if (t < peakAt)
    return interpolate(t, [start, peakAt], [1, peak], {
      easing: Easing.out(Easing.cubic),
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
    });
  if (t <= holdEnd) return peak;
  return interpolate(t, [holdEnd, end], [peak, 1], {
    easing: Easing.in(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
}

// Resolve the active zoom (scale + origin in canvas px) for the current time.
function getZoom(t, steps, card) {
  const center = { x: CANVAS_W / 2, y: CANVAS_H / 2 };
  for (const step of steps) {
    const zoom = step.zoom;
    if (!zoom || zoom === "none") continue;

    if (zoom === "auto") {
      const clicks = step.clicks || [];
      if (!clicks.length) continue;
      const first = clicks[0];
      const last = clicks[clicks.length - 1];
      const t0 = first.t;
      const start = t0 - 0.5;
      const peakAt = t0; // reached ~at the click
      const holdEnd = Math.max(t0 + 1.2, last.t + 0.6);
      const end = holdEnd + 0.6;
      if (t <= start || t >= end) continue;
      const scale = envelope(t, start, peakAt, holdEnd, end, 1.35);
      if (scale <= 1.0001) continue;
      const origin = clickToCanvas(first, card);
      return { scale, ox: origin.x, oy: origin.y };
    }

    if (typeof zoom === "object" && zoom.x != null && zoom.y != null) {
      const peak = zoom.scale || 1.35;
      const start = step.start;
      const end = step.end;
      if (t <= start || t >= end) continue;
      const peakAt = start + 0.6;
      const holdEnd = end - 0.6;
      const scale = envelope(t, start, peakAt, Math.max(peakAt, holdEnd), end, peak);
      if (scale <= 1.0001) continue;
      const origin = clickToCanvas(zoom, card);
      return { scale, ox: origin.x, oy: origin.y };
    }
  }
  return { scale: 1, ox: center.x, oy: center.y };
}

// Flatten all VO segments into absolute-timed phrases (≤6 words, split on >0.6s
// gaps). Each word time is offset by its step's start on the timeline.
function buildPhrases(manifest, steps) {
  const stepByIndex = new Map(steps.map((s) => [s.i, s]));
  const phrases = [];
  for (const seg of manifest.segments || []) {
    const step = stepByIndex.get(seg.i);
    const offset = step ? step.start : 0;
    const words = (seg.wordsData || []).map((w) => ({
      word: w.word,
      start: offset + w.start,
      end: offset + w.end,
    }));
    let cur = [];
    const flush = () => {
      if (!cur.length) return;
      phrases.push({
        words: cur,
        start: cur[0].start,
        end: cur[cur.length - 1].end,
      });
      cur = [];
    };
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (cur.length >= 6) flush();
      else if (cur.length && w.start - cur[cur.length - 1].end > 0.6) flush();
      cur.push(w);
    }
    flush();
  }
  return phrases;
}

const CaptionBand = ({ phrases, t }) => {
  const FADE = 0.15;
  // Show the phrase covering t, extending a touch past its end for readability.
  let active = null;
  let opacity = 0;
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    const showStart = p.start - FADE;
    const next = phrases[i + 1];
    const hardEnd = next ? Math.min(p.end + 0.35, next.start) : p.end + 0.35;
    if (t >= showStart && t <= hardEnd + FADE) {
      active = p;
      const fin = interpolate(t, [showStart, p.start], [0, 1], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      const fout = interpolate(t, [hardEnd, hardEnd + FADE], [1, 0], {
        extrapolateLeft: "clamp",
        extrapolateRight: "clamp",
      });
      opacity = Math.min(fin, fout);
      break;
    }
  }
  if (!active) return null;

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom: 44,
      }}
    >
      <div
        style={{
          opacity,
          maxWidth: 1280,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: "0 11px",
          padding: "16px 30px",
          borderRadius: 20,
          background: "rgba(22,24,30,0.82)",
          boxShadow: "0 10px 40px rgba(0,0,0,0.28)",
          fontFamily: FONT,
          fontSize: 34,
          lineHeight: 1.15,
        }}
      >
        {active.words.map((w, i) => {
          const spoken = t >= w.start && t <= w.end;
          return (
            <span
              key={i}
              style={{
                color: spoken ? "#ffffff" : "rgba(255,255,255,0.72)",
                fontWeight: spoken ? 600 : 500,
              }}
            >
              {w.word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

const TitleOverlay = ({ title, frame }) => {
  if (!title) return null;
  const t = frame / FPS;
  const opacity = interpolate(t, [0, 0.25, 0.95, 1.2], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;
  const y = interpolate(t, [0, 0.25], [12, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div
        style={{
          opacity,
          transform: `translateY(${y}px)`,
          padding: "20px 40px",
          borderRadius: 18,
          background: "rgba(18,20,26,0.55)",
          backdropFilter: "blur(8px)",
          color: "#fff",
          fontFamily: FONT,
          fontSize: 56,
          fontWeight: 600,
          letterSpacing: "-0.01em",
          textShadow: "0 4px 24px rgba(0,0,0,0.4)",
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};

export const LoomComposition = ({ timeline, manifest, title }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const steps = timeline?.steps || [];
  const card = cardLayout(timeline?.viewport);
  const zoom = getZoom(t, steps, card);
  const phrases = React.useMemo(
    () => buildPhrases(manifest || { segments: [] }, steps),
    [manifest, steps]
  );

  return (
    <AbsoluteFill
      style={{
        // Very subtle warm neutral gradient — restrained, premium.
        background:
          "radial-gradient(120% 120% at 50% 0%, #f4f1ec 0%, #e9e5de 55%, #e2ddd4 100%)",
      }}
    >
      {/* Zoom wrapper: scales the card about the click origin. Captions and the
          background stay outside it so only the recording zooms. */}
      <AbsoluteFill
        style={{
          transform: `scale(${zoom.scale})`,
          transformOrigin: `${zoom.ox}px ${zoom.oy}px`,
        }}
      >
        <div
          style={{
            position: "absolute",
            left: card.x,
            top: card.y,
            width: card.w,
            height: card.h,
            borderRadius: 16,
            overflow: "hidden",
            background: "#000",
            boxShadow:
              "0 2px 6px rgba(30,26,20,0.10), 0 30px 70px -20px rgba(40,34,26,0.38)",
          }}
        >
          <OffthreadVideo
            src={staticFile("video.mp4")}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
            muted
          />
        </div>
      </AbsoluteFill>

      <TitleOverlay title={title} frame={frame} />
      <CaptionBand phrases={phrases} t={t} />

      {/* VO: one Audio per segment, placed at its step's start on the timeline. */}
      {(manifest?.segments || []).map((seg) => {
        const step = steps.find((s) => s.i === seg.i);
        const start = step ? step.start : 0;
        const dur = Math.ceil((seg.duration || 0) * fps) + 2;
        return (
          <Sequence
            key={seg.i}
            from={Math.round(start * fps)}
            durationInFrames={Math.max(1, dur)}
          >
            <Audio src={staticFile(seg.wav)} volume={1} />
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
