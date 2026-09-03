// The gate for mockup mode, the same shape as diaglint: every finding is a sentence
// the author can act on, and an empty list means render.
//
// Diagrams are judged on whether the picture means what the line says. Mockups are
// judged on something stricter, because the owner decides FROM them: every option
// they are choosing between has to be on screen, the options have to look different
// from each other, and every word has to be readable at the size the video plays.
// Three of those four can only be answered after the browser has drawn the thing,
// so the shots are part of the gate, not a step after it.
import { loadImage, Canvas } from 'skia-canvas';
import { BLOCKS, PINNED, MIN_TYPE, DEVICE_PX_PER_CSS_PX } from './mockup.mjs';

// Readable at 1080 wide. 11px is the smallest type the stylesheet uses and it lands
// at ~19 frame pixels, so this holds today and fails loudly if the CSS shrinks.
const MIN_DEVICE_PX = 16;

// A downsampled greyscale signature. These screens are all dark, so grey mass alone
// separates them by single digits and any threshold on it sits on a knife edge: runs
// were measured failing at 8.8 and passing at 9.1 on screens a person reads as
// different. So the pixels only settle the case where the two screens are built from
// the SAME blocks in the same order, which is what "the same screen with new words"
// actually means; a genuinely different structure has to be near-identical grey
// before it counts as a copy.
const SIG_W = 24, SIG_H = 40;
const SAME_LAYOUT_DISTANCE = 9;
const ANY_LAYOUT_DISTANCE = 5;
// Below this the screen is mostly empty background — a mockup that failed to draw.
const MIN_INK = 0.18;
// The biggest run of empty screen a mockup may carry, in CSS px of a 680px-tall
// phone. Measured: screens that read as full land between 18 and 56, and screens
// that ran out of content land at 130 and up.
const MAX_HOLE = 96;

const EM_DASH = /[—–]/;

const textsOf = (b) => {
  switch (b.type) {
    case 'eyebrow': case 'heading': case 'text': case 'note': case 'button': return [b.text];
    case 'chips': return (b.items || []).map((c) => c.text ?? c);
    case 'rows': return (b.items || []).flatMap((r) => [r.title, r.meta, r.right]);
    case 'cards': return (b.items || []).flatMap((c) => [c.tag, c.title, c.body]);
    case 'stats': return (b.items || []).flatMap((s) => [s.value, s.label]);
    case 'lanes': return (b.items || []).map((l) => l.label);
    case 'sheet': return [b.title, ...(b.options || []).flatMap((o) => [o.label, o.summary])];
    case 'nav': return b.items || [];
    default: return [];
  }
};

/** Every option the packet asks about, as `{id, label}` — what a mockup must cover. */
export function optionsOf(packet) {
  const plan = packet?.plan || {};
  const out = [{ id: 'approach', label: 'the recommended approach' }];
  for (const a of plan.alternatives || []) if (a?.id) out.push({ id: a.id, label: `alternative "${a.id}"` });
  return out;
}

/**
 * Findings against the specs alone — everything that does not need a browser.
 *
 * Returns `{ findings, renderable }`. Only a spec that cannot be drawn at all stops
 * the shots from running: a draft that is merely wrong about its copy still gets
 * screenshotted, so one retry carries BOTH sets of findings. Sending them one layer
 * at a time was measured burning every attempt on an em dash.
 */
export function lintMockupSpec(spec, beats, packet) {
  if (!Array.isArray(spec)) return { findings: ['[shape] expected an array of {beat, mockup} entries'], renderable: false };
  const out = [];
  let renderable = true;
  const names = beats.map((b) => b.name);
  const seen = spec.map((e) => e?.beat);
  for (const n of names) if (!seen.includes(n)) out.push(`[${n}] no entry — every beat needs one, in beat order`);
  for (const e of spec) if (!names.includes(e?.beat)) { out.push(`[${e?.beat}] not a beat name`); renderable = false; }

  const covered = new Set();
  for (const e of spec) {
    const at = `[${e?.beat}]`;
    const m = e?.mockup;
    if (m == null) continue;
    if (!m.title) out.push(`${at} mockup has no title — the screen needs a name in its top bar`);
    if (m.variant) covered.add(m.variant);

    const blocks = Array.isArray(m.blocks) ? m.blocks : [];
    if (blocks.length < 3) out.push(`${at} only ${blocks.length} block(s) — a screen the owner decides from needs at least 3`);
    if (blocks.length > 7) out.push(`${at} ${blocks.length} blocks will not fit a phone screen — use at most 7`);
    blocks.forEach((b, i) => {
      if (!BLOCKS.has(b?.type)) { out.push(`${at} block ${i + 1} type "${b?.type}" is not in the DSL`); renderable = false; }
      else if (PINNED.has(b.type) && i !== blocks.length - 1) out.push(`${at} "${b.type}" pins to the bottom of the screen, so it must be the last block`);
    });
    if (blocks.filter((b) => PINNED.has(b?.type)).length > 1) out.push(`${at} two bottom-pinned blocks would sit on top of each other`);

    // Name the block, because a dash on its own is the usual offender and "an em dash
    // somewhere in this beat" is not a finding anyone can act on.
    blocks.forEach((b, i) => {
      for (const t of textsOf(b)) {
        if (t != null && EM_DASH.test(String(t))) {
          out.push(`${at} block ${i + 1} (${b.type}) has an em dash in "${t}". Use a comma, or write "none" where you meant an empty value.`);
        }
      }
    });
  }

  // The whole point of the mode: the owner is picking between directions, so each
  // direction has to exist as a screen they can look at.
  for (const o of optionsOf(packet)) {
    if (!covered.has(o.id)) out.push(`[coverage] nothing shows ${o.label} — give one beat a mockup with "variant": "${o.id}"`);
  }
  // The hook argues for nothing, so an option parked on it is an option the video
  // shows without ever making its case. Measured: one run put the timeline direction
  // on beat 1 and then never gave it a beat of its own.
  const hook = spec.find((e) => e?.beat === names[0]);
  if (hook?.mockup?.variant) {
    out.push(`[${names[0]}] the first beat is the hook, so it shows today's screen and carries no variant.`
      + ` "${hook.mockup.variant}" needs its own beat, the one that argues for it.`);
  }
  if (MIN_TYPE * DEVICE_PX_PER_CSS_PX < MIN_DEVICE_PX) {
    out.push(`[shape] the stylesheet's smallest type renders at ${(MIN_TYPE * DEVICE_PX_PER_CSS_PX).toFixed(1)}px in a 1080-wide frame, under the ${MIN_DEVICE_PX}px floor`);
  }
  return { findings: out, renderable };
}

// A screenshot reduced to SIG_W x SIG_H greys, so two screens can be compared by
// what they look like rather than by what their specs say.
async function signature(png) {
  const img = await loadImage(png);
  const c = new Canvas(SIG_W, SIG_H);
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0, SIG_W, SIG_H);
  const { data } = ctx.getImageData(0, 0, SIG_W, SIG_H);
  const g = new Float64Array(SIG_W * SIG_H);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return g;
}

const distance = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]);
  return s / a.length;
};

/** Findings only the rendered screenshots can produce. */
export async function lintMockupShots(shots) {
  const out = [];
  for (const s of shots) {
    if (s.overflow > 0) out.push(`[${s.beat}] the content runs ${s.overflow}px past the bottom of the screen — cut a block or shorten the copy`);
    if (s.collide > 1) out.push(`[${s.beat}] two blocks overlap by ${s.collide}px, so one is drawn over the other — cut a block or drop an item`);
    for (const t of s.clipped) out.push(`[${s.beat}] "${t}" is cut off at the edge of the screen — shorten it`);
    if (s.ink < MIN_INK) out.push(`[${s.beat}] the screen renders almost empty (${s.ink}) — it needs real content, not one line`);
    if (!s.texts) out.push(`[${s.beat}] the screen has no text on it at all`);
    if (s.hole > MAX_HOLE) out.push(`[${s.beat}] ${s.hole}px of the screen is empty in one run, out of 680 — add a block, or more items to the ones already there`);
  }

  // Distinctness is only meaningful between the screens the owner is choosing among.
  const byVariant = new Map();
  for (const s of shots) if (s.variant && !byVariant.has(s.variant)) byVariant.set(s.variant, s);
  const list = [...byVariant.values()];
  const sigs = await Promise.all(list.map((s) => signature(s.png)));
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const same = list[i].blocks === list[j].blocks;
      const d = distance(sigs[i], sigs[j]);
      if (d >= (same ? SAME_LAYOUT_DISTANCE : ANY_LAYOUT_DISTANCE)) continue;
      out.push(`[${list[j].beat}] "${list[j].variant}" is the same screen as "${list[i].variant}"`
        + (same ? ` (both are ${list[i].blocks})` : ` (${d.toFixed(1)} apart on the pixels)`)
        + `. Build it out of different blocks: a list is "rows", a dense board is "cards" with columns 2, a time view is "lanes".`);
    }
  }
  return out;
}
