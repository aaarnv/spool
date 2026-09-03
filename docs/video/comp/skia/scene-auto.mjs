// Native-skia port of comp/auto.html. Pure function of t, same three layers:
// the brand ground, word-synced captions, and a middle layer that carries the meaning.
//
// That middle layer has two shapes. A mechanism plan draws the diagram DSL. A design
// plan composites SCREENSHOTS of the product instead, because the owner is choosing
// what a screen looks like and a sketch of a layout is a worse drawing of the layout.
// The two never mix in one video.
//
// The diagram is drawn in the Terminal look: exact primitives on the near-black brand
// ground, monospace labels, one muted green accent. Everything that decides how it
// LOOKS is a token in LOOK_TOKENS. SPOOL_DIAGRAM_LOOK=rough restores the old rough.js
// sketch for one release.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Canvas, FontLibrary, Path2D, loadImage } from 'skia-canvas';
import { resolveLabels, DIAG_W as SPEC_W, DIAG_H as SPEC_H } from '../layout.mjs';
import { clamp01, easeBack, easeElastic, easePow } from './ease.mjs';
import { createGround, groundTokens } from './ground.mjs';

// Two frame geometries off one scene. Vertical is the product default; wide is what a
// diagram actually breathes in, and both read the same tokens.
const WIDE = process.env.SPOOL_FORMAT === 'wide';
export const W = WIDE ? 960 : 540, H = WIDE ? 540 : 960, SCALE = 2;

// Two looks. 'terminal' is the brand diagram look and the default. 'rough' is the
// previous rough.js sketch, kept reachable for one release and then removable.
export const LOOK = process.env.SPOOL_DIAGRAM_LOOK || 'terminal';
const ROUGH = LOOK === 'rough';

// Two grounds. 'brand' draws a token-driven ground inside this scene, which is the
// default because compositing footage cost most of the render bill and made every
// recap open on the same frame. SPOOL_GROUND=footage restores the ffmpeg composite.
export const GROUND = process.env.SPOOL_GROUND || 'brand';

// The footage layer is composited by ffmpeg, not skia: this is auto.html's
// <video> (object-fit:cover, looping at CLIP_DUR) plus its saturate(1.1) brightness(.8)
// as an equivalent sRGB matrix.
// make-video.mjs picks the clip from the ambient pool and passes it through the
// env, because each frame worker is its own process.
// dim is an extra scrim on top of brightness(.8): busy bright footage washes out
// the thin grey diagram strokes, so those clips ship a dim below 1.
const dim = Number(process.env.SPOOL_AMBIENT_DIM) || 1;
const k = (n) => (n * dim).toFixed(6);
// render-skia.mjs and frame-worker.mjs both gate the whole ffmpeg overlay graph on
// this being set, so a null background is what removes the composite from the render.
export const background = GROUND !== 'footage' ? null : {
  src: process.env.SPOOL_AMBIENT_FILE || fileURLToPath(new URL('../ambient.mp4', import.meta.url)),
  clipDur: Number(process.env.SPOOL_AMBIENT_DUR) || 28.4,
  filter: `colorchannelmixer=rr=${k(0.86296)}:rg=${k(-0.0572)}:rb=${k(-0.00576)}:ra=0`
    + `:gr=${k(-0.01704)}:gg=${k(0.8228)}:gb=${k(-0.00576)}:ga=0`
    + `:br=${k(-0.01704)}:bg=${k(-0.0572)}:bb=${k(0.87424)}:ba=0:ar=0:ag=0:ab=0:aa=1`,
};

// ---------- fonts ----------
// The mono face ships in the repo, so a worker container renders the same glyphs the
// Mac does; the fallbacks are what Debian's fonts-liberation provides if it is missing.
const monoFile = fileURLToPath(new URL('../GeistMono.woff2', import.meta.url));
if (existsSync(monoFile)) { try { FontLibrary.use('SpoolMono', [monoFile]); } catch { /* registered */ } }
const MONO = 'SpoolMono, Liberation Mono, DejaVu Sans Mono, Menlo, monospace';

// Headless Chromium resolves the comp's -apple-system stack to Arial; register the
// same files so the rough look's measureText matches the browser layout exactly.
const FONT_FILES = ['/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf'].filter((f) => existsSync(f));
if (FONT_FILES.length) { try { FontLibrary.use('CompSans', FONT_FILES); } catch { /* already registered */ } }
const SANS = FONT_FILES.length ? 'CompSans, Arial, Helvetica, sans-serif' : 'Arial, Helvetica, sans-serif';

// ---------- the look ----------
// `map` recolours the DSL's five semantic strokes; `text` does the same for the label
// colours layout.mjs derives from them. One accent carries the flow, one muted red
// carries a removal, everything else is the neutral line.
const LOOK_DEFAULTS = {
  font: MONO, radius: 2, nodeWidth: 1.5, edgeWidth: 1.5,
  nodeFill: 'rgba(255,255,255,0.028)',
  dash: [5, 5],
  ink: '#D6DBD8', accent: '#6EE7A0', warn: 'rgba(224,108,117,0.85)',
  labelWeight: 500, captionWeight: 500,
  map: {
    '#7ee787': 'rgba(214,219,216,0.34)', '#c9a0ff': 'rgba(214,219,216,0.34)',
    '#8b97a8': 'rgba(214,219,216,0.24)', '#ffd166': '#6EE7A0', '#ff7b72': 'rgba(224,108,117,0.85)',
  },
  text: {
    '#e8edf4': '#D6DBD8', '#cfc7de': '#D6DBD8', '#ffd166': '#6EE7A0',
    '#c9a0ff': 'rgba(214,219,216,0.60)', '#7ee787': 'rgba(214,219,216,0.60)', '#ff7b72': 'rgba(224,108,117,0.9)',
  },
  captionDim: 'rgba(214,219,216,0.34)', captionShadow: 'rgba(0,0,0,0.6)',
  brand: 'rgba(214,219,216,0.34)',
};

function lookTokens() {
  const raw = process.env.SPOOL_DIAGRAM_TOKENS;
  if (!raw) return { ...LOOK_DEFAULTS };
  try { return { ...LOOK_DEFAULTS, ...JSON.parse(raw) }; } catch { return { ...LOOK_DEFAULTS }; }
}
const T = lookTokens();
const paint = (c, fb) => (c && T.map[c]) || T.map[fb] || c || fb;

// ---------- frame geometry ----------
const MARGIN = WIDE ? 84 : 26;
const CAP = ROUGH
  ? { size: 30, width: W - 48, bottom: H - 110, lh: 1.25, font: SANS, weight: 800 }
  : WIDE
    ? { size: 27, width: W - 220, bottom: H - 44, lh: 1.3, font: T.font, weight: T.captionWeight }
    : { size: 31, width: W - 76, bottom: H - 96, lh: 1.3, font: T.font, weight: T.captionWeight };
// The band the diagram gets. Wide fills everything between the brand mark and the
// captions. Vertical takes the frame's middle instead, because a band that started
// under the wordmark centred the diagram in the top third and left the middle bare.
const BAND = WIDE
  ? { top: 66, bot: CAP.bottom - CAP.size * CAP.lh - 34 }
  : { top: Math.round(H * 0.20), bot: Math.round(H * 0.78) };
// A vertical frame is width-bound, so a sparse beat needs a higher ceiling to fill it.
const MAX_ZOOM = WIDE ? 2.2 : 2.8, FIT_PAD = 8;
// The rough look pins the diagram to the authored box in the top third instead.
const DIAG_X = 30, DIAG_Y = 170;
// The phone the mockups sit in. Wide enough that 11px type in a 400px screenshot
// lands near 19px in the 1080-wide frame, and it stops clear of the caption block.
const MOCK_H = WIDE ? 400 : 580;
const MOCK_W = Math.round(MOCK_H * 341 / 580);
const MOCK_X = Math.round((W - MOCK_W) / 2), MOCK_Y = WIDE ? 60 : 104, MOCK_R = 26;

// ---------- shape footprints ----------
// A beat's shapes rarely fill the authored 480x260 box, so fitting the BOX leaves a
// void wherever the beat is sparse. Fit the beat's own ink instead.
const SPAN = {
  box: (s) => [s.x, s.y, s.w || 160, s.h || 120],
  doc: (s) => [s.x, s.y, 120, 150],
  phone: (s) => [s.x, s.y, 110, 125],
  person: (s) => [s.x - 25, s.y - 25, 50, 105],
  squiggle: (s) => [s.x, s.y - 16, 110, 62],
  cross: (s) => [s.x - 18, s.y - 18, 36, 36],
  dot: (s) => [s.x - 9, s.y - 9, 18, 18],
  shield: (s) => [s.x - 40, s.y - 40, 80, 80],
  badge: (s) => [s.x - 4, s.y - 4, 8, 8],
};
const spanOf = (sh) => {
  const r = SPAN[sh.type];
  if (r) return r(sh);
  if (sh.x1 !== undefined) {
    // An elbowed connector bends through `via`, so its footprint has to hold that
    // corner too or the wipe edge stops short of half the line.
    const xs = [sh.x1, sh.x2], ys = [sh.y1, sh.y2];
    if (sh.via) { xs.push(sh.via.x); ys.push(sh.via.y); }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  }
  return null;
};
const PANEL_RECT = { box: SPAN.box, doc: SPAN.doc, phone: SPAN.phone };
const rectOf = (s) => (PANEL_RECT[s.type] ? PANEL_RECT[s.type](s) : null);

// Fit is computed from ALL shapes, revealed or not, so the diagram never reflows
// under its own animation.
function fitTransform(shapes, labels) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const add = (x, y, w, h) => {
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  };
  for (const sh of shapes) { const s = spanOf(sh); if (s) add(...s); }
  for (const L of labels) add(L.left, L.top, L.right - L.left, L.bot - L.top);
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = SPEC_W; y1 = SPEC_H; }
  x0 -= FIT_PAD; y0 -= FIT_PAD; x1 += FIT_PAD; y1 += FIT_PAD;
  const bw = x1 - x0, bh = y1 - y0;
  const zoom = Math.min((W - 2 * MARGIN) / bw, (BAND.bot - BAND.top) / bh, MAX_ZOOM);
  return {
    zoom,
    dx: (W - bw * zoom) / 2 - x0 * zoom,
    dy: BAND.top + (BAND.bot - BAND.top - bh * zoom) / 2 - y0 * zoom,
  };
}

// Pull a connector's ends onto the borders of the nodes they start and finish at,
// so a flow always touches what it connects instead of floating near it.
function dock(sh, rects) {
  let { x1, y1, x2, y2 } = sh;
  const v = sh.via;
  const dir = (ax, ay, bx, by) => {
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  };
  // Each end docks along its OWN leg, so an elbow leaves its box square instead of
  // aiming at a corner the line never travels toward.
  const [ux1, uy1] = dir(x1, y1, v ? v.x : x2, v ? v.y : y2);
  const [ux2, uy2] = dir(v ? v.x : x1, v ? v.y : y1, x2, y2);
  const near = (px, py) => rects.find(([x, y, w, h]) =>
    px > x - 26 && px < x + w + 26 && py > y - 26 && py < y + h + 26);
  const edge = (r, px, py, sx, sy) => {
    const [x, y, w, h] = r;
    let t = 0;
    for (let i = 0; i < 60; i++) {
      const cx = px + sx * i, cy = py + sy * i;
      if (cx < x || cx > x + w || cy < y || cy > y + h) break;
      t = i;
    }
    return [px + sx * t, py + sy * t];
  };
  const a = near(x1, y1); if (a) [x1, y1] = edge(a, x1, y1, ux1, uy1);
  const b = near(x2, y2); if (b) [x2, y2] = edge(b, x2, y2, -ux2, -uy2);
  return { x1, y1, x2, y2 };
}

// drawOn reveals by wiping left to right across the shape's own bounding box. A
// shape's LABEL is wiped by the same edge, so a name can never finish ahead of the
// node it names.
function wipe(ctx, sh, trim) {
  const r = SPAN[sh.type] ? SPAN[sh.type](sh) : null;
  const bx = r ? r[0] : Math.min(sh.x1 ?? sh.x, sh.x2 ?? sh.x) - 40;
  const bw = r ? r[2] : Math.abs((sh.x2 ?? sh.x) - (sh.x1 ?? sh.x)) + 80;
  ctx.beginPath();
  ctx.rect(bx - 6, -SPEC_H, Math.max(2, bw * trim) + 12, SPEC_H * 3);
  ctx.clip();
}

// How much of a connector a label box would erase if the connector were knocked out
// behind it. A label as long as its own edge would take the whole line, so a label
// that eats most of a connector is left printed over instead of blanking it.
function eaten(sh, L) {
  const dx = sh.x2 - sh.x1, dy = sh.y2 - sh.y1;
  let lo = 1, hi = 0;
  for (let i = 0; i <= 40; i++) {
    const u = i / 40;
    const px = sh.x1 + dx * u, py = sh.y1 + dy * u;
    if (px >= L.left - 4 && px <= L.right + 4 && py >= L.top - 3 && py <= L.bot + 3) {
      lo = Math.min(lo, u); hi = Math.max(hi, u);
    }
  }
  return hi < lo ? 0 : hi - lo;
}

function head(ctx, x, y, ang, size, colour) {
  ctx.save();
  ctx.translate(x, y); ctx.rotate(ang);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size, size * 0.42);
  ctx.lineTo(-size * 0.72, 0);
  ctx.lineTo(-size, -size * 0.42);
  ctx.closePath();
  ctx.fillStyle = colour; ctx.fill();
  ctx.restore();
}

function drawShape(ctx, sh, rects) {
  const panel = (x, y, w, h, stroke) => {
    ctx.beginPath(); ctx.roundRect(x, y, w, h, T.radius);
    ctx.fillStyle = T.nodeFill; ctx.fill();
    ctx.strokeStyle = stroke; ctx.lineWidth = T.nodeWidth; ctx.stroke();
  };
  const stroke = paint(sh.stroke || sh.color, '#8b97a8');

  if (sh.type === 'box') panel(sh.x, sh.y, sh.w || 160, sh.h || 120, stroke);
  else if (sh.type === 'doc') {
    panel(sh.x, sh.y, 120, 150, stroke);
    ctx.strokeStyle = paint('#8b97a8'); ctx.lineWidth = T.edgeWidth;
    for (const [dy, w] of [[35, 80], [65, 70], [95, 75]]) {
      ctx.beginPath(); ctx.moveTo(sh.x + 20, sh.y + dy); ctx.lineTo(sh.x + 20 + w, sh.y + dy); ctx.stroke();
    }
  } else if (sh.type === 'phone') {
    panel(sh.x, sh.y, 110, 125, stroke);
    ctx.strokeStyle = stroke; ctx.lineWidth = T.edgeWidth;
    ctx.beginPath(); ctx.arc(sh.x + 55, sh.y + 45, 18, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sh.x + 38, sh.y + 65); ctx.quadraticCurveTo(sh.x + 55, sh.y + 81, sh.x + 72, sh.y + 65); ctx.stroke();
  } else if (sh.type === 'person') {
    ctx.strokeStyle = stroke; ctx.lineWidth = T.nodeWidth;
    ctx.beginPath(); ctx.arc(sh.x, sh.y, 25, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sh.x, sh.y + 27); ctx.lineTo(sh.x, sh.y + 80); ctx.stroke();
  } else if (sh.type === 'squiggle') {
    ctx.strokeStyle = stroke; ctx.lineWidth = T.edgeWidth + 1;
    for (const off of [0, 30]) {
      ctx.beginPath();
      ctx.moveTo(sh.x, sh.y + off);
      ctx.bezierCurveTo(sh.x + 30, sh.y + off + (off ? 16 : -16), sh.x + 55, sh.y + off + (off ? 16 : -16), sh.x + 75, sh.y + off);
      ctx.lineTo(sh.x + 110, sh.y + off);
      ctx.stroke();
    }
  } else if (sh.type === 'arrow') {
    const { x1, y1, x2, y2 } = dock(sh, rects);
    const v = sh.via;
    const ang = Math.atan2(y2 - (v ? v.y : y1), x2 - (v ? v.x : x1));
    const size = 11;
    ctx.strokeStyle = stroke; ctx.lineWidth = T.edgeWidth;
    ctx.beginPath(); ctx.moveTo(x1, y1);
    if (v) ctx.lineTo(v.x, v.y);
    ctx.lineTo(x2 - Math.cos(ang) * size * 0.72, y2 - Math.sin(ang) * size * 0.72);
    ctx.stroke();
    head(ctx, x2, y2, ang, size, stroke);
  } else if (sh.type === 'wire') {
    const { x1, y1, x2, y2 } = dock(sh, rects);
    ctx.strokeStyle = stroke; ctx.lineWidth = T.edgeWidth;
    ctx.setLineDash(sh.dashed === false ? [] : T.dash);
    ctx.beginPath(); ctx.moveTo(x1, y1);
    if (sh.via) ctx.lineTo(sh.via.x, sh.via.y);
    ctx.lineTo(x2, y2); ctx.stroke();
    ctx.setLineDash([]);
  } else if (sh.type === 'cross') {
    ctx.strokeStyle = paint(sh.color, '#ff7b72'); ctx.lineWidth = T.edgeWidth + 1.5;
    for (const s of [1, -1]) {
      ctx.beginPath(); ctx.moveTo(sh.x - 17, sh.y - 17 * s); ctx.lineTo(sh.x + 17, sh.y + 17 * s); ctx.stroke();
    }
  } else if (sh.type === 'dot') {
    ctx.fillStyle = paint(sh.color, '#c9a0ff');
    ctx.beginPath(); ctx.arc(sh.x, sh.y, 8, 0, Math.PI * 2); ctx.fill();
  } else if (sh.type === 'shield') {
    // A barrier ACROSS a path, never a mark ON a thing: a cross says the thing is
    // gone, this says the thing held.
    const rad = ((sh.angle ?? 0) * Math.PI) / 180;
    const px = Math.cos(rad), py = Math.sin(rad), ux = -py, uy = px;
    ctx.strokeStyle = paint(sh.color, '#7ee787'); ctx.lineWidth = T.edgeWidth + 2;
    for (const off of [-5, 5]) {
      ctx.beginPath();
      ctx.moveTo(sh.x + px * off - ux * 30, sh.y + py * off - uy * 30);
      ctx.lineTo(sh.x + px * off + ux * 30, sh.y + py * off + uy * 30);
      ctx.stroke();
    }
  }
}

// ---------- the rough look (SPOOL_DIAGRAM_LOOK=rough, removable next release) ----------
// rough.esm.js is a vendored file the repo gitignores, so the import is lazy: a clean
// checkout renders the default look without it, and only the flag needs it present.
let gen = null;
async function loadRough() {
  const m = await import('../rough.esm.js');
  const r = m.default || m;
  gen = r.generator();
}
const boilSeed = (t) => 1 + Math.floor(t * 8) % 6;
const shapeCache = new Map();

function toPrims(drawable, dash) {
  return gen.toPaths(drawable).map((o) => ({
    k: 'path', d: o.d, stroke: o.stroke, strokeWidth: o.strokeWidth, fill: o.fill, dash,
  }));
}

function buildShape(sh, seed) {
  const o = (extra) => ({ seed, roughness: 1.5, bowing: 1.1, strokeWidth: 3, ...extra });
  const out = [];
  const panel = (x, y, w, h, stroke) => {
    out.push({ k: 'rect', x: x + 2, y: y + 2, w: w - 4, h: h - 4, r: 6, fill: 'rgba(8,10,14,.86)' });
    out.push(...toPrims(gen.rectangle(x, y, w, h, o({ stroke, strokeWidth: 3.5 }))));
  };

  if (sh.type === 'box') {
    panel(sh.x, sh.y, sh.w || 160, sh.h || 120, sh.stroke || '#8b97a8');
  } else if (sh.type === 'squiggle') {
    const { x, y } = sh; const c = sh.color || '#7ee787';
    out.push(...toPrims(gen.curve([[x, y], [x + 35, y - 14], [x + 75, y], [x + 110, y]], o({ stroke: c, strokeWidth: 5 }))));
    out.push(...toPrims(gen.curve([[x, y + 30], [x + 40, y + 42], [x + 80, y + 30], [x + 110, y + 30]], o({ stroke: c, strokeWidth: 5 }))));
  } else if (sh.type === 'doc') {
    panel(sh.x, sh.y, 120, 150, sh.stroke || '#8b97a8');
    out.push(...toPrims(gen.line(sh.x + 20, sh.y + 35, sh.x + 100, sh.y + 35, o({ stroke: '#8b97a8', strokeWidth: 5 }))));
    out.push(...toPrims(gen.line(sh.x + 20, sh.y + 65, sh.x + 90, sh.y + 65, o({ stroke: '#4d5666', strokeWidth: 5 }))));
    out.push(...toPrims(gen.line(sh.x + 20, sh.y + 95, sh.x + 95, sh.y + 95, o({ stroke: '#4d5666', strokeWidth: 5 }))));
  } else if (sh.type === 'phone') {
    panel(sh.x, sh.y, 110, 125, sh.stroke || '#c9a0ff');
    out.push(...toPrims(gen.circle(sh.x + 55, sh.y + 45, 36, o({ stroke: sh.stroke || '#c9a0ff' }))));
    out.push(...toPrims(gen.path(`M ${sh.x + 38} ${sh.y + 65} q 17 16 34 0`, o({ stroke: sh.stroke || '#c9a0ff' }))));
  } else if (sh.type === 'person') {
    out.push(...toPrims(gen.circle(sh.x, sh.y, 50, o({ stroke: sh.stroke || '#cfc7de' }))));
    out.push(...toPrims(gen.line(sh.x, sh.y + 27, sh.x, sh.y + 80, o({ stroke: sh.stroke || '#cfc7de' }))));
  } else if (sh.type === 'arrow') {
    const { x1, y1, x2, y2 } = sh; const c = sh.color || '#ffd166';
    out.push(...toPrims(gen.line(x1, y1, x2, y2, o({ stroke: c, strokeWidth: 4 }))));
    const a = Math.atan2(y2 - y1, x2 - x1);
    out.push(...toPrims(gen.line(x2, y2, x2 - 16 * Math.cos(a - 0.45), y2 - 16 * Math.sin(a - 0.45), o({ stroke: c, strokeWidth: 4 }))));
    out.push(...toPrims(gen.line(x2, y2, x2 - 16 * Math.cos(a + 0.45), y2 - 16 * Math.sin(a + 0.45), o({ stroke: c, strokeWidth: 4 }))));
  } else if (sh.type === 'wire') {
    // rough's toPaths() drops strokeLineDash, so carry the dash through ourselves.
    const dash = sh.dashed === false ? undefined : [8, 7];
    out.push(...toPrims(gen.line(sh.x1, sh.y1, sh.x2, sh.y2,
      o({ stroke: sh.color || '#c9a0ff', strokeWidth: 3, strokeLineDash: dash })), dash));
  } else if (sh.type === 'cross') {
    const c = sh.color || '#ff7b72';
    out.push(...toPrims(gen.line(sh.x - 18, sh.y - 18, sh.x + 18, sh.y + 18, o({ stroke: c, strokeWidth: 5 }))));
    out.push(...toPrims(gen.line(sh.x - 18, sh.y + 18, sh.x + 18, sh.y - 18, o({ stroke: c, strokeWidth: 5 }))));
  } else if (sh.type === 'shield') {
    const c = sh.color || '#7ee787';
    // `angle` is the FLOW's direction, so angle 0 (a left-to-right arrow) puts the
    // bar upright across it. The bar runs along u, the flow along p.
    const rad = ((sh.angle ?? 0) * Math.PI) / 180;
    const px = Math.cos(rad), py = Math.sin(rad);
    const ux = -py, uy = px;
    const bar = (off) =>
      out.push(...toPrims(gen.line(
        sh.x + px * off - ux * 30, sh.y + py * off - uy * 30,
        sh.x + px * off + ux * 30, sh.y + py * off + uy * 30,
        o({ stroke: c, strokeWidth: 6 })
      )));
    bar(-5);
    bar(5);
    for (const s of [-1, 1]) {
      out.push(...toPrims(gen.line(
        sh.x - px * 14 + ux * s * 16, sh.y - py * 14 + uy * s * 16,
        sh.x - px * 26 + ux * s * 30, sh.y - py * 26 + uy * s * 30,
        o({ stroke: c, strokeWidth: 3 })
      )));
    }
  } else if (sh.type === 'dot') {
    const c = sh.color || '#c9a0ff';
    out.push(...toPrims(gen.circle(sh.x, sh.y, 18, o({ stroke: c, fill: c, fillStyle: 'solid' }))));
  }
  for (const p of out) if (p.k === 'path') p.p2d = new Path2D(p.d);
  return out;
}

function shapePrims(sh, seed) {
  const key = `${seed}|${JSON.stringify(sh)}`;
  let v = shapeCache.get(key);
  if (!v) { v = buildShape(sh, seed); shapeCache.set(key, v); }
  return v;
}

// SVG dasharray uses getTotalLength() across every subpath; sample to the same number.
function pathLen(p) {
  if (p.len === undefined) {
    const subs = (p.d.match(/[Mm]/g) || []).length || 1;
    p.len = Math.max(1, p.p2d.points(1).length - subs);
  }
  return p.len;
}

function drawRough(ctx, sh, st, seed) {
  for (const p of shapePrims(sh, seed)) {
    if (p.k === 'rect') {
      ctx.fillStyle = p.fill;
      ctx.beginPath(); ctx.roundRect(p.x, p.y, p.w, p.h, p.r); ctx.fill();
    } else {
      // drawOn reveals with the same dasharray trick the DOM comp uses
      if (p.fill && p.fill !== 'none' && st.trim === null) { ctx.fillStyle = p.fill; ctx.fill(p.p2d); }
      if (p.stroke && p.stroke !== 'none') {
        ctx.strokeStyle = p.stroke;
        ctx.lineWidth = p.strokeWidth || 1;
        if (st.trim !== null) {
          const L = pathLen(p);
          ctx.setLineDash([L]); ctx.lineDashOffset = L * (1 - st.trim);
        } else ctx.setLineDash(p.dash || []);
        ctx.stroke(p.p2d);
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
    }
  }
}

// ---------- animation ----------
function center(sh) {
  if (sh.x1 !== undefined) return { x: (sh.x1 + sh.x2) / 2, y: (sh.y1 + sh.y2) / 2 };
  return { x: (sh.x ?? 0) + (sh.w ? sh.w / 2 : 0), y: (sh.y ?? 0) + (sh.h ? sh.h / 2 : 0) };
}

// Mirrors auto.html's applyAnims: later anims overwrite the same SVG attributes.
function animState(sh, anims, lt) {
  let visible = anims.some((a) => a.target === sh.id) ? false : true;
  let opacity = 1, xform = null, trim = null;
  for (const a of anims) {
    if (a.target !== sh.id) continue;
    const p = clamp01((lt - a.at) / (a.dur || 0.6));
    if (p > 0) visible = true;
    if (a.effect === 'pop' || a.effect === 'slam') {
      const k2 = p >= 1 ? 1 : (a.effect === 'pop' ? easeBack(p) : easeElastic(p));
      const c = center(sh);
      xform = { cx: c.x, cy: c.y, k: Math.max(0.001, k2) };
      opacity = a.effect === 'pop' ? Math.min(1, p * 3) : (p > 0 ? 1 : 0);
    } else if (a.effect === 'drawOn') {
      opacity = p > 0 ? 1 : 0;
      trim = p < 1 ? easePow(p) : null;
    } else if (a.effect === 'travel') {
      xform = { dx: (a.toX - sh.x) * easePow(p), dy: ((a.toY ?? sh.y) - sh.y) * easePow(p) };
    } else if (a.effect === 'shake') {
      xform = { dx: p > 0 && p < 1 ? Math.sin(lt * 24) * 7 * (1 - p) : 0, dy: 0 };
    }
  }
  if (!visible) opacity = 0;
  return { opacity, xform, trim };
}

// ---------- reveal choreography ----------
// The author's anims decide WHAT enters and how; this decides WHEN. Two defects it
// removes, both measured on the shipped recap: a badge arriving seconds after the box
// it belongs to, so the viewer reads empty panels; and a beat still assembling a third
// of the way in, so the frame is nearly bare while the narration has moved on.
//
// Elements land inside the first ASSEMBLE of the beat, ordered along the mechanism, and
// a beat with one step lands inside the first second.
const ASSEMBLE = 0.4, SOLO_END = 1.0, ENTER = 0.5, MIN_ENTER = 0.26;
const NODE = new Set(['box', 'doc', 'phone', 'person']);
const REVEAL = new Set(['pop', 'slam', 'drawOn']);

const distToSeg = (p, l) => {
  const dx = l.x2 - l.x1, dy = l.y2 - l.y1, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - l.x1) * dx + (p.y - l.y1) * dy) / len2)) : 0;
  return Math.hypot(p.x - (l.x1 + t * dx), p.y - (l.y1 + t * dy));
};

/**
 * Which step of the assembly each shape belongs to, read off the mechanism itself.
 *
 * Nodes are ranked by the longest chain of arrows reaching them, so a source is always
 * earlier than what it feeds. A connector goes with its source, a mark with the flow it
 * sits on, and a badge with the box it is inside — a badge is that box's CONTENT, so
 * putting it in a later step is what draws the empty panel.
 */
function revealSteps(shapes) {
  const nodes = shapes.filter((s) => NODE.has(s.type) && spanOf(s));
  const around = (x, y, pad) => nodes.find((n) => {
    const [rx, ry, rw, rh] = spanOf(n);
    return x > rx - pad && x < rx + rw + pad && y > ry - pad && y < ry + rh + pad;
  });
  const lines = shapes.filter((s) => (s.type === 'arrow' || s.type === 'wire') && typeof s.x1 === 'number');
  const link = lines.map((l) => ({ l, a: around(l.x1, l.y1, 26), b: around(l.x2, l.y2, 26) }));
  const rank = new Map(nodes.map((n) => [n.id, 0]));
  for (let pass = 0; pass <= nodes.length; pass++) {
    for (const e of link) {
      if (!e.a || !e.b || e.a.id === e.b.id) continue;
      if (rank.get(e.a.id) + 1 > rank.get(e.b.id)) rank.set(e.b.id, rank.get(e.a.id) + 1);
    }
  }
  const at = (n) => (n ? rank.get(n.id) : 0) * 2;
  const step = new Map();
  for (const s of shapes) {
    if (NODE.has(s.type)) { step.set(s.id, at(s)); continue; }
    if (s.type === 'arrow' || s.type === 'wire') {
      step.set(s.id, at(link.find((k) => k.l === s)?.a) + 1);
      continue;
    }
    if (typeof s.x !== 'number' || typeof s.y !== 'number') { step.set(s.id, 0); continue; }
    const host = around(s.x, s.y, 0);
    // A badge shares its box's step; every other mark lands after what it marks.
    if (s.type === 'badge') { step.set(s.id, at(host)); continue; }
    const on = link.find(({ l }) => distToSeg(s, l) <= 40);
    step.set(s.id, on ? at(on.a) + 2 : at(host) + 1);
  }
  return step;
}

/**
 * Retime a beat's reveals onto that order. Returns a new entry.
 *
 * Only the reveal effects are moved. A travel or a shake is the beat's POINT, not its
 * entrance, so those keep their authored time and are only held back far enough that
 * they cannot run before the shape they move is on screen.
 */
export function choreograph(entry, duration) {
  const shapes = entry?.diagram?.shapes || [];
  if (!shapes.length) return entry;
  const anims = entry.diagram.anims || [];
  const step = revealSteps(shapes);
  const order = [...new Set(shapes.map((s) => step.get(s.id) ?? 0))].sort((a, b) => a - b);
  const solo = order.length < 2;
  const window = solo ? SOLO_END : Math.max(SOLO_END, (duration || 4) * ASSEMBLE);
  const dur = Math.min(ENTER, Math.max(MIN_ENTER, window / Math.max(1, order.length)));
  const span = Math.max(0, window - dur);
  const out = [];
  for (const s of shapes) {
    const mine = anims.filter((a) => a.target === s.id);
    const i = order.indexOf(step.get(s.id) ?? 0);
    const start = solo ? 0 : +(span * i / (order.length - 1)).toFixed(2);
    const rev = mine.find((a) => REVEAL.has(a.effect));
    const fallback = s.type === 'badge' || s.type === 'cross' || s.type === 'shield' ? 'slam' : 'drawOn';
    out.push({ target: s.id, effect: rev?.effect || fallback, at: start, dur });
    for (const a of mine) {
      if (!REVEAL.has(a.effect)) out.push({ ...a, at: Math.max(a.at ?? 0, start + dur) });
    }
  }
  return { ...entry, diagram: { ...entry.diagram, anims: out } };
}

function applyXform(ctx, xf) {
  if (!xf) return;
  if (xf.k !== undefined) {
    ctx.translate(xf.cx, xf.cy);
    ctx.scale(xf.k, xf.k);
    ctx.translate(-xf.cx, -xf.cy);
  } else ctx.translate(xf.dx, xf.dy);
}

// A screenshot lands in its phone with the same entrance a diagram's first shape
// gets, so a design video has the same pulse as a mechanism one.
function drawMockup(ctx, img, lt) {
  const p = clamp01(lt / 0.5);
  const e = easePow(p);
  ctx.save();
  ctx.globalAlpha = Math.min(1, p * 2.2);
  ctx.translate(0, (1 - e) * 16);
  ctx.beginPath();
  ctx.roundRect(MOCK_X, MOCK_Y, MOCK_W, MOCK_H, MOCK_R);
  // The device reads as an object on the ground, the way the app's own desktop
  // layout floats the phone: one soft drop shadow, one hairline ring, no stripes.
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = 60; ctx.shadowOffsetY = 26;
  ctx.fillStyle = '#0a0a0b';
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.save();
  ctx.clip();
  ctx.drawImage(img, MOCK_X, MOCK_Y, MOCK_W, MOCK_H);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.restore();
}

// ---------- the stage ----------
// A soft lift over the band, so a diagram that does not fill it reads as sitting on a
// surface rather than floating. Baked once: a full-frame gradient per frame is not free.
function bakeStage() {
  const c = new Canvas(W, H);
  const ctx = c.getContext('2d');
  const cx = W / 2, cy = (BAND.top + BAND.bot) / 2, r = (BAND.bot - BAND.top) * 0.78;
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  g.addColorStop(0, 'rgba(255,255,255,0.038)');
  g.addColorStop(0.55, 'rgba(255,255,255,0.018)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  return c;
}

// ---------- opening and closing cards ----------
// Both cards OVERLAY the timeline rather than extend it: the video and the VO share one
// clock, and they stop above the captions so no spoken word is covered.
const CARD_DUR = 1.5, CARD_WIPE = 0.34;
const CAP_TOP = CAP.bottom - CAP.size * CAP.lh * (WIDE ? 1 : 2);
const CARD = { x: 0, y: 0, w: W, h: CAP_TOP - 20 };
const CARD_TITLE = WIDE ? 36 : 34;
const CARD_FADE = 44;
const IDENT = 14;
const GROUND_BG = groundTokens().bg;
const GROUND_BG0 = /^#[0-9a-f]{6}$/i.test(GROUND_BG) ? `${GROUND_BG}00` : 'rgba(0,0,0,0)';

function wrap(ctx, text, width, max) {
  const out = [];
  let cur = '';
  for (const w of String(text || '').split(/\s+/).filter(Boolean)) {
    const next = cur ? `${cur} ${w}` : w;
    if (cur && ctx.measureText(next).width > width) { out.push(cur); cur = w; } else cur = next;
  }
  if (cur) out.push(cur);
  if (out.length > max) { out.length = max; out[max - 1] = `${out[max - 1]}…`; }
  return out;
}

// A left-to-right wipe, the same edge the diagram reveals its own shapes with.
function cardClip(ctx, p, entering) {
  ctx.beginPath();
  const h = CARD.h + CARD_FADE;
  if (entering) ctx.rect(CARD.x, CARD.y, CARD.w * p, h);
  else ctx.rect(CARD.x + CARD.w * p, CARD.y, CARD.w * (1 - p), h);
  ctx.clip();
}

// repo in the ink's dim, the number in the accent. The one line that says what the
// viewer is looking at, used by the hook card and by the running frame's header.
function drawIdent(ctx, card, x, y, size, align = 'left') {
  ctx.save();
  ctx.font = `${T.captionWeight} ${size}px ${T.font}`;
  ctx.letterSpacing = '1.6px';
  ctx.textAlign = 'left';
  const repo = `${card.repo} `;
  const num = `#${card.number}`;
  const w = ctx.measureText(repo).width + ctx.measureText(num).width;
  const left = align === 'right' ? x - w : x;
  ctx.fillStyle = T.brand;
  ctx.fillText(repo, left, y);
  ctx.fillStyle = T.accent;
  ctx.fillText(num, left + ctx.measureText(repo).width, y);
  ctx.letterSpacing = '0px';
  ctx.restore();
}

function drawCard(ctx, card, kind, p, entering) {
  const x = MARGIN, inner = W - 2 * MARGIN;
  ctx.save();
  cardClip(ctx, p, entering);
  ctx.fillStyle = GROUND_BG;
  ctx.fillRect(CARD.x, CARD.y, CARD.w, CARD.h);
  // Below the card the fill ramps off instead of stopping, so its lower edge is never
  // a rule across the frame. The ramp starts past the band, so no diagram shows through.
  const fade = ctx.createLinearGradient(0, CARD.h, 0, CARD.h + CARD_FADE);
  fade.addColorStop(0, GROUND_BG);
  fade.addColorStop(1, GROUND_BG0);
  ctx.fillStyle = fade;
  ctx.fillRect(CARD.x, CARD.h, CARD.w, CARD_FADE);
  ctx.textAlign = 'left';

  const titleSize = kind === 'hook' ? CARD_TITLE : Math.round(CARD_TITLE * 0.82);
  ctx.font = `${T.captionWeight} ${titleSize}px ${T.font}`;
  const lines = wrap(ctx, card.title || `${card.repo}#${card.number}`, inner, kind === 'hook' ? 4 : 3);
  const lh = titleSize * 1.32;
  // Both cards centre their block on the band, so the title lands where the diagram
  // is about to be and the wipe reads as one surface replacing another.
  const block = lines.length * lh + IDENT * 3;
  let y = (BAND.top + BAND.bot - block) / 2 + titleSize;

  if (kind === 'hook') drawIdent(ctx, card, x, y - titleSize - IDENT, IDENT);
  ctx.font = `${T.captionWeight} ${titleSize}px ${T.font}`;
  ctx.fillStyle = T.ink;
  for (const ln of lines) { ctx.fillText(ln, x, y); y += lh; }

  if (kind === 'end') {
    ctx.font = `${T.captionWeight} ${IDENT + 2}px ${T.font}`;
    ctx.fillStyle = T.accent;
    ctx.fillText(card.link, x, y + IDENT);
  }
  ctx.restore();
}

/**
 * Where this scene puts a beat's panels in the finished frame, in comp CSS units.
 *
 * The frame gate needs the boxes to measure what is inside them, and on the Terminal
 * ground it cannot find them in the pixels: a panel is a 2.8% white plate on near-black
 * with a hairline border, and the ground carries its own gradient, so no global
 * threshold separates the two. The renderer already knows the answer exactly, so it
 * says it here rather than making the gate guess. Same fit maths as drawDiagram.
 */
export function panelRectsFor(entry) {
  const shapes = entry?.diagram?.shapes;
  if (!shapes?.length) return [];
  const ctx = new Canvas(8, 8).getContext('2d');
  const FF = ROUGH ? SANS : T.font;
  const labels = resolveLabels(shapes, (text, size, weight) => {
    ctx.font = `${weight} ${size}px ${FF}`;
    const m = ctx.measureText(text);
    return { w: m.width, asc: Math.ceil(m.fontBoundingBoxAscent), desc: Math.ceil(m.fontBoundingBoxDescent) };
  });
  const rects = shapes.map((s) => (PANEL_RECT[s.type] ? PANEL_RECT[s.type](s) : null));
  if (ROUGH) {
    return rects.filter(Boolean).map(([x, y, w, h]) => ({ x: x + DIAG_X, y: y + DIAG_Y, w, h }));
  }
  const fit = fitTransform(shapes, labels);
  return rects.filter(Boolean).map(([x, y, w, h]) => ({
    x: x * fit.zoom + fit.dx, y: y * fit.zoom + fit.dy, w: w * fit.zoom, h: h * fit.zoom,
  }));
}

// ---------- the scene ----------
export async function createScene({ beats, total, diagrams, mockups, card = null, brand = 'SPOOL' }) {
  // Every beat's reveals are retimed onto its own narration window before a frame is
  // drawn, so what the author wrote decides the effects and this decides the pacing.
  const SPEC = (diagrams || []).map((e) => (e?.diagram
    ? choreograph(e, beats.find((b) => b.name === e.beat)?.duration)
    : e));
  // Too short a video and the two cards would be most of it.
  const cards = !ROUGH && card && card.repo && total > CARD_DUR * 4;
  if (ROUGH) await loadRough();
  const ground = background ? null : createGround(W * SCALE, H * SCALE, groundTokens());
  const stage = null; // flat ground by request; bakeStage kept for the footage look
  // Decoding is per worker process and every frame of a beat draws the same file, so
  // the whole set is loaded once up front rather than touched during draw().
  const SHOTS = new Map();
  for (const m of mockups || []) {
    if (m?.png && existsSync(m.png)) SHOTS.set(m.beat, await loadImage(m.png));
  }
  const capChunks = [];
  for (const b of beats) {
    let cur = [];
    for (const w of b.words) {
      cur.push(w);
      if (cur.length >= 5 || /[.!?…]$/.test(w.word)) { capChunks.push(cur); cur = []; }
    }
    if (cur.length) capChunks.push(cur);
  }

  // Label placement depends only on the spec and the font, so resolve it once per beat.
  const labelCache = new Map();
  function labelsFor(ctx, entry) {
    let v = labelCache.get(entry);
    if (v) return v;
    const FF = ROUGH ? SANS : T.font;
    v = resolveLabels(entry.diagram.shapes, (text, size, weight) => {
      ctx.font = `${weight} ${size}px ${FF}`;
      const m = ctx.measureText(text);
      return { w: m.width, asc: Math.ceil(m.fontBoundingBoxAscent), desc: Math.ceil(m.fontBoundingBoxDescent) };
    });
    if (!ROUGH) for (const L of v) { L.fill = T.text[L.fill] || L.fill; L.weight = T.labelWeight; }
    labelCache.set(entry, v);
    return v;
  }

  // ---------- caption layout (browser line-breaking reproduced with measureText) ----------
  const capCache = new Map();
  function layoutChunk(ctx, chunk, idx) {
    let v = capCache.get(idx);
    if (v) return v;
    ctx.font = `${CAP.weight} ${CAP.size}px ${CAP.font}`;
    const ws = chunk.map((w) => ctx.measureText(w.word).width);
    const spaceW = ctx.measureText(' ').width;
    const m = ctx.measureText('Hg');
    // Chrome ceils the font's ascent/descent before laying the line box out.
    const A = Math.ceil(m.fontBoundingBoxAscent), Dn = Math.ceil(m.fontBoundingBoxDescent);
    const LH = CAP.size * CAP.lh;

    const lines = []; let cur = [], acc = 0;
    chunk.forEach((_, i) => {
      if (cur.length && acc + spaceW + ws[i] > CAP.width) { lines.push({ idx: cur, w: acc }); cur = []; acc = 0; }
      acc += (cur.length ? spaceW : 0) + ws[i];
      cur.push(i);
    });
    if (cur.length) lines.push({ idx: cur, w: acc });

    const top = CAP.bottom - lines.length * LH;
    v = [];
    lines.forEach((ln, li) => {
      const y = top + li * LH + (LH - (A + Dn)) / 2 + A;
      let x = (W - ln.w) / 2;
      for (const i of ln.idx) { v.push({ i, x, y, word: chunk[i].word }); x += ws[i] + spaceW; }
    });
    capCache.set(idx, v);
    return v;
  }

  function drawDiagram(ctx, entry, lt, t) {
    const shapes = entry.diagram.shapes || [];
    const anims = entry.diagram.anims || [];
    const labels = labelsFor(ctx, entry);

    ctx.save();
    if (ROUGH) {
      ctx.beginPath(); ctx.rect(DIAG_X, DIAG_Y, SPEC_W, SPEC_H); ctx.clip();
      ctx.translate(DIAG_X, DIAG_Y);
    } else {
      const fit = fitTransform(shapes, labels);
      ctx.translate(fit.dx, fit.dy); ctx.scale(fit.zoom, fit.zoom);
    }
    const rects = shapes.map(rectOf).filter(Boolean);
    const seed = boilSeed(t);

    for (const sh of shapes) {
      const st = animState(sh, anims, lt);
      if (st.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = st.opacity;
      applyXform(ctx, st.xform);
      if (ROUGH) drawRough(ctx, sh, st, seed);
      else {
        // A connector that crosses a label is knocked out behind it, so the text sits
        // in a clean break instead of on top of a line.
        if (sh.type === 'arrow' || sh.type === 'wire') {
          const p = new Path2D();
          p.rect(-SPEC_W, -SPEC_H, SPEC_W * 3, SPEC_H * 3);
          for (const L of labels) {
            if (eaten(sh, L) > 0.55) continue;
            p.rect(L.left - 4, L.top - 3, L.right - L.left + 8, L.bot - L.top + 6);
          }
          ctx.clip(p, 'evenodd');
        }
        if (st.trim !== null) wipe(ctx, sh, st.trim);
        drawShape(ctx, sh, rects);
      }
      ctx.restore();
    }

    // labels last, so a node fill can never cover a neighbour's text
    const byId = new Map(shapes.map((s) => [s.id, s]));
    ctx.save();
    ctx.textAlign = 'center';
    if (ROUGH) {
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.shadowBlur = 7 * SCALE; ctx.shadowOffsetY = 1 * SCALE; ctx.shadowOffsetX = 0;
    }
    for (const L of labels) {
      const sh = byId.get(L.owner);
      const st = sh ? animState(sh, anims, lt) : { opacity: 1, xform: null, trim: null };
      if (st.opacity <= 0) continue;
      ctx.save();
      ctx.globalAlpha = st.opacity;
      // a badge is only its text, so it scales about the resolved anchor
      applyXform(ctx, L.standalone && st.xform && st.xform.k !== undefined
        ? { ...st.xform, cx: L.x, cy: L.y } : st.xform);
      if (!ROUGH && st.trim !== null && sh) wipe(ctx, sh, st.trim);
      if (L.leader) {
        ctx.save();
        ctx.shadowColor = 'transparent';
        ctx.globalAlpha = st.opacity * 0.4;
        ctx.strokeStyle = L.fill; ctx.lineWidth = ROUGH ? 1.5 : 1;
        ctx.beginPath(); ctx.moveTo(L.leader.x1, L.leader.y1); ctx.lineTo(L.leader.x2, L.leader.y2); ctx.stroke();
        ctx.restore();
      }
      ctx.font = `${L.weight} ${L.size}px ${ROUGH ? SANS : T.font}`;
      ctx.fillStyle = L.fill;
      ctx.fillText(L.text, L.x, L.y);
      ctx.restore();
    }
    ctx.restore();
    ctx.restore();
  }

  function draw(ctx, t) {
    ctx.resetTransform();
    ctx.clearRect(0, 0, W * SCALE, H * SCALE);
    if (ground) ground.draw(ctx, t);
    ctx.scale(SCALE, SCALE);
    ctx.textBaseline = 'alphabetic';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (stage) ctx.drawImage(stage, 0, 0, W, H);

    const beat = beats.findLast((b) => t >= b.start) || beats[0];
    const lt = t - beat.start;

    // mockup — a design packet's beats carry a screenshot instead of a diagram
    const shot = SHOTS.get(beat.name);
    if (shot) drawMockup(ctx, shot, lt);

    // diagram
    const entry = SPEC.find((e) => e.beat === beat.name);
    if (entry && entry.diagram) drawDiagram(ctx, entry, lt, t);

    // hook and end cards, over the band only
    if (cards && t < CARD_DUR) {
      drawCard(ctx, card, 'hook', clamp01((t - CARD_DUR + CARD_WIPE) / CARD_WIPE), false);
    } else if (cards && t > total - CARD_DUR) {
      drawCard(ctx, card, 'end', clamp01((t - (total - CARD_DUR)) / CARD_WIPE), true);
    }

    // captions — the spoken word carries the accent, said words the ink, the rest dim
    let ci = capChunks.findIndex((c) => t < c[c.length - 1].end);
    if (ci === -1) ci = capChunks.length - 1;
    const chunk = capChunks[ci];
    ctx.save();
    ctx.font = `${CAP.weight} ${CAP.size}px ${CAP.font}`;
    ctx.textAlign = 'left';
    // Shadows live in device space, so scale the CSS text-shadow up by SCALE.
    const shadow = ROUGH ? 'rgba(0,0,0,0.95)' : T.captionShadow;
    if (shadow) {
      ctx.shadowColor = shadow;
      ctx.shadowBlur = (ROUGH ? 16 : 14) * SCALE; ctx.shadowOffsetY = 2 * SCALE; ctx.shadowOffsetX = 0;
    }
    for (const w of layoutChunk(ctx, chunk, ci)) {
      const cw = chunk[w.i];
      const said = t >= cw.end, now = !said && t >= cw.start;
      if (ROUGH) {
        ctx.fillStyle = now ? '#ffd166' : '#ffffff';
        ctx.globalAlpha = said || now ? 1 : 0.45;
      } else ctx.fillStyle = now ? T.accent : (said ? T.ink : T.captionDim);
      ctx.fillText(w.word, w.x, w.y);
    }
    ctx.restore();

    // progress
    ctx.fillStyle = ROUGH ? '#ffd166' : T.accent;
    ctx.fillRect(0, H - (ROUGH ? 5 : 3), W * (t / total), ROUGH ? 5 : 3);

    // brand
    ctx.font = ROUGH ? `800 15px ${SANS}` : `${T.captionWeight} 14px ${T.font}`;
    ctx.textAlign = 'left';
    ctx.letterSpacing = '2.1px';
    ctx.fillStyle = ROUGH ? 'rgba(255,255,255,0.45)' : T.brand;
    const bx = ROUGH ? 24 : MARGIN, by = ROUGH ? 24 : 34;
    const base = by + Math.ceil(ctx.measureText('Hg').fontBoundingBoxAscent);
    ctx.fillText(brand, bx, base);
    ctx.letterSpacing = '0px';

    // The running frame keeps naming the pull request after the hook card wipes off.
    // Wide has no room under the wordmark, so it takes the other end of that line.
    if (cards && t >= CARD_DUR - CARD_WIPE && t <= total - CARD_DUR) {
      if (WIDE) drawIdent(ctx, card, W - MARGIN, base, IDENT, 'right');
      else drawIdent(ctx, card, bx, base + 30, IDENT);
    }
  }

  return { draw, total, W, H, SCALE };
}
