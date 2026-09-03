// The layout, zoom, caption and cursor math for a take. Ported out of the React
// composition this engine replaced, so it stays plain JS with no browser needed.
import { TAIL_S } from "../retime.mjs";
import { CTA_S, HOOK_S } from "../vertical.mjs";

export const PAD_X = 40;
export const PAD_TOP = 24;
export const CAPTION_BAND = 92;

export const FONT =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Helvetica, Arial, sans-serif';

// The same stack for an HTML style="" attribute: a double quote there would close
// the attribute and silently drop every declaration after font-family.
export const FONT_CSS = FONT.replace(/"/g, "'");

export const CARD_SHADOW =
  "0 0 0 1px rgba(255,255,255,0.06), 0 8px 24px rgba(0,0,0,0.45), 0 40px 90px -24px rgba(0,0,0,0.6)";

export const SCRIM = "rgba(10,10,16,0.55)";

export const CURSOR_PATH = "M2,1 L2,20 L7,15.4 L10.1,22.3 L13,21 L9.9,14.2 L16,14.2 Z";
export const RIPPLE_S = 0.5;

export const CARD_RADIUS = 16;
export const STAGE_RADIUS = 28;

export const WIDE_CAPTION = {
  fontSize: 34,
  paddingBottom: 44,
  maxWidth: 1280,
  padding: "16px 30px",
  borderRadius: 20,
  gap: "0 11px",
  spokenWeight: 600,
  restWeight: 500,
};

export const VERTICAL_CAPTION = {
  fontSize: 58,
  paddingBottom: 140,
  maxWidth: 940,
  padding: "20px 32px",
  borderRadius: 24,
  gap: "0 18px",
  spokenWeight: 700,
  restWeight: 600,
};

export const easeOutCubic = (p) => 1 - Math.pow(1 - p, 3);
export const easeInCubic = (p) => p * p * p;

// Remotion's interpolate with extrapolate:"clamp": easing applies to the progress
// inside the matched segment, not across the whole range.
export function interp(t, inp, out, ease) {
  if (t <= inp[0]) return out[0];
  const n = inp.length;
  if (t >= inp[n - 1]) return out[n - 1];
  for (let i = 1; i < n; i++) {
    if (t > inp[i]) continue;
    const a = inp[i - 1];
    const b = inp[i];
    const p = b === a ? 1 : (t - a) / (b - a);
    const e = ease ? ease(p) : p;
    return out[i - 1] + (out[i] - out[i - 1]) * e;
  }
  return out[n - 1];
}

export function cardLayout(viewport, canvasW, canvasH, bounds = null) {
  const vw = viewport?.width ?? 1600;
  const vh = viewport?.height ?? 900;
  const availW = bounds ? bounds.width : canvasW - 2 * PAD_X;
  const availH = bounds ? bounds.height : canvasH - PAD_TOP - CAPTION_BAND;
  const scale = Math.min(availW / vw, availH / vh);
  const w = vw * scale;
  const h = vh * scale;
  const x = bounds ? bounds.x + (bounds.width - w) / 2 : (canvasW - w) / 2;
  const y = bounds ? bounds.y + (bounds.height - h) / 2 : PAD_TOP + (availH - h) / 2;
  return { vw, vh, scale, w, h, x, y };
}

export function clickToCanvas(click, card) {
  return { x: card.x + click.x * card.scale, y: card.y + click.y * card.scale };
}

const ZOOM_FILL = 0.62;
const ZOOM_MIN = 1.08;
const ZOOM_MAX = 2;

export function fitScale(zoom, card) {
  if (zoom.scale) return zoom.scale;
  if (!zoom.w || !zoom.h) return 1.35;
  const fit = Math.min((card.vw * ZOOM_FILL) / zoom.w, (card.vh * ZOOM_FILL) / zoom.h);
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, fit));
}

/**
 * The zoom envelope for one wide step, in absolute output seconds, or null when the
 * step never leaves scale 1. Mirrors getZoom's per-step branches.
 */
export function stepEnvelope(step, card) {
  const zoom = step.zoom;
  if (!zoom || zoom === "none") return null;
  const end = step.end - 0.15;
  if (end <= step.start) return null;

  if (zoom === "auto") {
    const clicks = step.clicks || [];
    if (!clicks.length) return null;
    const t0 = clicks[0].t;
    const start = Math.max(step.start, t0 - 0.5);
    if (start >= end) return null;
    const holdEnd = Math.max(t0 + 0.8, end - 0.5);
    const origin = clickToCanvas(clicks[0], card);
    return { start, peakAt: t0, holdEnd, end, peak: 1.35, ox: origin.x, oy: origin.y };
  }

  if (typeof zoom === "object" && zoom.x != null && zoom.y != null) {
    const start = step.start;
    const peakAt = start + 0.6;
    const holdEnd = Math.max(peakAt, end - 0.5);
    const origin = clickToCanvas(zoom, card);
    return { start, peakAt, holdEnd, end, peak: fitScale(zoom, card), ox: origin.x, oy: origin.y };
  }
  return null;
}

function envelopeScale(env, t) {
  if (t <= env.start || t >= env.end) return 1;
  if (t < env.peakAt) return interp(t, [env.start, env.peakAt], [1, env.peak], easeOutCubic);
  if (t <= env.holdEnd) return env.peak;
  return interp(t, [env.holdEnd, env.end], [env.peak, 1], easeInCubic);
}

/**
 * Wide zoom at time t: {scale, ox, oy}. getZoom returns the first step whose
 * envelope is live, and rests at scale 1 with the canvas centre as origin.
 */
export function zoomAt(envelopes, t, canvasW, canvasH) {
  for (const env of envelopes) {
    if (!env) continue;
    if (t <= env.start || t >= env.end) continue;
    const scale = envelopeScale(env, t);
    if (scale <= 1.0001) continue;
    return { scale, ox: env.ox, oy: env.oy };
  }
  return { scale: 1, ox: canvasW / 2, oy: canvasH / 2 };
}

export function buildPhrases(manifest, windows, maxWords) {
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
      phrases.push({ words: cur, start: cur[0].start, end: cur[cur.length - 1].end });
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

const CAPTION_FADE = 0.15;

// {phrase, index, opacity, spoken[]} for the phrase CaptionBand would show, else null.
export function captionAt(phrases, t) {
  for (let i = 0; i < phrases.length; i++) {
    const p = phrases[i];
    const showStart = p.start - CAPTION_FADE;
    const next = phrases[i + 1];
    const hardEnd = next ? Math.min(p.end + 0.35, next.start) : p.end + 0.35;
    if (t < showStart || t > hardEnd + CAPTION_FADE) continue;
    const fin = interp(t, [showStart, p.start], [0, 1]);
    const fout = interp(t, [hardEnd, hardEnd + CAPTION_FADE], [1, 0]);
    return {
      index: i,
      phrase: p,
      opacity: Math.min(fin, fout),
      spoken: p.words.map((w) => t >= w.start && t <= w.end),
    };
  }
  return null;
}

// {opacity, dy} for TitleSubtitle, or null once it has cleared.
export function titleAt(t, firstCaptionStart) {
  const rawEnd = firstCaptionStart != null ? firstCaptionStart - 0.15 : 1.4;
  const end = Math.max(0.7, Math.min(rawEnd, 1.8));
  const opacity = interp(t, [0, 0.3, end - 0.2, end], [0, 1, 1, 0]);
  if (opacity <= 0) return null;
  return { opacity, dy: interp(t, [0, 0.3], [10, 0], easeOutCubic) };
}

export function hookAt(t) {
  if (t > HOOK_S) return null;
  const opacity = interp(t, [0, 0.25, HOOK_S - 0.3, HOOK_S], [0, 1, 1, 0]);
  if (opacity <= 0) return null;
  return { opacity, dy: interp(t, [0, 0.25], [18, 0], easeOutCubic) };
}

export function ctaAt(t, durSec) {
  const start = durSec - CTA_S;
  if (t < start) return null;
  return {
    opacity: interp(t, [start, start + 0.25], [0, 1]),
    dy: interp(t, [start, start + 0.25], [18, 0], easeOutCubic),
  };
}

export function buildCursorTrack(samples, windows) {
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

export function sampleCursor(track, tSec) {
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
    const p = (t - a.t) / span;
    return { x: a.x + (b.x - a.x) * p, y: a.y + (b.y - a.y) * p };
  }
  return last;
}

// CursorLayer's ripple: scale 0.3..2.6 and fading, over RIPPLE_S from the click.
export function rippleAt(click, t) {
  const age = t - click.t;
  if (age < 0 || age > RIPPLE_S) return null;
  const k = 1 - Math.pow(1 - age / RIPPLE_S, 3);
  return { scale: 0.3 + 2.3 * k, opacity: 0.9 * (1 - k) };
}

// Output duration in frames, matching calculateSpoolMetadata.
export function durationFrames(totalFrames, fps, isVertical) {
  const tailS = TAIL_S + (isVertical ? CTA_S : 0);
  return Math.max(1, totalFrames + Math.round(tailS * fps));
}
