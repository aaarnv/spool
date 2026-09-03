// Shared retiming math for the record-first pipeline. The capture runs at natural
// interaction speed; here we map each recorded step onto an OUTPUT window sized to
// fit its narration. Imported by the render engine and share.mjs
// (node), so it stays a dependency-free pure module.

export const FPS = 60;

// Output rate per format. Both are 60: footage is 30fps native, so the extra frames
// only smooth the overlays, and wide at 30 was tried, watched and rejected — the
// cost is accepted for the smoother result. SPOOL_RENDER_FPS=30 is the fast knob.
export const defaultFpsFor = (_format) => 60;
export const PAD_S = 0.4; // minimum slack past the narration inside a window
export const TAIL_S = 1; // end hold so the last caption/VO can land

// Windows for a timeline that needs no retiming: each step keeps its own times.
function identityWindows(steps, fps) {
  let totalFrames = 0;
  const windows = steps.map((s) => {
    const startF = Math.round(s.start * fps);
    const endF = Math.round(s.end * fps);
    totalFrames = Math.max(totalFrames, endF);
    const clicks = s.clicks || [];
    return {
      i: s.i,
      name: s.name,
      ...(s.chapterId ? { chapterId: s.chapterId } : {}),
      zoom: s.zoom ?? "auto",
      inF: startF,
      outF: endF,
      recFrames: Math.max(1, endF - startF),
      windowFrames: Math.max(1, endF - startF),
      startF,
      endF,
      startSec: startF / fps,
      endSec: endF / fps,
      recStart: s.start,
      recEnd: s.end,
      clicks,
      outClicks: clicks,
    };
  });
  return { windows, totalFrames };
}

export function voDurationFor(manifest, i) {
  const segs = manifest?.segments;
  if (!Array.isArray(segs)) return 0;
  const seg = segs.find((s) => s.i === i);
  return seg && typeof seg.duration === "number" ? seg.duration : 0;
}

// Per-step output windows: window_i = max(voDur_i + PAD, recorded_i), concatenated
// from t=0. Frame fields are authoritative (metadata + video slicing use them);
// the *Sec fields are the same values in seconds for the second-domain layers
// (zoom, captions, audio placement). Click times are mapped into output time.
export function buildWindows(timeline, manifest, fps = FPS) {
  const steps = timeline?.steps || [];
  // `retimed` marks a timeline that is ALREADY the output clock — a packet video is
  // authored beat by beat, so there is no capture to fit narration into and padding
  // it here would report times the rendered file does not have.
  if (timeline?.retimed) return identityWindows(steps, fps);
  let cursorF = 0;
  const windows = steps.map((s) => {
    const recStart = s.start;
    const recEnd = s.end;
    const inF = Math.round(recStart * fps);
    const outF = Math.round(recEnd * fps);
    const recFrames = Math.max(1, outF - inF);
    const voDur = voDurationFor(manifest, s.i);
    const voFrames = Math.ceil((voDur + PAD_S) * fps);
    const windowFrames = Math.max(voFrames, recFrames);
    const startF = cursorF;
    cursorF += windowFrames;
    const startSec = startF / fps;
    const outClicks = (s.clicks || []).map((c) => ({
      ...c,
      t: +(startSec + (c.t - recStart)).toFixed(3),
    }));
    return {
      i: s.i,
      name: s.name,
      // Plan Spools: carried through so a renderer layer can key a chapter card
      // off the window it belongs to. Absent on every non-plan timeline.
      ...(s.chapterId ? { chapterId: s.chapterId } : {}),
      zoom: s.zoom ?? "auto",
      inF,
      outF,
      recFrames,
      windowFrames,
      startF,
      endF: cursorF,
      startSec,
      endSec: cursorF / fps,
      recStart,
      recEnd,
      clicks: s.clicks || [],
      outClicks,
    };
  });
  return { windows, totalFrames: cursorF };
}
