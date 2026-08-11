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
import {
  buildCameraTrack,
  duckedMusicVolume,
  sampleCamera,
  CTA_S,
  HOOK_S,
  STAGE,
} from "./vertical.mjs";

// Canvas layout: near-full-bleed — the card fills most of the frame with a slim
// border of canvas, and a compact bottom band keeps captions off the UI.
// A 16:9 recording viewport (e.g. 1600x900) fills the frame best.
const PAD_X = 40;
const PAD_TOP = 24;
const CAPTION_BAND = 92;

const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

// Shared between the wide card and the vertical stage so both separate from the
// wallpaper the same way.
const CARD_SHADOW =
  "0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.45), 0 40px 90px -24px rgba(0,0,0,0.6)";

const SCRIM = "rgba(10,10,16,0.55)";

// Same arrow the record overlay draws (src/record/cursor.js). Redrawn here so the
// motion runs at output fps: the recorded path lands at roughly 5 samples/sec.
const CURSOR_PATH = "M2,1 L2,20 L7,15.4 L10.1,22.3 L13,21 L9.9,14.2 L16,14.2 Z";
const RIPPLE_S = 0.5;

// durationInFrames = retimed output windows + a tail so the last caption/VO lands.
// Vertical returns dims too; wide leaves Root's 1920x1080 hardcode untouched.
export const calculateSpoolMetadata = ({ props }) => {
  const isVertical = props?.format === "vertical";
  // fps has to be both consumed here AND returned. Using it for the duration math
  // without returning it leaves Root's 60 as the encoded rate, and the whole cut
  // desyncs; returning it without using it makes the duration wrong. Never split these.
  const fps = props?.fps || FPS;
  const { totalFrames } = buildWindows(props?.timeline, props?.manifest, fps);
  const tailS = TAIL_S + (isVertical ? CTA_S : 0);
  const durationInFrames = Math.max(1, totalFrames + Math.round(tailS * fps));
  return isVertical ? { durationInFrames, fps, width: 1080, height: 1920 } : { durationInFrames, fps };
};

// Geometry of the centered card, derived once from the viewport size.
function cardLayout(viewport, canvasW, canvasH) {
  const vw = viewport?.width ?? 1600;
  const vh = viewport?.height ?? 900;
  const availW = canvasW - 2 * PAD_X;
  const availH = canvasH - PAD_TOP - CAPTION_BAND;
  const scale = Math.min(availW / vw, availH / vh);
  const w = vw * scale;
  const h = vh * scale;
  const x = (canvasW - w) / 2;
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

// Share of the frame a named element should fill. Derived from its box rather than a fixed
// magnification: a small pill needs far more push than a whole panel to read the same.
const ZOOM_FILL = 0.62;
const ZOOM_MIN = 1.08;
const ZOOM_MAX = 2;

function fitScale(zoom, card) {
  if (zoom.scale) return zoom.scale;
  if (!zoom.w || !zoom.h) return 1.35; // hand-authored {x,y} with no box
  const fit = Math.min((card.vw * ZOOM_FILL) / zoom.w, (card.vh * ZOOM_FILL) / zoom.h);
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit));
}

// Resolve the active zoom (scale + origin in canvas px) for the current time.
function getZoom(t, steps, card, canvasW, canvasH) {
  const center = { x: canvasW / 2, y: canvasH / 2 };
  for (const step of steps) {
    const zoom = step.zoom;
    if (!zoom || zoom === "none") continue;
    if (t <= step.start || t >= step.end) continue;

    // Narration sizes the window, so a step runs far longer than the action inside it. Both
    // forms ease out against the step's own end instead of a fixed beat after the action:
    // a ~2s envelope inside a 12s step covered a fifth of it and left the rest flat.
    const end = step.end - 0.15;
    if (t >= end) continue;

    // Opt-in only, and it aims at whatever was pressed. Fine when the click IS the subject;
    // `{selector}` is the way to point at what the narration is actually about.
    if (zoom === "auto") {
      const clicks = step.clicks || [];
      if (!clicks.length) continue;
      const t0 = clicks[0].t;
      const start = Math.max(step.start, t0 - 0.5);
      if (t <= start) continue;
      const holdEnd = Math.max(t0 + 0.8, end - 0.5);
      const scale = envelope(t, start, t0, holdEnd, end, 1.35);
      if (scale <= 1.0001) continue;
      const origin = clickToCanvas(clicks[0], card);
      return { scale, ox: origin.x, oy: origin.y };
    }

    if (typeof zoom === "object" && zoom.x != null && zoom.y != null) {
      const start = step.start;
      const peakAt = start + 0.6;
      const holdEnd = Math.max(peakAt, end - 0.5);
      const scale = envelope(t, start, peakAt, holdEnd, end, fitScale(zoom, card));
      if (scale <= 1.0001) continue;
      const origin = clickToCanvas(zoom, card);
      return { scale, ox: origin.x, oy: origin.y };
    }
  }
  return { scale: 1, ox: center.x, oy: center.y };
}

// Flatten all VO segments into absolute-timed phrases (split on >0.6s gaps). Each
// word time is offset by its step's start on the OUTPUT timeline.
function buildPhrases(manifest, windows, maxWords) {
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
      if (cur.length >= maxWords) flush();
      else if (cur.length && w.start - cur[cur.length - 1].end > 0.6) flush();
      cur.push(w);
    }
    flush();
  }
  return phrases;
}

// Cursor samples are on the recording clock; map each into its step's output
// window (the outClicks mapping) so steps stay independent and a freeze-hold
// holds the last position instead of sliding toward the next step.
function buildCursorTrack(samples, windows) {
  const pts = (samples || []).filter((p) => p && Number.isFinite(p.t));
  if (!pts.length) return null;
  let carry = null;
  return windows.map((w) => {
    const keys = [];
    let seed = carry;
    for (const p of pts) {
      if (p.t <= w.recStart) seed = { x: p.x, y: p.y };
      else if (p.t <= w.recEnd) keys.push({ t: w.startSec + (p.t - w.recStart), x: p.x, y: p.y });
    }
    if (seed) keys.unshift({ t: w.startSec, x: seed.x, y: seed.y });
    if (keys.length) carry = { x: keys[keys.length - 1].x, y: keys[keys.length - 1].y };
    return { startSec: w.startSec, endSec: w.endSec, keys };
  });
}

function sampleCursor(track, tSec) {
  if (!track || !track.length) return null;
  let step = track.find((s) => tSec >= s.startSec && tSec < s.endSec);
  if (!step) step = tSec < track[0].startSec ? track[0] : track[track.length - 1];
  const keys = step.keys;
  if (!keys.length) return null;
  const t = Math.min(Math.max(tSec, step.startSec), step.endSec);
  if (t <= keys[0].t) return keys[0];
  const last = keys[keys.length - 1];
  if (t >= last.t) return last;
  for (let i = 1; i < keys.length; i++) {
    const b = keys[i];
    if (t > b.t) continue;
    const a = keys[i - 1];
    const span = b.t - a.t;
    if (span <= 0) return b;
    // Samples are dense enough that the motion easing is already baked into them.
    const p = (t - a.t) / span;
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
  }
  return last;
}

// Drawn in CAPTURE space: both formats wrap this in the transform that maps the
// capture onto the canvas, so the arrow lands exactly where the page saw it.
const CursorLayer = ({ track, clicks, t }) => {
  const p = sampleCursor(track, t);
  return (
    <>
      {clicks.map((c, i) => {
        const age = t - c.t;
        if (age < 0 || age > RIPPLE_S) return null;
        const k = 1 - Math.pow(1 - age / RIPPLE_S, 3);
        return (
          <div
            key={i}
            style={{
              position: "absolute",
              left: c.x,
              top: c.y,
              width: 16,
              height: 16,
              margin: "-8px 0 0 -8px",
              borderRadius: "50%",
              border: "2px solid rgba(40,120,255,0.9)",
              boxSizing: "border-box",
              transform: `scale(${0.3 + 2.3 * k})`,
              opacity: 0.9 * (1 - k),
            }}
          />
        );
      })}
      {p ? (
        <div
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            width: 24,
            height: 24,
            transform: `translate(${p.x - 1}px, ${p.y - 1}px)`,
          }}
        >
          <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            style={{
              display: "block",
              overflow: "visible",
              filter: "drop-shadow(0 1px 1.5px rgba(0,0,0,.4))",
            }}
          >
            <path
              d={CURSOR_PATH}
              fill="#fff"
              stroke="#000"
              strokeWidth="1.3"
              strokeLinejoin="round"
            />
          </svg>
        </div>
      ) : null}
    </>
  );
};

const WIDE_CAPTION = {
  fontSize: 34,
  paddingBottom: 44,
  maxWidth: 1280,
  padding: "16px 30px",
  borderRadius: 20,
  gap: "0 11px",
  spokenWeight: 600,
  restWeight: 500,
};

const VERTICAL_CAPTION = {
  fontSize: 58,
  paddingBottom: 140,
  maxWidth: 940,
  padding: "20px 32px",
  borderRadius: 24,
  gap: "0 18px",
  spokenWeight: 700,
  restWeight: 600,
};

const CaptionBand = ({ phrases, t, tokens }) => {
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
        paddingBottom: tokens.paddingBottom,
      }}
    >
      <div
        style={{
          opacity,
          maxWidth: tokens.maxWidth,
          display: "flex",
          flexWrap: "wrap",
          justifyContent: "center",
          gap: tokens.gap,
          padding: tokens.padding,
          borderRadius: tokens.borderRadius,
          background: "rgba(16,16,22,0.86)",
          border: "1px solid rgba(255,255,255,0.10)",
          boxShadow: "0 14px 46px rgba(0,0,0,0.42)",
          fontFamily: FONT,
          fontSize: tokens.fontSize,
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
                fontWeight: spoken ? tokens.spokenWeight : tokens.restWeight,
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
  const { fps } = useVideoConfig();
  if (!title) return null;
  const t = frame / fps;
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

// Vertical opener: the payoff line over a scrim, footage already playing under it.
const HookCard = ({ hook, t }) => {
  if (!hook || t > HOOK_S) return null;
  const opacity = interpolate(t, [0, 0.25, HOOK_S - 0.3, HOOK_S], [0, 1, 1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  if (opacity <= 0) return null;
  const y = interpolate(t, [0, 0.25], [18, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        opacity,
        background: SCRIM,
        justifyContent: "center",
        alignItems: "center",
        padding: "0 70px",
      }}
    >
      <div
        style={{
          transform: `translateY(${y}px)`,
          textAlign: "center",
          color: "#fff",
          fontFamily: FONT,
          fontSize: 84,
          fontWeight: 700,
          lineHeight: 1.1,
          letterSpacing: "-0.02em",
        }}
      >
        {hook}
      </div>
    </AbsoluteFill>
  );
};

// Vertical closer: holds over the last CTA_S seconds of the freeze.
const CtaCard = ({ cta, t, durSec }) => {
  if (!cta || !cta.text) return null;
  const start = durSec - CTA_S;
  if (t < start) return null;
  const opacity = interpolate(t, [start, start + 0.25], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  const y = interpolate(t, [start, start + 0.25], [18, 0], {
    easing: Easing.out(Easing.cubic),
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });
  return (
    <AbsoluteFill
      style={{
        opacity,
        background: SCRIM,
        justifyContent: "center",
        alignItems: "center",
        padding: "0 70px",
      }}
    >
      <div style={{ transform: `translateY(${y}px)`, textAlign: "center", fontFamily: FONT }}>
        <div
          style={{
            color: "#fff",
            fontSize: 64,
            fontWeight: 700,
            lineHeight: 1.15,
            letterSpacing: "-0.02em",
          }}
        >
          {cta.text}
        </div>
        {cta.url ? (
          <div
            style={{
              marginTop: 26,
              color: "rgba(255,255,255,0.78)",
              fontSize: 40,
              fontWeight: 500,
            }}
          >
            {cta.url}
          </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};

// One step → a play Sequence (its recorded slice at 1x) then, when the window
// outlasts the capture, a freeze Sequence holding the slice's last frame. The
// window is a max() so the played portion always fits; video is never sped up.
function StepVideo({ w, isLast, tailS, videoStyle }) {
  const { fps } = useVideoConfig();
  const src = staticFile("video.mp4");
  const fill = videoStyle || { width: "100%", height: "100%", objectFit: "cover" };
  const tail = isLast ? Math.round(tailS * fps) : 0;
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

export const SpoolComposition = ({
  timeline,
  manifest,
  title,
  background,
  format,
  vertical,
}) => {
  const frame = useCurrentFrame();
  const { fps, width: canvasW, height: canvasH, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const isVertical = format === "vertical";
  const durSec = durationInFrames / fps;

  const card = cardLayout(timeline?.viewport, canvasW, canvasH);
  const viewport = { width: card.vw, height: card.vh };
  const { windows } = React.useMemo(
    () => buildWindows(timeline, manifest || { segments: [] }, fps),
    [timeline, manifest, fps]
  );
  // getZoom expects {zoom,clicks,start,end}; feed it output-clock values.
  const zoomSteps = React.useMemo(
    () => windows.map((w) => ({ zoom: w.zoom, clicks: w.outClicks, start: w.startSec, end: w.endSec })),
    [windows]
  );
  const zoom = isVertical ? null : getZoom(t, zoomSteps, card, canvasW, canvasH);
  const camTrack = React.useMemo(
    () => (isVertical ? buildCameraTrack(windows, viewport) : null),
    [isVertical, windows, card.vw, card.vh]
  );
  const cam = isVertical ? sampleCamera(camTrack, t, viewport) : null;
  const phrases = React.useMemo(
    () => buildPhrases(manifest || { segments: [] }, windows, isVertical ? 4 : 6),
    [manifest, windows, isVertical]
  );
  // VO intervals on the output clock, used to duck the music bed under speech.
  const speechWindows = React.useMemo(() => {
    const startByIndex = new Map(windows.map((w) => [w.i, w.startSec]));
    return (manifest?.segments || []).map((seg) => {
      const start = startByIndex.get(seg.i) ?? 0;
      return { start, end: start + (seg.duration || 0) };
    });
  }, [manifest, windows]);

  // Absent on takes recorded with a visible overlay (and on every pre-cursor
  // workdir), which is what keeps those renders untouched.
  const cursorTrack = React.useMemo(
    () => buildCursorTrack(timeline?.cursor, windows),
    [timeline, windows]
  );
  const rippleClicks = React.useMemo(
    () => (cursorTrack ? windows.flatMap((w) => w.outClicks || []) : []),
    [cursorTrack, windows]
  );
  const cursor = cursorTrack ? (
    <CursorLayer track={cursorTrack} clicks={rippleClicks} t={t} />
  ) : null;

  const tailS = TAIL_S + (isVertical ? CTA_S : 0);
  const videoStyle = isVertical
    ? { width: card.vw, height: card.vh, objectFit: "cover" }
    : undefined;
  const stepVideos = windows.map((w, idx) => (
    <StepVideo
      key={w.i}
      w={w}
      isLast={idx === windows.length - 1}
      tailS={tailS}
      videoStyle={videoStyle}
    />
  ));

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

      {isVertical ? (
        // Virtual camera: the capture sits at native size inside a fixed stage and
        // is panned/scaled as one transform. Captions and cards stay outside it.
        <div
          style={{
            position: "absolute",
            left: STAGE.x,
            top: STAGE.y,
            width: STAGE.w,
            height: STAGE.h,
            borderRadius: 28,
            overflow: "hidden",
            background: "#000",
            boxShadow: CARD_SHADOW,
          }}
        >
          <div
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              width: card.vw,
              height: card.vh,
              transform: `translate(${cam.tx}px, ${cam.ty}px) scale(${cam.s})`,
              transformOrigin: "0 0",
            }}
          >
            {stepVideos}
            {cursor}
          </div>
        </div>
      ) : (
        /* Zoom wrapper: scales the card about the click origin. Captions and the
           background stay outside it so only the recording zooms. */
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
              boxShadow: CARD_SHADOW,
            }}
          >
            {stepVideos}
            {cursor ? (
              // Capture space -> card space, so the arrow scales with the page.
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: card.vw,
                  height: card.vh,
                  transform: `scale(${card.scale})`,
                  transformOrigin: "0 0",
                }}
              >
                {cursor}
              </div>
            ) : null}
          </div>
        </AbsoluteFill>
      )}

      {isVertical ? null : (
        <TitleSubtitle
          title={title}
          frame={frame}
          firstCaptionStart={phrases.length ? phrases[0].start : null}
        />
      )}
      <CaptionBand
        phrases={phrases}
        t={t}
        tokens={isVertical ? VERTICAL_CAPTION : WIDE_CAPTION}
      />

      {isVertical ? (
        <>
          <HookCard hook={vertical?.hook} t={t} />
          <CtaCard cta={vertical?.cta} t={t} durSec={durSec} />
        </>
      ) : null}

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

      {isVertical && vertical?.music ? (
        // "extend" keeps the volume callback on the composition clock across loops.
        <Audio
          src={staticFile(vertical.music)}
          loop
          loopVolumeCurveBehavior="extend"
          volume={(f) => duckedMusicVolume(f / fps, speechWindows, durSec)}
        />
      ) : null}
    </AbsoluteFill>
  );
};
