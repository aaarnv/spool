// Native-skia port of comp/auto.html. Pure function of t, same three layers:
// ambient background (composited by ffmpeg, so this layer stays transparent),
// word-synced captions, and a middle layer that carries the meaning.
//
// That middle layer has two shapes. A mechanism plan draws the diagram DSL with
// rough.js. A design plan composites SCREENSHOTS of the product instead, because the
// owner is choosing what a screen looks like and a sketch of a layout is a worse
// drawing of the layout. The two never mix in one video.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FontLibrary, Path2D, loadImage } from 'skia-canvas';
import roughMod from '../rough.esm.js';
import { resolveLabels } from '../layout.mjs';
import { clamp01, easeBack, easeElastic, easePow } from './ease.mjs';

export const W = 540, H = 960, SCALE = 2;

// The ambient layer is composited by ffmpeg, not skia: this is auto.html's
// <video> (object-fit:cover, looping at CLIP_DUR) plus its saturate(1.1) brightness(.8)
// as an equivalent sRGB matrix.
// make-video.mjs picks the clip from the ambient pool and passes it through the
// env, because each frame worker is its own process.
// dim is an extra scrim on top of brightness(.8): busy bright footage washes out
// the thin grey diagram strokes, so those clips ship a dim below 1.
const dim = Number(process.env.SPOOL_AMBIENT_DIM) || 1;
const k = (n) => (n * dim).toFixed(6);
export const background = {
  src: process.env.SPOOL_AMBIENT_FILE || fileURLToPath(new URL('../ambient.mp4', import.meta.url)),
  clipDur: Number(process.env.SPOOL_AMBIENT_DUR) || 28.4,
  filter: `colorchannelmixer=rr=${k(0.86296)}:rg=${k(-0.0572)}:rb=${k(-0.00576)}:ra=0`
    + `:gr=${k(-0.01704)}:gg=${k(0.8228)}:gb=${k(-0.00576)}:ga=0`
    + `:br=${k(-0.01704)}:bg=${k(-0.0572)}:bb=${k(0.87424)}:ba=0:ar=0:ag=0:ab=0:aa=1`,
};

// Headless Chromium resolves the comp's -apple-system stack to Arial; register the
// same files so measureText matches the browser layout exactly.
const FONT_FILES = ['/System/Library/Fonts/Supplemental/Arial.ttf',
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf'].filter((f) => existsSync(f));
if (FONT_FILES.length) { try { FontLibrary.use('CompSans', FONT_FILES); } catch { /* already registered */ } }
const FF = FONT_FILES.length ? 'CompSans, Arial, Helvetica, sans-serif' : 'Arial, Helvetica, sans-serif';

const rough = roughMod.default || roughMod;
const gen = rough.generator();
const boilSeed = (t) => 1 + Math.floor(t * 8) % 6;

const CAP_SIZE = 30, CAP_LH = CAP_SIZE * 1.25, CAP_W = W - 48, CAP_BOTTOM = H - 110;
const DIAG_X = 30, DIAG_Y = 170, DIAG_W = 480, DIAG_H = 260;
// The phone the mockups sit in. Wide enough that 11px type in a 400px screenshot
// lands near 19px in the 1080-wide frame, and it stops 54px above the caption block.
const MOCK_X = 99, MOCK_Y = 104, MOCK_W = 341, MOCK_H = 580, MOCK_R = 26;

// ---------- shape -> flat primitive list (rough geometry is seed-stable, so cache it) ----------
const shapeCache = new Map();

function toPrims(drawable, dash) {
  return gen.toPaths(drawable).map((o) => ({
    k: 'path', d: o.d, stroke: o.stroke, strokeWidth: o.strokeWidth, fill: o.fill, dash,
  }));
}

// Geometry only: every label is placed by layout.mjs and drawn in its own pass above.
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
    // A barrier ACROSS a path, never a mark ON a thing: a cross says the thing is
    // gone, this says the thing held. Green by default because in a plan a block
    // is the good outcome, and the colour keeps it off the cross's register.
    const c = sh.color || '#7ee787';
    // `angle` is the FLOW's direction, so angle 0 (a left-to-right arrow) puts the
    // bar upright across it. The bar runs along u, the flow along p.
    const rad = ((sh.angle ?? 0) * Math.PI) / 180;
    const px = Math.cos(rad), py = Math.sin(rad); // the flow being stopped
    const ux = -py, uy = px; // the bar itself, across that flow
    const bar = (off) =>
      out.push(...toPrims(gen.line(
        sh.x + px * off - ux * 30, sh.y + py * off - uy * 30,
        sh.x + px * off + ux * 30, sh.y + py * off + uy * 30,
        o({ stroke: c, strokeWidth: 6 })
      )));
    bar(-5);
    bar(5);
    // Two deflection ticks splaying back up the flow, so it reads as stopping.
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

// Label placement depends only on the spec and the font, so resolve it once per beat.
const labelCache = new Map();
function labelsFor(ctx, entry) {
  let v = labelCache.get(entry);
  if (!v) {
    v = resolveLabels(entry.diagram.shapes, (text, size, weight) => {
      ctx.font = `${weight} ${size}px ${FF}`;
      const m = ctx.measureText(text);
      return { w: m.width, asc: Math.ceil(m.fontBoundingBoxAscent), desc: Math.ceil(m.fontBoundingBoxDescent) };
    });
    labelCache.set(entry, v);
  }
  return v;
}

function applyXform(ctx, xf) {
  if (!xf) return;
  if (xf.k !== undefined) {
    ctx.translate(xf.cx, xf.cy);
    ctx.scale(xf.k, xf.k);
    ctx.translate(-xf.cx, -xf.cy);
  } else ctx.translate(xf.dx, xf.dy);
}

// SVG dasharray uses getTotalLength() across every subpath; sample to the same number.
function pathLen(p) {
  if (p.len === undefined) {
    const subs = (p.d.match(/[Mm]/g) || []).length || 1;
    p.len = Math.max(1, p.p2d.points(1).length - subs);
  }
  return p.len;
}

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
      const k = p >= 1 ? 1 : (a.effect === 'pop' ? easeBack(p) : easeElastic(p));
      const c = center(sh);
      xform = { cx: c.x, cy: c.y, k: Math.max(0.001, k) };
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

// ---------- caption layout (browser line-breaking reproduced with measureText) ----------
const capCache = new Map();
function layoutChunk(ctx, chunk, idx) {
  let v = capCache.get(idx);
  if (v) return v;
  ctx.font = `800 ${CAP_SIZE}px ${FF}`;
  const ws = chunk.map((w) => ctx.measureText(w.word).width);
  const spaceW = ctx.measureText(' ').width;
  const m = ctx.measureText('Hg');
  // Chrome ceils the font's ascent/descent before laying the line box out.
  const A = Math.ceil(m.fontBoundingBoxAscent), Dn = Math.ceil(m.fontBoundingBoxDescent);

  const lines = []; let cur = [], acc = 0;
  chunk.forEach((_, i) => {
    if (cur.length && acc + spaceW + ws[i] > CAP_W) { lines.push({ idx: cur, w: acc }); cur = []; acc = 0; }
    acc += (cur.length ? spaceW : 0) + ws[i];
    cur.push(i);
  });
  if (cur.length) lines.push({ idx: cur, w: acc });

  const top = CAP_BOTTOM - lines.length * CAP_LH;
  v = [];
  lines.forEach((ln, li) => {
    const y = top + li * CAP_LH + (CAP_LH - (A + Dn)) / 2 + A;
    let x = (W - ln.w) / 2;
    for (const i of ln.idx) { v.push({ i, x, y, word: chunk[i].word }); x += ws[i] + spaceW; }
  });
  capCache.set(idx, v);
  return v;
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
  // The device reads as an object on the footage, the way the app's own desktop
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

// ---------- the scene ----------
export async function createScene({ beats, total, diagrams, mockups, brand = 'SPOOL' }) {
  const SPEC = diagrams || [];
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

  function draw(ctx, t) {
    ctx.resetTransform();
    ctx.clearRect(0, 0, W * SCALE, H * SCALE);
    ctx.scale(SCALE, SCALE);
    ctx.textBaseline = 'alphabetic';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const beat = beats.findLast((b) => t >= b.start) || beats[0];
    const lt = t - beat.start;

    // captions
    let ci = capChunks.findIndex((c) => t < c[c.length - 1].end);
    if (ci === -1) ci = capChunks.length - 1;
    const chunk = capChunks[ci];
    ctx.save();
    ctx.font = `800 ${CAP_SIZE}px ${FF}`;
    ctx.textAlign = 'left';
    // Shadows live in device space, so scale the CSS text-shadow up by SCALE.
    ctx.shadowColor = 'rgba(0,0,0,0.95)';
    ctx.shadowBlur = 16 * SCALE; ctx.shadowOffsetY = 2 * SCALE; ctx.shadowOffsetX = 0;
    for (const w of layoutChunk(ctx, chunk, ci)) {
      const cw = chunk[w.i];
      const said = t >= cw.end, now = !said && t >= cw.start;
      ctx.fillStyle = now ? '#ffd166' : '#ffffff';
      ctx.globalAlpha = said || now ? 1 : 0.45;
      ctx.fillText(w.word, w.x, w.y);
    }
    ctx.restore();

    // progress bar
    ctx.fillStyle = '#ffd166';
    ctx.fillRect(0, H - 5, W * (t / total), 5);

    // mockup — a design packet's beats carry a screenshot instead of a diagram
    const shot = SHOTS.get(beat.name);
    if (shot) drawMockup(ctx, shot, lt);

    // diagram — the comp's <svg> is 480x260 and clips whatever overflows it
    const entry = SPEC.find((e) => e.beat === beat.name);
    if (entry && entry.diagram) {
      ctx.save();
      ctx.beginPath(); ctx.rect(DIAG_X, DIAG_Y, DIAG_W, DIAG_H); ctx.clip();
      ctx.translate(DIAG_X, DIAG_Y);
      const seed = boilSeed(t);
      const anims = entry.diagram.anims || [];
      const shapes = entry.diagram.shapes || [];
      for (const sh of shapes) {
        const st = animState(sh, anims, lt);
        if (st.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = st.opacity;
        applyXform(ctx, st.xform);
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
        ctx.restore();
      }

      // labels last, so a panel can never cover a neighbour's text
      const byId = new Map(shapes.map((s) => [s.id, s]));
      ctx.save();
      ctx.textAlign = 'center';
      ctx.shadowColor = 'rgba(0,0,0,0.95)';
      ctx.shadowBlur = 7 * SCALE; ctx.shadowOffsetY = 1 * SCALE; ctx.shadowOffsetX = 0;
      for (const L of labelsFor(ctx, entry)) {
        const sh = byId.get(L.owner);
        const st = sh ? animState(sh, anims, lt) : { opacity: 1, xform: null };
        if (st.opacity <= 0) continue;
        ctx.save();
        ctx.globalAlpha = st.opacity;
        // a badge is only its text, so it scales about the resolved anchor
        applyXform(ctx, L.standalone && st.xform && st.xform.k !== undefined
          ? { ...st.xform, cx: L.x, cy: L.y } : st.xform);
        if (L.leader) {
          ctx.save();
          ctx.shadowColor = 'transparent';
          ctx.globalAlpha = st.opacity * 0.45;
          ctx.strokeStyle = L.fill; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.moveTo(L.leader.x1, L.leader.y1); ctx.lineTo(L.leader.x2, L.leader.y2); ctx.stroke();
          ctx.restore();
        }
        ctx.font = `${L.weight} ${L.size}px ${FF}`;
        ctx.fillStyle = L.fill;
        ctx.fillText(L.text, L.x, L.y);
        ctx.restore();
      }
      ctx.restore();
      ctx.restore();
    }

    // brand
    ctx.font = `800 15px ${FF}`;
    ctx.textAlign = 'left';
    ctx.letterSpacing = '2.1px';
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillText(brand, 24, 24 + Math.ceil(ctx.measureText('Hg').fontBoundingBoxAscent));
    ctx.letterSpacing = '0px';
  }

  return { draw, total, W, H, SCALE };
}
