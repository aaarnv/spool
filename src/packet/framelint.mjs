#!/usr/bin/env node
// Frame lint: the gate that looks at the rendered pixels.
//
// Every other gate in this pipeline judges a spec. diaglint reads coordinates,
// sloplint reads words, and both pass a diagram that renders as a labelled black
// rectangle on stock footage — which is exactly what the audited recaps are. The
// mockup lane already solved this at src/packet/author.mjs: it screenshots inside the
// gate loop, because the findings that matter do not exist until something has drawn
// the spec. This is that reasoning applied to the video.
//
// The empty-box check needs nothing but the MP4: a panel is filled rgba(8,10,14,.86),
// so it is the one thing in the frame guaranteed darker than everything drawn on it,
// and the boxes can be found by flood fill and judged on the ink inside them. That is
// what lets this be pointed at a video that shipped months ago.
//
// The other three checks need the workdir, and they need it for a reason worth stating:
// a caption word, a label and an arrow are all thin bright marks over bright footage,
// and no threshold separates them from a knife blade or a lit background. So they are
// measured where the comp says they were drawn — the word boxes from the timeline, the
// label boxes from layout.mjs — and the pixels only answer what is BEHIND them.
//
// Importable as lintFrames(); as a CLI: framelint.mjs <video.mp4> [workdir] [--keep dir]
import { execFile } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadImage, Canvas } from 'skia-canvas';

const run = promisify(execFile);

/** Frames pulled out of the render. Five is what the audit read by hand. */
export const SAMPLES = 5;

// The comp's own geometry (docs/video/comp/skia/scene-auto.mjs), in CSS units. Every
// device-pixel number below is derived from the frame's real width, so a render at
// another scale still lands on the same regions.
const COMP_W = 540, COMP_H = 960;
const DIAG_X = 30, DIAG_Y = 170, DIAG_W = 480, DIAG_H = 480;
const CAP_SIZE = 30, CAP_LH = CAP_SIZE * 1.25, CAP_W = COMP_W - 48, CAP_BOTTOM = COMP_H - 110;

// A panel is filled rgba(8,10,14,.86), so whatever footage is under it lands below
// this luminance and every diagram stroke and glyph lands well above it.
const PANEL_LUM = 55;
const INK_LUM = 100;
// Fraction of a box's body that must be ink before the box counts as carrying
// something. One short badge line measures near 3%; an empty box measures zero.
const MIN_BODY_INK = 0.004;
// A mark has to clear its own backdrop by this much to count as drawn: an absolute
// step for a dark plate, or a ratio for a bright one, whichever is larger. Measured on
// the Terminal ground, where a plate reads near 27 and a glyph near 185.
const INK_OVER_GROUND = 18, INK_RATIO = 1.6;
// How far a panel's border must stand above its own fill before the panel counts as
// drawn on this frame. Measured on the Terminal ground: a drawn box reads border 48
// against plate 27, and a box the animation has not revealed reads 21 against 22.
const BORDER_STEP = 10;
// Smallest panel worth judging, in CSS px. The prompt's floor for a content box is
// 150x100, and a `phone` is 110x125.
const MIN_PANEL_W = 100, MIN_PANEL_H = 70;
// How rectangular a dark region has to be before it is treated as a drawn panel
// rather than a dark patch of footage.
const MIN_FILL = 0.8;
// Contrast an unspoken caption word should clear against what is actually behind it.
// scene-auto.mjs draws those at 45% alpha, which is the number blended below. This one
// only ever WARNS: the fix is in the comp (raise the alpha, or put a scrim under the
// block), and a gate that blocks on something the author cannot redraw is a deadlock.
const UNSPOKEN_ALPHA = 0.45;
const MIN_CONTRAST = 3;

const lum = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
/** Luminance at a pixel, clamped to the frame so a border sample never wraps a row. */
const at = (f, x, y) => f.L[Math.min(f.h - 1, Math.max(0, y)) * f.w + Math.min(f.w - 1, Math.max(0, x))];
const chan = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const relLum = (r, g, b) => 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** The frame as half-scale luminance plus the RGB it came from. */
async function readFrame(png) {
  const img = await loadImage(png);
  const w = Math.round(img.width / 2), h = Math.round(img.height / 2);
  const c = new Canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  const L = new Float32Array(w * h);
  for (let i = 0; i < L.length; i++) L[i] = lum(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  // scale takes CSS units to this half-scale grid: a 1080-wide frame gives 1.
  return { w, h, L, rgb: data, scale: w / COMP_W };
}

/**
 * Median luminance of a rectangle, sampled on a stride.
 *
 * This is the "ground tile" every relative measurement is taken against: a panel's own
 * backdrop, read next to the panel rather than assumed from a constant.
 */
function medianLum(f, x, y, w, h, step = 2) {
  const s = [];
  const x1 = Math.min(f.w, x + w), y1 = Math.min(f.h, y + h);
  for (let j = Math.max(0, y); j < y1; j += step) {
    for (let i = Math.max(0, x); i < x1; i += step) s.push(f.L[j * f.w + i]);
  }
  if (!s.length) return 0;
  s.sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * Ink inside a box the renderer told us about, measured against that box's own ground.
 *
 * The absolute INK_LUM floor only works over bright footage. On the Terminal ground a
 * label is drawn at #D6DBD8 over a plate sitting around 27, so the mark is enormous in
 * CONTRAST and tiny in absolute terms. Read the plate's own level from the box, then
 * count what rises clear of it. Both grounds satisfy this; neither needs a look flag.
 */
function inkOverGround(f, r) {
  const x = Math.round(r.x * f.scale), y = Math.round(r.y * f.scale);
  const w = Math.round(r.w * f.scale), h = Math.round(r.h * f.scale);
  const pad = Math.max(3, Math.round(Math.min(w, h) * 0.12));
  const ix = x + pad, iy = y + pad, iw = w - 2 * pad, ih = h - 2 * pad;
  if (iw < 6 || ih < 6) return null;
  // The plate itself: the interior's own median. Text is a minority of a box's area,
  // so the median lands on the fill and not on the glyphs.
  const plate = medianLum(f, ix, iy, iw, ih, 1);
  const floor = Math.max(plate + INK_OVER_GROUND, plate * INK_RATIO);
  let n = 0, tot = 0;
  for (let j = iy; j < iy + ih; j++) {
    for (let i = ix; i < ix + iw; i++) {
      if (i < 0 || j < 0 || i >= f.w || j >= f.h) continue;
      tot++;
      if (f.L[j * f.w + i] > floor) n++;
    }
  }
  return tot ? n / tot : null;
}

/**
 * The dark rectangles the comp drew, found without being told where they are.
 *
 * Flood fill on the panel mask, then keep the components that are big enough and
 * rectangular enough to be a drawn panel. Only reachable with no comp beside the video,
 * which is the published-MP4 audit: those are footage-ground renders, where a panel is
 * the darkest thing in the frame. With a comp, the renderer names the boxes instead.
 */
function findPanels(f) {
  const x0 = Math.round(DIAG_X * f.scale), y0 = Math.round(DIAG_Y * f.scale);
  const x1 = Math.round((DIAG_X + DIAG_W) * f.scale), y1 = Math.round((DIAG_Y + DIAG_H) * f.scale);
  const seen = new Uint8Array(f.w * f.h);
  const out = [];
  const stack = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = y * f.w + x;
      if (seen[i] || f.L[i] >= PANEL_LUM) continue;
      let ax = x, ay = y, bx = x, by = y, area = 0;
      stack.push(i);
      seen[i] = 1;
      while (stack.length) {
        const p = stack.pop();
        const px = p % f.w, py = (p / f.w) | 0;
        area++;
        if (px < ax) ax = px; if (px > bx) bx = px;
        if (py < ay) ay = py; if (py > by) by = py;
        for (const q of [p - 1, p + 1, p - f.w, p + f.w]) {
          const qx = q % f.w, qy = (q / f.w) | 0;
          if (qx < x0 || qx >= x1 || qy < y0 || qy >= y1) continue;
          if (seen[q] || f.L[q] >= PANEL_LUM) continue;
          seen[q] = 1;
          stack.push(q);
        }
      }
      const w = bx - ax + 1, h = by - ay + 1;
      if (w < MIN_PANEL_W * f.scale || h < MIN_PANEL_H * f.scale) continue;
      if (area / (w * h) < MIN_FILL) continue;
      out.push({ x: ax, y: ay, w, h });
    }
  }
  return out;
}

/** Ink fraction of a rectangle, and where the ink sits. */
function inkOf(f, x, y, w, h) {
  let n = 0;
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) if (f.L[j * f.w + i] > INK_LUM) n++;
  }
  return n / Math.max(1, w * h);
}

/**
 * Boxes that hold nothing, measured rather than inferred.
 *
 * The interior is inset past the sketchy border, and then everything drawn on the
 * panel counts: a title seated inside it, a badge, a squiggle, an arrowhead. The
 * stricter half of the rule — that the content has to be a real ARTIFACT and not just
 * the box's own name again — is spec-shaped and lives in diaglint, because the pixels
 * cannot tell a name from a value.
 */
/**
 * Boxes the renderer placed, judged where it placed them.
 *
 * A box is only judged once it is actually on screen: shapes are revealed by the beat's
 * animation, and a panel that has not faded in yet is legitimately bare. Presence is the
 * plate standing clear of the ground just outside it, in either direction, so a dark
 * plate on footage and a light plate on the Terminal ground both register.
 */
function placedFindings(f, placed) {
  const out = [];
  placed.rects.forEach((r, i) => {
    const x = Math.round(r.x * f.scale), y = Math.round(r.y * f.scale);
    const w = Math.round(r.w * f.scale), h = Math.round(r.h * f.scale);
    if (w < MIN_PANEL_W * f.scale * 0.5 || h < MIN_PANEL_H * f.scale * 0.5) return;
    // Presence is the panel's own BORDER, not the ground beside it: a neighbouring
    // panel sits inside any ring wide enough to sample, which made a drawn box and a
    // bare one read the same. The border is a hairline the ground never has.
    const pad = Math.max(3, Math.round(Math.min(w, h) * 0.12));
    const plate = medianLum(f, x + pad, y + pad, w - 2 * pad, h - 2 * pad, 1);
    const edge = [];
    for (let i = x; i < x + w; i++) {
      for (const dy of [0, 1, -1]) { edge.push(at(f, i, y + dy)); edge.push(at(f, i, y + h + dy)); }
    }
    for (let j = y; j < y + h; j++) {
      for (const dx of [0, 1, -1]) { edge.push(at(f, x + dx, j)); edge.push(at(f, x + w + dx, j)); }
    }
    edge.sort((a, b) => a - b);
    const border = edge[edge.length >> 1];
    if (border < plate + BORDER_STEP) return; // not drawn yet on this frame
    const ink = inkOverGround(f, r);
    if (ink === null || ink >= MIN_BODY_INK) return;
    out.push(`box ${i + 1} (${Math.round(r.w)}x${Math.round(r.h)} at ${Math.round(r.x)},${Math.round(r.y)})`
      + ` in "${placed.beat}" is empty — ${(ink * 100).toFixed(2)}% of its interior is drawn on.`
      + ` Put a badge inside it carrying a real artifact from the change.`);
  });
  return out;
}

function emptyBoxFindings(f, panels) {
  const out = [];
  const css = (n) => Math.round(n / f.scale);
  panels.forEach((p, i) => {
    const pad = Math.max(8, Math.round(Math.min(p.w, p.h) * 0.12));
    const w = p.w - 2 * pad, h = p.h - 2 * pad;
    if (w < 8 || h < 8) return;
    const ink = inkOf(f, p.x + pad, p.y + pad, w, h);
    if (ink >= MIN_BODY_INK) return;
    out.push(`box ${i + 1} (${css(p.w)}x${css(p.h)} at ${css(p.x)},${css(p.y)}) is empty —`
      + ` ${(ink * 100).toFixed(2)}% of its interior is drawn on. Put a badge inside it carrying a real artifact from the change.`);
  });
  return out;
}

/**
 * Where the comp draws each caption word at time `t`, reproducing scene-auto.mjs.
 *
 * The alternative was to find the glyphs in the frame, which cannot be done: an
 * unspoken word at 45% white is dimmer than the knife blade behind it, so any
 * brightness threshold picks the footage and misses the text. Knowing where the word
 * IS turns the question into one the pixels can answer — what is behind it.
 */
function captionWords(ctx, capChunks, t) {
  let ci = capChunks.findIndex((c) => t < c[c.length - 1].end);
  if (ci === -1) ci = capChunks.length - 1;
  const chunk = capChunks[ci];
  if (!chunk) return [];
  ctx.font = `800 ${CAP_SIZE}px Arial, Helvetica, sans-serif`;
  const ws = chunk.map((w) => ctx.measureText(w.word).width);
  const spaceW = ctx.measureText(' ').width;
  const m = ctx.measureText('Hg');
  const A = Math.ceil(m.fontBoundingBoxAscent), Dn = Math.ceil(m.fontBoundingBoxDescent);

  const lines = []; let cur = [], acc = 0;
  chunk.forEach((_, i) => {
    if (cur.length && acc + spaceW + ws[i] > CAP_W) { lines.push({ idx: cur, w: acc }); cur = []; acc = 0; }
    acc += (cur.length ? spaceW : 0) + ws[i];
    cur.push(i);
  });
  if (cur.length) lines.push({ idx: cur, w: acc });

  const top = CAP_BOTTOM - lines.length * CAP_LH;
  const out = [];
  lines.forEach((ln, li) => {
    const y = top + li * CAP_LH + (CAP_LH - (A + Dn)) / 2 + A;
    let x = (COMP_W - ln.w) / 2;
    for (const i of ln.idx) {
      const cw = chunk[i];
      const said = t >= cw.end, now = !said && t >= cw.start;
      out.push({
        word: cw.word, x, y, w: ws[i], asc: A, desc: Dn,
        alpha: said || now ? 1 : UNSPOKEN_ALPHA,
        rgb: now ? [255, 209, 102] : [255, 255, 255],
      });
      x += ws[i] + spaceW;
    }
  });
  return out;
}

/**
 * Caption contrast, measured against what is really behind each word.
 *
 * The backdrop is the ring just outside the word's own box, which is where the comp's
 * drop shadow lands, so a caption the shadow saves is credited for it. The colour on
 * top is what scene-auto.mjs actually fills: white, or the spoken-word yellow, at that
 * word's own alpha. An unspoken word is 45% white, and over bright footage that is the
 * half of the line nobody can read.
 */
function captionFindings(f, words) {
  let worst = null;
  for (const w of words) {
    const x = Math.round((w.x - 2) * f.scale), y = Math.round((w.y - w.asc - 2) * f.scale);
    const bw = Math.round((w.w + 4) * f.scale), bh = Math.round((w.asc + w.desc + 4) * f.scale);
    const ring = Math.max(2, Math.round(3 * f.scale));
    const px = [];
    for (let j = y - ring; j < y + bh + ring; j++) {
      for (let i = x - ring; i < x + bw + ring; i++) {
        if (i >= x && i < x + bw && j >= y && j < y + bh) continue;
        if (i < 0 || j < 0 || i >= f.w || j >= f.h) continue;
        px.push(j * f.w + i);
      }
    }
    if (px.length < 40) continue;
    const med = (sel) => { const a = px.map(sel).sort((m, n) => m - n); return a[a.length >> 1]; };
    const bg = [med((k) => f.rgb[k * 4]), med((k) => f.rgb[k * 4 + 1]), med((k) => f.rgb[k * 4 + 2])];
    const on = bg.map((c, i) => w.alpha * w.rgb[i] + (1 - w.alpha) * c);
    const ratio = contrast(relLum(...on), relLum(...bg));
    if (!worst || ratio < worst.ratio) worst = { ratio, word: w.word, bg, alpha: w.alpha };
  }
  if (!worst || worst.ratio >= MIN_CONTRAST) return [];
  return [`the caption word "${worst.word}" is drawn at ${Math.round(worst.alpha * 100)}% over rgb(${worst.bg.join(',')})`
    + `, which is ${worst.ratio.toFixed(2)}:1 against its own background (floor ${MIN_CONTRAST}:1) — it is not readable on this frame`];
}

/**
 * Spec observations, reported as WARNINGS rather than findings.
 *
 * Every one of these is either structural and already caught by diaglint, which fails
 * the draft with a message the author can act on, or a placement layout.mjs now
 * guarantees. Blocking a finished render on them a second time buys nothing and costs
 * the whole video. The one thing this file still FAILS on is the empty box, measured
 * in the pixels, because that is the defect no spec check can see.
 *
 * layout.mjs lives under docs/video/comp, so it is imported only on the path that
 * already has a workdir beside a comp render.
 */
async function specFindings(diagrams) {
  const { resolveLabels } = await import(new URL('../../docs/video/comp/layout.mjs', import.meta.url).href);
  const out = [];
  const c = new Canvas(8, 8).getContext('2d');
  const measure = (text, size, weight) => {
    c.font = `${weight} ${size}px Arial, Helvetica, sans-serif`;
    const m = c.measureText(text);
    return { w: m.width, asc: Math.ceil(m.fontBoundingBoxAscent), desc: Math.ceil(m.fontBoundingBoxDescent) };
  };
  for (const e of diagrams || []) {
    const shapes = e?.diagram?.shapes;
    if (!shapes) continue;
    for (const s of shapes) {
      if (s.type !== 'arrow' && s.type !== 'wire') continue;
      for (const [k, v, hi] of [['x1', s.x1, DIAG_W], ['x2', s.x2, DIAG_W], ['y1', s.y1, DIAG_H], ['y2', s.y2, DIAG_H]]) {
        if (typeof v === 'number' && (v < 0 || v > hi)) {
          out.push(`[${e.beat}] "${s.id}" has ${k}=${v}, outside the ${DIAG_W}x${DIAG_H} band — the renderer clips it mid-stroke`);
        }
      }
    }
    for (const L of resolveLabels(shapes, measure)) {
      if (!L.host) {
        if (L.kind === 'note') out.push(`[${e.beat}] "${L.text}" is drawn on the background, not inside any box`);
        continue;
      }
      const r = L.host;
      const inside = L.left >= r.x - 2 && L.right <= r.x + r.w + 2 && L.top >= r.y - 2 && L.bot <= r.bot + 2;
      // A badge outside its box used to be a finding. It is not one any more: layout.mjs
      // fits a badge to its box (shrink, then middle-ellipsize) and never seats a hosted
      // note anywhere but the interior, so a badge landing outside is a layout defect
      // and no redraw of the spec would fix it. The empty box itself is still caught,
      // by the pixels, which is the check that actually reads what shipped.
      if (L.kind === 'note' && !inside) continue;
      const hugs = Math.abs(L.x - r.cx) <= r.w / 2 && L.bot >= r.y - 30 && L.top <= r.bot + 30;
      if (!inside && !hugs) out.push(`[${e.beat}] "${L.text}" lands at ${Math.round(L.x)},${Math.round(L.y)}, off the shape it names — give it room or shorten it`);
    }
  }
  return out;
}

// The caption chunker, straight out of scene-auto.mjs: 5 words, or a sentence end.
function chunksOf(beats) {
  const out = [];
  for (const b of beats) {
    let cur = [];
    for (const w of b.words || []) {
      cur.push(w);
      if (cur.length >= 5 || /[.!?…]$/.test(w.word)) { out.push(cur); cur = []; }
    }
    if (cur.length) out.push(cur);
  }
  return out;
}

/**
 * Lint the rendered video. Returns `{ findings, warnings, frames }`.
 *
 * `video` is the finished MP4. `workdir` is optional. With one, the caption check and
 * the two geometry checks run as well, because they need to know where the comp put
 * things; without one the empty-box check still runs on the pixels alone, which is how
 * this gets pointed at a video that shipped months ago.
 *
 * `findings` are what a redraw can fix and what the gate blocks on. `warnings` are real
 * defects whose fix lives in the comp, so they are reported and never block.
 */
export async function lintFrames({ video, workdir = null, samples = SAMPLES, keep = null, log = () => {} } = {}) {
  if (!video) throw new Error('lintFrames: video required');
  const probe = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', video]);
  const duration = Number(String(probe.stdout).trim());
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`framelint: cannot read a duration from ${video}`);

  let capChunks = null;
  let spec = null;
  let boxesAt = null;
  let midBeats = [];
  if (workdir) {
    try {
      const { loadTimeline } = await import(new URL('../../docs/video/comp/skia/timeline.mjs', import.meta.url).href);
      const tl = await loadTimeline(workdir);
      capChunks = chunksOf(tl.beats);
      spec = tl.diagrams;
      // The middle of every beat, which is the frame the even sampling kept missing.
      // A beat assembles inside its first 40%, so by half way a box that is on screen
      // and still bare is a real empty box and not an animation caught mid-reveal.
      midBeats = tl.beats.map((b) => +(b.start + b.duration * 0.5).toFixed(3));
      // The renderer names the boxes' on-screen positions, so the gate measures where
      // they really are instead of hunting for them in a ground it cannot separate.
      if (spec?.length) {
        const { panelRectsFor } = await import(new URL('../../docs/video/comp/skia/scene-auto.mjs', import.meta.url).href);
        const byBeat = new Map(spec.map((e) => [e.beat, e]));
        boxesAt = (t) => {
          const b = tl.beats.find((x) => t >= x.start && t < x.start + x.duration) ?? tl.beats.at(-1);
          const entry = b && byBeat.get(b.name);
          if (!entry) return null;
          const rects = panelRectsFor(entry);
          return rects.length ? { beat: b.name, rects } : null;
        };
      }
    } catch (e) { log(`framelint: no comp timeline beside the video (${e.message})`); }
  }
  const measurer = new Canvas(8, 8).getContext('2d');

  const dir = keep ? (await mkdir(keep, { recursive: true }), keep) : await mkdtemp(join(tmpdir(), 'spool-framelint-'));
  const findings = [];
  const warnings = [];
  const frames = [];
  // Every beat's midpoint, plus the even sweep that still runs with no comp beside the
  // video. Sorted and de-duplicated so a short video does not read the same frame twice.
  const even = Array.from({ length: samples }, (_, i) => +((i + 0.5) * duration / samples).toFixed(3));
  const times = [...new Set([...midBeats, ...even])]
    .filter((t) => t > 0 && t < duration)
    .sort((a, b) => a - b);
  try {
    for (let i = 0; i < times.length; i++) {
      const at = times[i];
      const png = join(dir, `f${i + 1}.png`);
      await run('ffmpeg', ['-y', '-v', 'error', '-ss', String(at), '-i', video, '-frames:v', '1', png]);
      const f = await readFrame(png);
      // Two ways to know where the boxes are. With a comp beside the video the renderer
      // says exactly, which is the only thing that works on a ground darker than a panel
      // fill. Without one, fall back to finding dark plates over bright footage, which
      // is how this gets pointed at a video that shipped months ago.
      // With a comp beside the video the renderer is the only authority: a beat it
      // says has no diagram is a bare closing beat, and hunting for dark plates there
      // finds the empty band itself and calls it an empty box.
      const placed = boxesAt ? boxesAt(at) : null;
      const panels = placed ? placed.rects : (boxesAt ? [] : findPanels(f));
      const found = placed ? placedFindings(f, placed) : (boxesAt ? [] : emptyBoxFindings(f, panels));
      const warned = capChunks ? captionFindings(f, captionWords(measurer, capChunks, at)) : [];
      log(`framelint ${at}s: ${panels.length} panel(s), ${found.length} finding(s), ${warned.length} warning(s)`);
      frames.push({ at, png, panels: panels.length, findings: found.length });
      for (const m of found) findings.push(`[${at}s] ${m}`);
      for (const m of warned) warnings.push(`[${at}s] ${m}`);
    }
    if (spec) warnings.push(...await specFindings(spec));
  } finally {
    if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { findings, warnings, frames, duration };
}

const isMain = resolve(process.argv[1] || '') === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const argv = process.argv.slice(2);
  const ki = argv.indexOf('--keep');
  const keep = ki >= 0 ? argv[ki + 1] : null;
  const [video, workdir] = argv.filter((a, i) => !a.startsWith('--') && !(ki >= 0 && i === ki + 1));
  if (!video) {
    console.error('usage: framelint.mjs <video.mp4> [workdir] [--keep <dir>]');
    process.exit(2);
  }
  const { findings, warnings, frames } = await lintFrames({ video, workdir: workdir || null, keep, log: console.error });
  for (const w of warnings) console.error('  warn: ' + w);
  if (findings.length) {
    console.error(`FRAME LINT: ${findings.length} finding(s) across ${frames.length} frames`);
    for (const f of findings) console.error('  ' + f);
    process.exit(1);
  }
  console.log(`frame lint: clean (${frames.length} frames, ${frames.reduce((n, f) => n + f.panels, 0)} panels read)`);
}
