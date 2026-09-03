// The brand ground: the bottom layer of every frame, drawn in the scene instead of
// composited from stock footage. Every colour is a token so a style decision that
// changes the look changes this object, or SPOOL_GROUND_TOKENS, and nothing else.
import { Canvas } from 'skia-canvas';

// The Terminal look: near-black, one muted green accent, a hairline grid that reads
// as texture rather than as lines. Grid numbers are DEVICE pixels, so they do not
// move when the frame's logical size changes.
export const GROUND_TOKENS = {
  bg: '#08090B',
  lift: '#08090B',
  accent: '#6EE7A0',
  accentAlpha: 0,
  grain: 0.012,
  driftHz: 0.015,
  gridStep: 64,
  gridAlpha: 0.05,
};

export function groundTokens() {
  const raw = process.env.SPOOL_GROUND_TOKENS;
  if (!raw) return { ...GROUND_TOKENS };
  try { return { ...GROUND_TOKENS, ...JSON.parse(raw) }; } catch { return { ...GROUND_TOKENS }; }
}

// Grain is a baked tile, not per-frame noise: film grain that resamples every frame
// costs x264 a lot of bits for a texture nobody reads as motion.
function grainTile(size, amount) {
  const c = new Canvas(size, size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const a = Math.round(255 * amount);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() < 0.5 ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = Math.round(Math.random() * a);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// One device pixel per line, wide spacing, low alpha. The grid is meant to give the
// black a surface; the moment you can count the lines it is competing with the diagram.
function drawGrid(ctx, w, h, tk) {
  if (!(tk.gridAlpha > 0) || !(tk.gridStep > 0)) return;
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = `rgba(214,219,216,${tk.gridAlpha})`;
  ctx.beginPath();
  for (let x = tk.gridStep; x < w; x += tk.gridStep) { ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, h); }
  for (let y = tk.gridStep; y < h; y += tk.gridStep) { ctx.moveTo(0, y + 0.5); ctx.lineTo(w, y + 0.5); }
  ctx.stroke();
  ctx.restore();
}

function baseGround(w, h, tk) {
  const c = new Canvas(w, h);
  const ctx = c.getContext('2d');
  ctx.fillStyle = tk.bg;
  ctx.fillRect(0, 0, w, h);

  // Flat by request: no radial lift, no drifting glow. Tokens keep the knobs at zero.
  drawGrid(ctx, w, h, tk);

  if (tk.grain > 0) {
    const tile = grainTile(256, tk.grain);
    ctx.fillStyle = ctx.createPattern(tile, 'repeat');
    ctx.fillRect(0, 0, w, h);
  }
  return c;
}

function glowSprite(size, tk) {
  const c = new Canvas(size, size);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, tk.accent);
  g.addColorStop(0.55, tk.accent + '40');
  g.addColorStop(1, tk.accent + '00');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return c;
}

/**
 * Build the ground for a `w`x`h` device-space frame.
 *
 * The static half is baked once per worker process; the only per-frame work is two
 * blits, so the ground costs a fraction of what compositing footage cost.
 */
export function createGround(w, h, tokens = groundTokens()) {
  const tk = tokens;
  const base = baseGround(w, h, tk);
  const gs = Math.round(w * 1.7);
  const glow = tk.accentAlpha > 0 ? glowSprite(gs, tk) : null;

  function draw(ctx, t) {
    ctx.drawImage(base, 0, 0);
    if (!glow) return;
    const p = 2 * Math.PI * tk.driftHz * t;
    const x = w * 0.5 - gs / 2 + Math.sin(p) * w * 0.22;
    const y = h * 0.30 - gs / 2 + Math.cos(p * 0.7) * h * 0.07;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = tk.accentAlpha;
    ctx.drawImage(glow, x, y);
    ctx.restore();
  }

  return { draw, tokens: tk };
}
