// Time-varying filter parameters. ffmpeg has no keyframe list, so a JS track is
// sampled into a piecewise-linear expression over a balanced if() tree (depth
// log2(n), so a few thousand keys still evaluate in a handful of comparisons).

const n = (v) => {
  const r = Math.round(v * 1e4) / 1e4;
  return Number.isFinite(r) ? String(r) : "0";
};

/**
 * Adaptively sample fn over [t0,t1) at `fps`, keeping a key only where linear
 * interpolation would drift past `tol`. Flat runs collapse to two keys.
 */
export function sampleTrack(fn, t0, t1, fps, tol = 0.05) {
  const step = 1 / fps;
  const count = Math.max(2, Math.ceil((t1 - t0) * fps) + 1);
  const raw = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(t1, t0 + i * step);
    raw.push({ t, v: fn(t) });
  }
  const keys = [raw[0]];
  let anchor = 0;
  for (let i = 1; i < raw.length; i++) {
    const a = raw[anchor];
    const b = raw[i];
    let ok = true;
    for (let j = anchor + 1; j < i; j++) {
      const p = (raw[j].t - a.t) / (b.t - a.t || 1);
      if (Math.abs(a.v + (b.v - a.v) * p - raw[j].v) > tol) {
        ok = false;
        break;
      }
    }
    if (!ok) {
      keys.push(raw[i - 1]);
      anchor = i - 1;
    }
  }
  keys.push(raw[raw.length - 1]);
  return keys;
}

function segment(a, b, tv) {
  if (Math.abs(a.v - b.v) < 1e-6) return n(a.v);
  const span = b.t - a.t;
  if (span <= 0) return n(b.v);
  return `(${n(a.v)}+${n(b.v - a.v)}*(${tv}-${n(a.t)})/${n(span)})`;
}

function tree(keys, lo, hi, tv) {
  if (hi - lo <= 1) return segment(keys[lo], keys[hi], tv);
  const mid = (lo + hi) >> 1;
  return `if(lt(${tv},${n(keys[mid].t)}),${tree(keys, lo, mid, tv)},${tree(keys, mid, hi, tv)})`;
}

/** A piecewise-linear expression over `keys`, clamped to the first/last value. */
export function trackExpr(keys, tv = "T") {
  if (!keys.length) return "0";
  if (keys.length === 1) return n(keys[0].v);
  const flat = keys.every((k) => Math.abs(k.v - keys[0].v) < 1e-6);
  if (flat) return n(keys[0].v);
  const body = tree(keys, 0, keys.length - 1, tv);
  return `if(lt(${tv},${n(keys[0].t)}),${n(keys[0].v)},if(gte(${tv},${n(keys[keys.length - 1].t)}),${n(keys[keys.length - 1].v)},${body}))`;
}

/** sampleTrack + trackExpr in one step. */
export function fnExpr(fn, t0, t1, fps, tol, tv = "T") {
  return trackExpr(sampleTrack(fn, t0, t1, fps, tol), tv);
}

/** enable= expression covering a set of [start,end) spans, or null when always on. */
export function spansExpr(spans, tv = "t") {
  if (!spans.length) return "0";
  return spans.map(([a, b]) => `between(${tv},${n(a)},${n(b)})`).join("+");
}

/** Merge frame indices into [startSec,endSec) spans at `fps`. */
export function framesToSpans(frames, fps) {
  const spans = [];
  let run = null;
  for (const f of frames) {
    if (run && f === run[1] + 1) run[1] = f;
    else {
      if (run) spans.push(run);
      run = [f, f];
    }
  }
  if (run) spans.push(run);
  return spans.map(([a, b]) => [a / fps, (b + 1) / fps]);
}
