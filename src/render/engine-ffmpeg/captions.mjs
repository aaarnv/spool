// The caption pill (and, on wide, the title subtitle) as a deduplicated PNG state
// sequence: the layer only changes at word boundaries and fade steps, so ffmpeg
// consumes one concat-demuxer input instead of a per-frame overlay.
//
// Plan Spools move the pill into a per-chapter bounds rect, so a caption "variant"
// is one (tokens, bounds) pairing and the active variant is part of the state key.
import { join } from "node:path";
import { FONT_CSS, captionAt, titleAt } from "./scene.mjs";
import { esc, writeConcat } from "./assets.mjs";

const PILL_BG = "rgba(16,16,22,0.86)";
const PILL_BORDER = "1px solid rgba(255,255,255,0.10)";
const PILL_SHADOW = "0 14px 46px rgba(0,0,0,0.42)";
const SPOKEN = "#ffffff";
const MUTED = "rgba(255,255,255,0.72)";
// Shadow reach above the pill, so the clipped band never cuts it.
const SHADOW_BLEED = 60;
const Q = 32;

const q = (v) => Math.round(v * Q) / Q;

function pillCss(tokens) {
  return `max-width:${tokens.maxWidth}px;display:flex;flex-wrap:wrap;justify-content:center;gap:${tokens.gap};padding:${tokens.padding};border-radius:${tokens.borderRadius}px;background:${tokens.surface || PILL_BG};border:${tokens.border || PILL_BORDER};box-shadow:${tokens.shadow || PILL_SHADOW};font-family:${FONT_CSS};font-size:${tokens.fontSize}px;line-height:1.15`;
}

// bounds: centred inside the rect (Plan Spools). No bounds: bottom-centred band.
function wrapperCss(tokens, bounds, canvasW) {
  if (bounds)
    return `position:absolute;left:${bounds.x}px;top:${bounds.y}px;width:${bounds.width}px;height:${bounds.height}px;align-items:center;justify-content:center`;
  return `position:absolute;left:0;bottom:${tokens.paddingBottom}px;width:${canvasW}px;justify-content:center`;
}

export function captionHtml({ phrases, variants, title, canvasW }) {
  const rows = variants
    .map((v, vi) =>
      phrases
        .map(
          (p, i) =>
            `<div class="cw" id="w${vi}_${i}" style="display:none;${wrapperCss(v.tokens, v.bounds, canvasW)}">
        <div id="p${vi}_${i}" style="${pillCss(v.tokens)}">${p.words
          .map(
            (w) =>
              `<span style="color:${v.tokens.mutedText || MUTED};font-weight:${v.tokens.restWeight}">${esc(w.word)}</span>`
          )
          .join("")}</div>
      </div>`
        )
        .join("")
    )
    .join("");
  const titleRow = title
    ? `<div id="tw" style="display:none;position:absolute;left:0;bottom:44px;width:${canvasW}px;justify-content:center">
        <div id="tp" style="padding:18px 34px;border-radius:20px;background:${PILL_BG};border:${PILL_BORDER};box-shadow:${PILL_SHADOW};color:#fff;font-family:${FONT_CSS};font-size:40px;font-weight:600;letter-spacing:-0.01em">${esc(title)}</div>
      </div>`
    : "";
  return rows + titleRow;
}

/** Per-frame states, deduplicated by look. Returns {states, entries}. */
export function captionStates({ phrases, frames, fps, withTitle, variantAt }) {
  const firstCaptionStart = phrases.length ? phrases[0].start : null;
  const byKey = new Map();
  const states = [];
  const entries = [];
  let run = null;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    const cap = captionAt(phrases, t);
    const title = withTitle ? titleAt(t, firstCaptionStart) : null;
    const v = variantAt ? variantAt(f) : 0;
    const capS = cap ? { index: cap.index, variant: v, opacity: q(cap.opacity), spoken: cap.spoken } : null;
    const titleS = title ? { opacity: q(title.opacity), dy: Math.round(title.dy * 4) / 4 } : null;
    const key = !capS && !titleS
      ? "e"
      : `${capS ? `c${capS.variant}_${capS.index}:${capS.opacity}:${capS.spoken.map((b) => (b ? 1 : 0)).join("")}` : ""}|${titleS ? `t${titleS.opacity}:${titleS.dy}` : ""}`;
    let idx = byKey.get(key);
    if (idx === undefined) {
      idx = states.length;
      byKey.set(key, idx);
      states.push({ cap: capS, title: titleS });
    }
    if (run && run.idx === idx) run.frames++;
    else {
      if (run) entries.push(run);
      run = { idx, frames: 1 };
    }
  }
  if (run) entries.push(run);
  return { states, entries };
}

const applyState = ([s, colors]) => {
  for (const e of document.querySelectorAll(".cw")) e.style.display = "none";
  const tw = document.getElementById("tw");
  if (tw) {
    tw.style.display = s.title ? "flex" : "none";
    if (s.title) {
      const tp = document.getElementById("tp");
      tp.style.opacity = String(s.title.opacity);
      tp.style.transform = `translateY(${s.title.dy}px)`;
    }
  }
  if (s.cap) {
    const id = `${s.cap.variant}_${s.cap.index}`;
    document.getElementById("w" + id).style.display = "flex";
    const pill = document.getElementById("p" + id);
    pill.style.opacity = String(s.cap.opacity);
    const spoken = colors.spoken[s.cap.variant];
    const muted = colors.muted[s.cap.variant];
    for (let i = 0; i < pill.children.length; i++) {
      const on = s.cap.spoken[i];
      pill.children[i].style.color = on ? spoken : muted;
      pill.children[i].style.fontWeight = on ? colors.sw[s.cap.variant] : colors.rw[s.cap.variant];
    }
  }
};

/**
 * Rasterise every state to `dir` and write the concat list. Pages run in parallel:
 * a screenshot round-trip dominates, so striping states across contexts is ~linear.
 */
export async function renderCaptionLayer({
  browser,
  dir,
  canvasW,
  canvasH,
  variants,
  phrases,
  title,
  frames,
  fps,
  variantAt = null,
  concurrency = 4,
}) {
  const { states, entries } = captionStates({
    phrases,
    frames,
    fps,
    withTitle: Boolean(title),
    variantAt,
  });
  const html = captionHtml({ phrases, variants, title, canvasW });
  const body = `<body style="margin:0;background:transparent;overflow:hidden">${html}</body>`;

  const probe = await browser.newPage({ viewport: { width: canvasW, height: canvasH }, deviceScaleFactor: 1 });
  await probe.setContent(body, { waitUntil: "load" });
  const maxPill = await probe.evaluate(() => {
    let m = 0;
    for (const e of document.querySelectorAll(".cw")) {
      e.style.display = "flex";
      m = Math.max(m, e.firstElementChild.offsetHeight);
      e.style.display = "none";
    }
    const tp = document.getElementById("tp");
    if (tp) {
      document.getElementById("tw").style.display = "flex";
      m = Math.max(m, tp.offsetHeight);
      document.getElementById("tw").style.display = "none";
    }
    return m;
  });
  await probe.close();

  // A bounded variant can sit anywhere on the canvas, so a plan take clips nothing.
  const bounded = variants.some((v) => v.bounds);
  const bandH = Math.min(canvasH, Math.ceil(variants[0].tokens.paddingBottom + maxPill + SHADOW_BLEED));
  const clip = bounded
    ? { x: 0, y: 0, width: canvasW, height: canvasH }
    : { x: 0, y: canvasH - bandH, width: canvasW, height: bandH };
  const colors = {
    spoken: variants.map((v) => v.tokens.text || SPOKEN),
    muted: variants.map((v) => v.tokens.mutedText || MUTED),
    sw: variants.map((v) => v.tokens.spokenWeight),
    rw: variants.map((v) => v.tokens.restWeight),
  };

  const lanes = Math.max(1, Math.min(concurrency, states.length));
  const pages = [];
  for (let i = 0; i < lanes; i++) {
    const p = await browser.newPage({ viewport: { width: canvasW, height: canvasH }, deviceScaleFactor: 1 });
    await p.setContent(body, { waitUntil: "load" });
    pages.push(p);
  }
  const name = (i) => `cap_${String(i).padStart(4, "0")}.png`;
  await Promise.all(
    pages.map(async (p, lane) => {
      for (let i = lane; i < states.length; i += lanes) {
        await p.evaluate(applyState, [states[i], colors]);
        await p.screenshot({ path: join(dir, name(i)), omitBackground: true, clip });
      }
    })
  );
  await Promise.all(pages.map((p) => p.close()));

  const list = await writeConcat(
    dir,
    "captions.txt",
    entries.map((e) => ({ file: name(e.idx), dur: e.frames / fps }))
  );
  return { list, clip, states: states.length, runs: entries.length };
}
