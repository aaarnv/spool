// Virtual camera for the vertical format: cover-crop the capture into a fixed stage
// and pan/zoom to clicks. Dependency-free like retime.mjs (node + browser bundle).

// Stage on the 1080x1920 canvas. Not full-bleed: full-bleed would force a 2.13x
// cover upscale on a 1600x900 capture, which reads soft.
export const STAGE = { x: 24, y: 200, w: 1032, h: 1280 };

export const HOOK_S = 2.0;
export const CTA_S = 1.5;

const CAM_Z_CLICK = 1.25;
const CAM_LEAD = 0.35;
const CAM_HOLD = 0.9;
const CAM_PAN_MAX_S = 0.7;
const CAM_RELEASE_S = 0.8;
const CAM_RELEASE_MIN_S = 0.2;
const CAM_EXPLICIT_RAMP_S = 0.6;
const DRIFT_Z = 1.05;
const BASE_CY = 0.44;
const MERGE_S = 0.4;
const MERGE_PX = 120;

const MUSIC_BASE = 0.3;
const MUSIC_DUCK = 0.12;
const MUSIC_RAMP_S = 0.25;
const MUSIC_FADE_IN_S = 0.5;
const MUSIC_FADE_OUT_S = 0.6;

function easeInOutCubic(p) {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
}

function viewportOf(viewport) {
  return {
    vw: viewport?.width ?? 1600,
    vh: viewport?.height ?? 900,
  };
}

// Base framing: horizontally centred, biased above centre so the browser chrome
// and the app's primary column sit in frame.
function baseKey(t, vw, vh) {
  return { t, cx: vw / 2, cy: vh * BASE_CY, z: 1 };
}

// Collapse click bursts into one camera target: same intent if they land within
// MERGE_S of each other AND within MERGE_PX.
function mergeTargets(clicks) {
  const usable = (clicks || [])
    .filter((c) => c && typeof c.x === "number" && typeof c.y === "number")
    .slice()
    .sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
  const out = [];
  for (const c of usable) {
    const t = c.t ?? 0;
    const prev = out[out.length - 1];
    if (prev && t - prev.last < MERGE_S && Math.hypot(c.x - prev.x, c.y - prev.y) < MERGE_PX) {
      prev.x = (prev.x + c.x) / 2;
      prev.y = (prev.y + c.y) / 2;
      prev.last = t;
      continue;
    }
    out.push({ t, x: c.x, y: c.y, last: t });
  }
  return out;
}

function driftKeys(start, end, vw, vh) {
  const open = baseKey(start, vw, vh);
  return [open, { ...baseKey(Math.max(end, start), vw, vh), z: DRIFT_Z, ease: "linear" }];
}

function clickKeys(start, end, targets, vw, vh) {
  const plan = [];
  for (const g of targets) {
    const arrive = Math.max(start, g.t - CAM_LEAD);
    const prev = plan[plan.length - 1];
    // Two targets wanting the same arrival: only the later one is ever reachable.
    if (prev && arrive <= prev.arrive) plan.pop();
    plan.push({ arrive, hold: Math.max(arrive, g.last + CAM_HOLD), x: g.x, y: g.y });
  }

  const keys = [baseKey(start, vw, vh)];
  for (let n = 0; n < plan.length; n++) {
    const g = plan[n];
    const prev = keys[keys.length - 1];
    // Long gaps hold the previous framing so the move itself never exceeds the cap.
    const panStart = Math.max(prev.t, g.arrive - CAM_PAN_MAX_S);
    if (panStart > prev.t) keys.push({ ...prev, t: panStart });
    keys.push({ t: g.arrive, cx: g.x, cy: g.y, z: CAM_Z_CLICK });
    const next = plan[n + 1];
    const holdT = next
      ? Math.min(g.hold, Math.max(g.arrive, next.arrive - CAM_PAN_MAX_S))
      : g.hold;
    if (holdT > g.arrive) keys.push({ t: holdT, cx: g.x, cy: g.y, z: CAM_Z_CLICK });
  }

  const lastKey = keys[keys.length - 1];
  // Without headroom the click framing rides into the freeze rather than half-releasing.
  if (end - lastKey.t >= CAM_RELEASE_MIN_S) {
    keys.push(baseKey(Math.min(end, lastKey.t + CAM_RELEASE_S), vw, vh));
  }
  return keys;
}

function explicitKeys(start, end, zoom, vw, vh) {
  // Capped at the click zoom: anything more compounds with the cover upscale.
  const z = Math.min(CAM_Z_CLICK, Math.max(1, zoom.scale || CAM_Z_CLICK));
  const mid = (start + end) / 2;
  const peakAt = Math.min(start + CAM_EXPLICIT_RAMP_S, mid);
  const holdEnd = Math.max(peakAt, end - CAM_EXPLICIT_RAMP_S);
  return [
    baseKey(start, vw, vh),
    { t: peakAt, cx: zoom.x, cy: zoom.y, z },
    { t: holdEnd, cx: zoom.x, cy: zoom.y, z },
    baseKey(Math.max(end, holdEnd), vw, vh),
  ];
}

function stepKeys(w, vw, vh) {
  const start = w.startSec;
  const end = w.endSec;
  const zoom = w.zoom ?? "auto";
  if (zoom && typeof zoom === "object" && zoom.x != null && zoom.y != null) {
    return explicitKeys(start, end, zoom, vw, vh);
  }
  const targets = zoom === "auto" ? mergeTargets(w.outClicks) : [];
  return targets.length ? clickKeys(start, end, targets, vw, vh) : driftKeys(start, end, vw, vh);
}

// Per-step keyframes on the OUTPUT clock. Steps are independent so boundaries read
// as hard cuts, never as a pan across an edit.
export function buildCameraTrack(windows, viewport) {
  const { vw, vh } = viewportOf(viewport);
  return (windows || []).map((w) => ({
    i: w.i,
    startSec: w.startSec,
    endSec: w.endSec,
    keys: stepKeys(w, vw, vh),
  }));
}

function evalKeys(keys, t, vw, vh) {
  if (!keys || !keys.length) return { cx: vw / 2, cy: vh * BASE_CY, z: 1 };
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
    const e = b.ease === "linear" ? p : easeInOutCubic(p);
    return {
      cx: a.cx + (b.cx - a.cx) * e,
      cy: a.cy + (b.cy - a.cy) * e,
      z: a.z + (b.z - a.z) * e,
    };
  }
  return last;
}

// Clamp AFTER interpolation so an eased pan toward an edge target never lets the
// visible window leave capture bounds.
function toTransform(cx, cy, z, vw, vh, stage) {
  const s = Math.max(stage.w / vw, stage.h / vh) * Math.max(1, z);
  const halfW = stage.w / (2 * s);
  const halfH = stage.h / (2 * s);
  const ccx = Math.min(Math.max(cx, halfW), Math.max(halfW, vw - halfW));
  const ccy = Math.min(Math.max(cy, halfH), Math.max(halfH, vh - halfH));
  return { s, tx: stage.w / 2 - ccx * s, ty: stage.h / 2 - ccy * s };
}

export function sampleCamera(track, tSec, viewport, stage = STAGE) {
  const { vw, vh } = viewportOf(viewport);
  const steps = Array.isArray(track) ? track : [];
  if (!steps.length) return toTransform(vw / 2, vh * BASE_CY, 1, vw, vh, stage);
  let step = steps.find((s) => tSec >= s.startSec && tSec < s.endSec);
  if (!step) step = tSec < steps[0].startSec ? steps[0] : steps[steps.length - 1];
  // The tail freeze holds whatever framing the window ended on.
  const t = Math.min(Math.max(tSec, step.startSec), step.endSec);
  const st = evalKeys(step.keys, t, vw, vh);
  return toTransform(st.cx, st.cy, st.z, vw, vh, stage);
}

// Music sits under the VO: ducked across every speech window (min over overlaps),
// with eased ramps plus a fade in at the open and out at the very end.
export function duckedMusicVolume(tSec, speechWindows, durSec = null) {
  let v = MUSIC_BASE;
  for (const w of speechWindows || []) {
    const start = w?.start ?? 0;
    const end = w?.end ?? start;
    if (tSec <= start - MUSIC_RAMP_S || tSec >= end + MUSIC_RAMP_S) continue;
    let level;
    if (tSec < start) {
      const p = easeInOutCubic((tSec - (start - MUSIC_RAMP_S)) / MUSIC_RAMP_S);
      level = MUSIC_BASE + (MUSIC_DUCK - MUSIC_BASE) * p;
    } else if (tSec <= end) {
      level = MUSIC_DUCK;
    } else {
      const p = easeInOutCubic((tSec - end) / MUSIC_RAMP_S);
      level = MUSIC_DUCK + (MUSIC_BASE - MUSIC_DUCK) * p;
    }
    v = Math.min(v, level);
  }
  const fadeIn = Math.min(1, Math.max(0, tSec / MUSIC_FADE_IN_S));
  const fadeOut =
    durSec == null || durSec <= 0
      ? 1
      : Math.min(1, Math.max(0, (durSec - tSec) / MUSIC_FADE_OUT_S));
  return v * fadeIn * fadeOut;
}
