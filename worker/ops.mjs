// Pure edit-ops applier (EDIT-CONTRACT "Ops JSON"). Operates on the loaded
// timeline.json + vo/manifest.json. Op indices are POSITIONAL in the current step
// order and apply sequentially (a remove/reorder shifts later indices). Each step is
// paired with its VO segment by the original recording index `i`; that pairing (and
// the vo/seg_<i>.wav on disk + the video.mp4 slice at [start,end]) is preserved
// through remove/reorder, so the renderer needs no video re-encode.

import { BG_PRESET_NAMES } from "../src/render/bg-presets.mjs";

function assertPos(i, len, op) {
  if (!Number.isInteger(i) || i < 0 || i >= len) throw new Error(`${op}: index ${i} out of range (0..${len - 1})`);
}

export function applyOps({ timeline, manifest, ops }) {
  if (!Array.isArray(ops) || ops.length === 0) throw new Error("no ops");
  const segByI = new Map((manifest.segments || []).map((s) => [s.i, s]));
  // Ordered items: each pairs a timeline step with its segment (deep-copied so we
  // never mutate the caller's originals). seg is null for un-narrated steps.
  let items = (timeline.steps || []).map((step) => ({
    step: { ...step },
    seg: segByI.has(step.i) ? { ...segByI.get(step.i) } : null,
    retts: false,
  }));

  let rate = null; // null ⇒ keep the published rate
  let bg = null; // null ⇒ keep the published bg
  let title = timeline.title ?? manifest.title ?? null;

  for (const op of ops) {
    switch (op.op) {
      case "remove_step":
        assertPos(op.i, items.length, "remove_step");
        items.splice(op.i, 1);
        break;
      case "reorder": {
        const order = op.order;
        if (!Array.isArray(order) || order.length !== items.length) throw new Error("reorder: order must be a permutation of current steps");
        const seen = new Set();
        for (const k of order) {
          assertPos(k, items.length, "reorder");
          if (seen.has(k)) throw new Error("reorder: duplicate index");
          seen.add(k);
        }
        items = order.map((k) => items[k]);
        break;
      }
      case "set_narration": {
        assertPos(op.i, items.length, "set_narration");
        const it = items[op.i];
        const text = String(op.text ?? "");
        if (!it.seg) it.seg = { i: it.step.i, name: it.step.name, wav: `vo/seg_${String(it.step.i).padStart(2, "0")}.wav`, words: `vo/seg_${String(it.step.i).padStart(2, "0")}.words.json` };
        it.seg.narration = text;
        it.step.narration = text; // keep the timeline self-describing
        it.retts = true;
        break;
      }
      case "set_title":
        title = String(op.title ?? "");
        break;
      case "set_zoom":
        assertPos(op.i, items.length, "set_zoom");
        items[op.i].step.zoom = op.zoom;
        break;
      case "set_rate": {
        const r = Number(op.rate);
        if (!(r >= 0.75 && r <= 2)) throw new Error(`set_rate: rate ${op.rate} out of [0.75, 2]`);
        rate = r;
        break;
      }
      case "set_bg": {
        // Presets only through the editor — no arbitrary paths/URLs.
        if (!BG_PRESET_NAMES.includes(op.bg)) throw new Error(`set_bg: "${op.bg}" is not a preset (${BG_PRESET_NAMES.join("|")})`);
        bg = op.bg;
        break;
      }
      default:
        throw new Error(`unknown op "${op.op}"`);
    }
  }

  // Rebuild the source docs from the edited ordered items. Step order changes;
  // original `i` values are kept (non-contiguous is fine — the renderer sequences
  // by array order and matches segments by i).
  const steps = items.map((it) => it.step);
  const segments = items.map((it) => it.seg).filter((s) => s && String(s.narration ?? "").trim());
  const newTimeline = { ...timeline, title, steps, total: undefined };
  delete newTimeline.total; // renderer recomputes; a stale total would mislead consumers
  const newManifest = { ...manifest, segments };
  // Re-TTS jobs carry the original recording index (the wav path + pairing key).
  const retts = items.filter((it) => it.retts).map((it) => ({ i: it.step.i, name: it.step.name, narration: it.seg.narration }));

  return { timeline: newTimeline, manifest: newManifest, rate, bg, retts };
}
