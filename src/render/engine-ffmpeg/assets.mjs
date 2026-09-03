// One-shot static layers. Everything the walkthrough draws that is not the footage
// is a browser-rasterised PNG, so the design keeps its exact CSS (fonts, shadows,
// blur) instead of being re-derived in a filter.
import { chromium } from "playwright";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { CARD_SHADOW, CURSOR_PATH, FONT_CSS, RIPPLE_S, SCRIM, rippleAt } from "./scene.mjs";

const GRADIENT = [
  "radial-gradient(90% 80% at 82% 12%, rgba(150,54,124,0.55) 0%, rgba(150,54,124,0) 55%)",
  "radial-gradient(85% 85% at 12% 92%, rgba(46,58,150,0.50) 0%, rgba(46,58,150,0) 60%)",
  "radial-gradient(70% 60% at 50% 45%, rgba(88,52,140,0.30) 0%, rgba(88,52,140,0) 70%)",
  "linear-gradient(155deg, #171432 0%, #241a45 45%, #33184a 100%)",
].join(",");

const page$ = (body, bg = "transparent") =>
  `<body style="margin:0;width:100%;height:100%;background:${bg};overflow:hidden">${body}</body>`;

export async function createAssetRenderer({ canvasW, canvasH, dir }) {
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: canvasW, height: canvasH },
    deviceScaleFactor: 1,
  });
  let shots = 0;
  return {
    page,
    browser,
    get shots() {
      return shots;
    },
    async size(w, h) {
      await page.setViewportSize({ width: w, height: h });
    },
    async load(body, bg = "transparent") {
      await page.setContent(page$(body, bg), { waitUntil: "load" });
    },
    async shot(name, { clip = null, opaque = false } = {}) {
      shots++;
      await page.screenshot({ path: join(dir, name), omitBackground: !opaque, clip: clip || undefined });
      return name;
    },
    async still(name, body, opts = {}) {
      await this.load(body, opts.bg ?? "transparent");
      return this.shot(name, opts);
    },
    close: () => browser.close(),
  };
}

// setContent leaves the page on about:blank, where Chrome blocks file:// reads.
async function dataUri(path) {
  const ext = extname(path).toLowerCase();
  const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  return `data:${mime};base64,${(await readFile(path)).toString("base64")}`;
}

/** The wallpaper canvas: the resolved image cover-cropped, else the gradient. */
export async function renderBackground(r, { canvasW, canvasH, bgPath }) {
  const img = bgPath
    ? `<img src="${await dataUri(bgPath)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover">`
    : "";
  const body = `<div style="position:absolute;inset:0;background:${GRADIENT}"></div>${img}`;
  return r.still("bg.png", body, { opaque: true, bg: "#000" });
}

/**
 * The card's elevation shadow with a transparent rounded hole where the footage
 * goes: an outer box-shadow is never painted inside its own border box, so one
 * screenshot of a background-less card gives exactly the chrome and nothing else.
 */
export async function renderChrome(r, { x, y, w, h, radius }) {
  const body = `<div style="position:absolute;left:${x}px;top:${y}px;width:${w}px;height:${h}px;border-radius:${radius}px;box-shadow:${CARD_SHADOW}"></div>`;
  return r.still("chrome.png", body);
}

/** Rounded-rect luma mask for alphamerge — what `overflow:hidden` does in CSS. */
export async function renderMask(r, { w, h, radius }) {
  const body = `<div style="position:absolute;left:0;top:0;width:${w}px;height:${h}px;border-radius:${radius}px;background:#fff"></div>`;
  return r.still("mask.png", body, { opaque: true, bg: "#000", clip: { x: 0, y: 0, width: w, height: h } });
}

// Arrow sprite at its on-screen size. PAD leaves room for the drop shadow, and the
// same PAD offsets the overlay position back onto the hotspot.
export const CURSOR_PAD = 4;
export const CURSOR_BOX = 24 + 2 * CURSOR_PAD;

export async function renderCursor(r, { spriteScale }) {
  const w = Math.ceil(CURSOR_BOX * spriteScale);
  const body = `<div style="position:absolute;left:0;top:0;width:${CURSOR_BOX}px;height:${CURSOR_BOX}px;transform:scale(${spriteScale});transform-origin:0 0">
    <svg width="24" height="24" viewBox="0 0 24 24" style="display:block;overflow:visible;position:absolute;left:${CURSOR_PAD}px;top:${CURSOR_PAD}px;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.4))">
      <path d="${CURSOR_PATH}" fill="#fff" stroke="#000" stroke-width="1.3" stroke-linejoin="round"/>
    </svg></div>`;
  await r.still("cursor.png", body, { clip: { x: 0, y: 0, width: w, height: w } });
  return { name: "cursor.png", size: w };
}

// Click ripple. Every click plays the same animation, so the states are rendered
// once and repositioned per click by the overlay expression.
export const RIPPLE_BOX = 96;

export async function renderRipples(r, { spriteScale, fps }) {
  const box = Math.ceil(RIPPLE_BOX * spriteScale);
  const frames = Math.max(1, Math.round(RIPPLE_S * fps));
  const c = RIPPLE_BOX / 2;
  await r.load(`<div id="wrap" style="position:absolute;left:0;top:0;width:${RIPPLE_BOX}px;height:${RIPPLE_BOX}px;transform:scale(${spriteScale});transform-origin:0 0">
    <div id="r" style="position:absolute;left:${c}px;top:${c}px;width:16px;height:16px;margin:-8px 0 0 -8px;border-radius:50%;border:2px solid rgba(40,120,255,0.9);box-sizing:border-box"></div></div>`);
  const names = [];
  for (let f = 0; f < frames; f++) {
    const st = rippleAt({ t: 0 }, f / fps) || { scale: 0.3, opacity: 0 };
    await r.page.evaluate(
      (s) => {
        const e = document.getElementById("r");
        e.style.transform = `scale(${s.scale})`;
        e.style.opacity = String(s.opacity);
      },
      st
    );
    names.push(await r.shot(`ripple_${String(f).padStart(3, "0")}.png`, { clip: { x: 0, y: 0, width: box, height: box } }));
  }
  return { names, size: box, frames };
}

export const hookHtml = (hook) =>
  `<div id="layer" style="position:absolute;inset:0;background:${SCRIM};display:flex;align-items:center;justify-content:center;padding:0 70px">
    <div id="inner" style="text-align:center;color:#fff;font-family:${FONT_CSS};font-size:84px;font-weight:700;line-height:1.1;letter-spacing:-0.02em">${esc(hook)}</div>
  </div>`;

export const ctaHtml = (cta) =>
  `<div id="layer" style="position:absolute;inset:0;background:${SCRIM};display:flex;align-items:center;justify-content:center;padding:0 70px">
    <div id="inner" style="text-align:center;font-family:${FONT_CSS}">
      <div style="color:#fff;font-size:64px;font-weight:700;line-height:1.15;letter-spacing:-0.02em">${esc(cta.text)}</div>
      ${cta.url ? `<div style="margin-top:26px;color:rgba(255,255,255,0.78);font-size:40px;font-weight:500">${esc(cta.url)}</div>` : ""}
    </div>
  </div>`;

export function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
}

/** ffconcat list: one PNG per state, held for `dur` seconds. */
export async function writeConcat(dir, name, entries) {
  const lines = ["ffconcat version 1.0"];
  for (const e of entries) {
    lines.push(`file '${e.file}'`, `duration ${e.dur.toFixed(6)}`);
  }
  if (entries.length) lines.push(`file '${entries[entries.length - 1].file}'`);
  const p = join(dir, name);
  await writeFile(p, lines.join("\n") + "\n");
  return p;
}
