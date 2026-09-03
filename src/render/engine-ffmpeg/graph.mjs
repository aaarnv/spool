// The filtergraph. Footage is decoded once per step, retimed with tpad instead of a
// repainted still, and every time-varying transform is a sampled expression (see
// expr.mjs) so ffmpeg needs no per-frame reconfiguration.
import { STAGE } from "../vertical.mjs";
import { CURSOR_PAD } from "./assets.mjs";
import { fnExpr, framesToSpans, spansExpr } from "./expr.mjs";
import { RIPPLE_S, sampleCursor, zoomAt } from "./scene.mjs";

// zoompan resamples the whole frame per output frame; on rgba that is ~15x the cost
// of yuva420p for identical output, so the card layer stays planar.
const ZOOM_FMT = "yuva420p";

class Graph {
  constructor() {
    this.inputs = [];
    this.chains = [];
    this.n = 0;
  }
  input(args) {
    this.inputs.push(...args);
    return this.n++;
  }
  chain(s) {
    this.chains.push(s);
  }
  text() {
    return this.chains.join(";\n");
  }
}

const q = (e) => `'${e}'`;

/**
 * Ripple timing. Every click plays the same animation, so one state sequence is
 * repositioned by an expression; overlapping clicks keep the newest (a second
 * concurrent ring is not worth a second input).
 */
export function rippleSequence({ clicks, frames, fps, names, at }) {
  const entries = [];
  const live = [];
  const pos = new Array(frames);
  let run = null;
  let last = { x: 0, y: 0 };
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    let best = null;
    for (const c of clicks) {
      const age = t - c.t;
      if (age < 0 || age > RIPPLE_S) continue;
      if (!best || age < best.age) best = { age, c };
    }
    if (best) {
      live.push(f);
      last = at(best.c);
    }
    pos[f] = last;
    const file = best ? names[Math.min(names.length - 1, Math.round(best.age * fps))] : "ripple_off.png";
    if (run && run.file === file) run.frames++;
    else {
      if (run) entries.push(run);
      run = { file, frames: 1 };
    }
  }
  if (run) entries.push(run);
  const axis = (k) => (t) => pos[Math.max(0, Math.min(frames - 1, Math.floor(t * fps)))][k];
  return { entries, spans: framesToSpans(live, fps), x: axis("x"), y: axis("y") };
}

/** Where the cursor sprite's top-left sits, in the space the overlay draws into. */
export function cursorPos(track, scale) {
  const at = (t) => sampleCursor(track, t) || { x: 0, y: 0 };
  return {
    x: (t) => (at(t).x - 1 - CURSOR_PAD) * scale,
    y: (t) => (at(t).y - 1 - CURSOR_PAD) * scale,
  };
}

/** Per-step footage: the recorded slice, then tpad clones to fill the VO window. */
function footage(g, { videoPath, windows, fps, tailFrames }) {
  const labels = [];
  windows.forEach((w, idx) => {
    const tail = idx === windows.length - 1 ? tailFrames : 0;
    const total = w.windowFrames + tail;
    const pad = Math.max(0, total - w.recFrames) + 4;
    const i = g.input([
      "-ss", (w.inF / fps).toFixed(4),
      "-t", (w.recFrames / fps + 1).toFixed(4),
      "-i", videoPath,
    ]);
    const l = `f${idx}`;
    g.chain(
      `[${i}:v]setpts=PTS-STARTPTS,fps=${fps},trim=end_frame=${w.recFrames},setpts=PTS-STARTPTS,` +
        `tpad=stop=${pad}:stop_mode=clone,trim=end_frame=${total},setpts=PTS-STARTPTS[${l}]`
    );
    labels.push(`[${l}]`);
  });
  if (labels.length === 1) g.chain(`${labels[0]}null[vall]`);
  else g.chain(`${labels.join("")}concat=n=${labels.length}:v=1:a=0[vall]`);
  return "vall";
}

function sprites(g, ctx, main, scale) {
  const { fps, durSec, durationFrames } = ctx;
  let cur = main;
  if (ctx.assets.cursor && ctx.cursorTrack) {
    const visible = [];
    for (let f = 0; f < durationFrames; f++) if (sampleCursor(ctx.cursorTrack, f / fps)) visible.push(f);
    if (visible.length) {
      const i = g.input(["-framerate", String(fps), "-loop", "1", "-i", ctx.assets.cursor]);
      const p = cursorPos(ctx.cursorTrack, scale);
      const spans = framesToSpans(visible, fps);
      const all = spans.length === 1 && spans[0][0] === 0 && spans[0][1] >= durSec - 1e-6;
      const out = "cur";
      g.chain(
        `[${cur}][${i}:v]overlay=x=${q(fnExpr(p.x, 0, durSec, fps, 0.04, "t"))}:y=${q(fnExpr(p.y, 0, durSec, fps, 0.04, "t"))}` +
          `:eof_action=pass${all ? "" : `:enable='${spansExpr(spans)}'`}[${out}]`
      );
      cur = out;
    }
  }
  if (ctx.ripple) {
    const i = g.input(["-f", "concat", "-safe", "0", "-i", ctx.ripple.list]);
    const out = "rip";
    g.chain(
      `[${i}:v]fps=${fps},setpts=PTS-STARTPTS[rl];` +
        `[${cur}][rl]overlay=x=${q(fnExpr(ctx.ripple.x, 0, durSec, fps, 0.4, "t"))}:y=${q(fnExpr(ctx.ripple.y, 0, durSec, fps, 0.4, "t"))}` +
        `:eof_action=pass:enable='${spansExpr(ctx.ripple.spans)}'[${out}]`
    );
    cur = out;
  }
  return cur;
}

/**
 * bg → chrome + footage (zoomed on wide, camera-cropped on vertical) → captions → cards.
 * With ctx.fgLayer the same layers are also composited onto a transparent canvas, so a
 * later background swap is one overlay pass instead of a re-render.
 */
export function buildGraph(ctx) {
  const g = new Graph();
  const { fps, canvasW, canvasH, durSec, isVertical, card } = ctx;

  const bgIdx = g.input(["-framerate", String(fps), "-loop", "1", "-i", ctx.assets.bg]);
  const chromeIdx = g.input(["-framerate", String(fps), "-loop", "1", "-i", ctx.assets.chrome]);
  const maskIdx = g.input(["-framerate", String(fps), "-loop", "1", "-i", ctx.assets.mask]);

  const vall = footage(g, ctx);
  let cardLayer;

  if (ctx.isPlan) {
    // No zoom and no camera: the footage sits in the layout's reserved rect and is
    // simply switched off for chapters whose visual is a card.
    g.chain(`[${vall}]scale=${Math.round(card.w)}:${Math.round(card.h)}:flags=bicubic,setsar=1[vs]`);
    const withSprites = sprites(g, ctx, "vs", card.scale);
    g.chain(`[${maskIdx}:v]format=gray[mk];[${withSprites}][mk]alphamerge,format=${ZOOM_FMT}[vsm]`);
    g.chain(
      `[${chromeIdx}:v]format=${ZOOM_FMT}[chr];[chr][vsm]overlay=${Math.round(card.x)}:${Math.round(card.y)}:shortest=1[cardl]`
    );
    cardLayer = "cardl";
  } else if (isVertical) {
    const vw = Math.round(card.vw);
    const vh = Math.round(card.vh);
    const padH = Math.round((vw * STAGE.h) / STAGE.w);
    const padY = Math.round((padH - vh) / 2);
    g.chain(`[${vall}]scale=${vw}:${vh}:flags=bicubic,setsar=1[vs]`);
    const withSprites = sprites(g, ctx, "vs", 1);
    g.chain(`[${withSprites}]pad=${vw}:${padH}:0:${padY}:color=black,format=yuv420p[vp]`);
    const cam = ctx.sampleCam;
    const T = `(on/${fps})`;
    g.chain(
      `[vp]zoompan=z=${q(fnExpr((t) => (vw * cam(t).s) / STAGE.w, 0, durSec, fps, 0.0008, T))}:` +
        `x=${q(fnExpr((t) => -cam(t).tx / cam(t).s, 0, durSec, fps, 0.05, T))}:` +
        `y=${q(fnExpr((t) => padY - cam(t).ty / cam(t).s, 0, durSec, fps, 0.05, T))}:` +
        `d=1:s=${STAGE.w}x${STAGE.h}:fps=${fps}[cam]`
    );
    g.chain(`[${maskIdx}:v]format=gray[mk];[cam][mk]alphamerge,format=${ZOOM_FMT}[camm]`);
    g.chain(`[${chromeIdx}:v]format=${ZOOM_FMT}[chr];[chr][camm]overlay=${STAGE.x}:${STAGE.y}:shortest=1[cardl]`);
    cardLayer = "cardl";
  } else {
    // The card layer is built at the peak zoom so the footage is upscaled once, the
    // way a CSS transform does it; zoompan then only ever downsamples.
    const ss = ctx.superSample;
    g.chain(`[${vall}]scale=${Math.round(card.w * ss)}:${Math.round(card.h * ss)}:flags=bicubic,setsar=1[vs]`);
    const withSprites = sprites(g, ctx, "vs", card.scale * ss);
    g.chain(`[${maskIdx}:v]format=gray[mk];[${withSprites}][mk]alphamerge,format=${ZOOM_FMT}[vsm]`);
    g.chain(
      `[${chromeIdx}:v]format=${ZOOM_FMT}[chr];[chr][vsm]overlay=${Math.round(card.x * ss)}:${Math.round(card.y * ss)}:shortest=1[cardl]`
    );
    cardLayer = "cardl";
    if (ctx.envelopes.some(Boolean)) {
      const zf = (t) => zoomAt(ctx.envelopes, t, canvasW, canvasH);
      const T = `(on/${fps})`;
      g.chain(
        `[cardl]zoompan=z=${q(fnExpr((t) => zf(t).scale, 0, durSec, fps, 0.0004, T))}:` +
          `x=${q(fnExpr((t) => ss * zf(t).ox * (1 - 1 / zf(t).scale), 0, durSec, fps, 0.05, T))}:` +
          `y=${q(fnExpr((t) => ss * zf(t).oy * (1 - 1 / zf(t).scale), 0, durSec, fps, 0.05, T))}:` +
          `d=1:s=${canvasW}x${canvasH}:fps=${fps}[cardz]`
      );
      cardLayer = "cardz";
    }
  }

  const mediaOn = ctx.isPlan ? `:enable='${spansExpr(ctx.planMediaSpans)}'` : "";

  // The alpha branch forks here: everything downstream of the wallpaper is drawn a
  // second time onto a transparent canvas of the same size.
  let mainCard = cardLayer;
  let fg = null;
  if (ctx.fgLayer) {
    // The card layer is already a full-canvas yuva420p frame, so it IS the alpha base;
    // a synthesised transparent source loses its alpha in format negotiation.
    g.chain(`[${cardLayer}]split=2[cdm][cdf]`);
    mainCard = "cdm";
    fg = "cdf";
  }
  g.chain(`[${bgIdx}:v]format=yuv420p[bgf];[bgf][${mainCard}]overlay=0:0:shortest=1${mediaOn}[stage]`);

  let out = "stage";
  // One concat-driven layer, overlaid on the flattened stack and (when forked) on the
  // transparent one. `format=yuv420` keeps the alpha branch planar with alpha.
  const layer = (list, x, y, tag) => {
    const i = g.input(["-f", "concat", "-safe", "0", "-i", list]);
    g.chain(`[${i}:v]fps=${fps},setpts=PTS-STARTPTS[${tag}l]`);
    let main = `${tag}l`;
    if (fg) {
      g.chain(`[${tag}l]split=2[${tag}a][${tag}b]`);
      main = `${tag}a`;
    }
    g.chain(`[${out}][${main}]overlay=${x}:${y}:eof_action=pass[${tag}m]`);
    out = `${tag}m`;
    if (fg) {
      g.chain(`[${fg}][${tag}b]overlay=${x}:${y}:eof_action=pass:format=yuv420[${tag}f]`);
      fg = `${tag}f`;
    }
  };
  if (ctx.assets.planList) layer(ctx.assets.planList, 0, 0, "pl");
  if (ctx.assets.captionList) layer(ctx.assets.captionList, ctx.captionClip.x, ctx.captionClip.y, "cap");
  if (ctx.assets.overlayList) layer(ctx.assets.overlayList, 0, 0, "ov");

  const half = ctx.previewScale
    ? `,scale=${Math.round((canvasW * ctx.previewScale) / 2) * 2}:${Math.round((canvasH * ctx.previewScale) / 2) * 2}`
    : "";
  g.chain(`[${out}]format=yuv420p${half}[vout]`);
  if (fg) g.chain(`[${fg}]format=${ZOOM_FMT}[fgout]`);
  return { g, video: "[vout]", fgVideo: fg ? "[fgout]" : null };
}
