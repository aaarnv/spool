import React from "react";
import {
  AbsoluteFill,
  Audio,
  Freeze,
  Img,
  OffthreadVideo,
  Sequence,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { buildWindows, FPS, TAIL_S } from "./retime.mjs";

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

// durationInFrames = retimed output windows + a tail so the last caption/VO lands.
export const calculateSpoolMetadata = ({ props }) => {
  const { totalFrames } = buildWindows(props?.timeline, props?.manifest, FPS);
  return { durationInFrames: Math.max(1, totalFrames + Math.round(TAIL_S * FPS)) };
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
// gaps). Each word time is offset by its step's start on the OUTPUT timeline.
function buildPhrases(manifest, windows) {
  const startByIndex = new Map(windows.map((w) => [w.i, w.startSec]));
  const phrases = [];
  for (const seg of manifest.segments || []) {
    const offset = startByIndex.get(seg.i) ?? 0;
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
          background: "rgba(16,16,22,0.86)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 14px 46px rgba(0,0,0,0.42)",
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

// The title reads as a subtitle: same bottom-center pill as the captions, a
// touch larger, and it clears out just before the first caption lands so the two
// never stack.
const TitleSubtitle = ({ title, frame, firstCaptionStart }) => {
  if (!title) return null;
  const t = frame / FPS;
  const rawEnd = firstCaptionStart != null ? firstCaptionStart - 0.15 : 1.4;
  const end = Math.max(0.7, Math.min(rawEnd, 1.8));
  const opacity = interpolate(t, [0, 0.3, end - 0.2, end], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;
  const y = interpolate(t, [0, 0.3], [10, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
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
          transform: `translateY(${y}px)`,
          padding: "18px 34px",
          borderRadius: 20,
          background: "rgba(16,16,22,0.86)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 14px 46px rgba(0,0,0,0.42)",
          color: "#fff",
          fontFamily: FONT,
          fontSize: 40,
          fontWeight: 600,
          letterSpacing: "-0.01em",
        }}
      >
        {title}
      </div>
    </AbsoluteFill>
  );
};

// One step → a play Sequence (its recorded slice at 1x) then, when the window
// outlasts the capture, a freeze Sequence holding the slice's last frame. The
// window is a max() so the played portion always fits; video is never sped up.
function StepVideo({ w, isLast }) {
  const src = staticFile("video.mp4");
  const fill = { width: "100%", height: "100%", objectFit: "cover" };
  const tail = isLast ? Math.round(TAIL_S * FPS) : 0;
  const freezeFrames = w.windowFrames - w.recFrames + tail;
  const lastMediaFrame = Math.max(0, w.outF - 1);
  return (
    <>
      <Sequence from={w.startF} durationInFrames={w.recFrames}>
        <OffthreadVideo src={src} trimBefore={w.inF} trimAfter={w.outF} muted style={fill} />
      </Sequence>
      {freezeFrames > 0 ? (
        <Sequence from={w.startF + w.recFrames} durationInFrames={freezeFrames}>
          <Freeze frame={0}>
            <OffthreadVideo src={src} trimBefore={lastMediaFrame} muted style={fill} />
          </Freeze>
        </Sequence>
      ) : null}
    </>
  );
}

export const SpoolComposition = ({ timeline, manifest, title, background }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const card = cardLayout(timeline?.viewport);
  const { windows } = React.useMemo(
    () => buildWindows(timeline, manifest || { segments: [] }, fps),
    [timeline, manifest, fps]
  );
  // getZoom expects {zoom,clicks,start,end}; feed it output-clock values.
  const zoomSteps = React.useMemo(
    () => windows.map((w) => ({ zoom: w.zoom, clicks: w.outClicks, start: w.startSec, end: w.endSec })),
    [windows]
  );
  const zoom = getZoom(t, zoomSteps, card);
  const phrases = React.useMemo(
    () => buildPhrases(manifest || { segments: [] }, windows),
    [manifest, windows]
  );

  return (
    <AbsoluteFill
      style={{
        // Gradient fallback when no wallpaper asset was staged into the workdir.
        background: [
          "radial-gradient(90% 80% at 82% 12%, rgba(150,54,124,0.55) 0%, rgba(150,54,124,0) 55%)",
          "radial-gradient(85% 85% at 12% 92%, rgba(46,58,150,0.50) 0%, rgba(46,58,150,0) 60%)",
          "radial-gradient(70% 60% at 50% 45%, rgba(88,52,140,0.30) 0%, rgba(88,52,140,0) 70%)",
          "linear-gradient(155deg, #171432 0%, #241a45 45%, #33184a 100%)",
        ].join(","),
      }}
    >
      {background ? (
        // Real wallpaper canvas (staged by render.mjs into publicDir). Remotion's
        // <Img> blocks frame capture until it decodes, so it's painted from frame 0
        // — a native <img> isn't awaited and pops in a few frames late (flicker).
        <AbsoluteFill>
          <Img
            src={staticFile(background)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </AbsoluteFill>
      ) : null}
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
            // Deep elevation shadow + a faint light rim so the card separates
            // from the dark wallpaper.
            boxShadow:
              "0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.45), 0 40px 90px -24px rgba(0,0,0,0.6)",
          }}
        >
          {windows.map((w, idx) => (
            <StepVideo key={w.i} w={w} isLast={idx === windows.length - 1} />
          ))}
        </div>
      </AbsoluteFill>

      <TitleSubtitle
        title={title}
        frame={frame}
        firstCaptionStart={phrases.length ? phrases[0].start : null}
      />
      <CaptionBand phrases={phrases} t={t} />

      {/* VO: one Audio per segment, placed at its step's start on the OUTPUT timeline. */}
      {(manifest?.segments || []).map((seg) => {
        const w = windows.find((x) => x.i === seg.i);
        const start = w ? w.startSec : 0;
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
