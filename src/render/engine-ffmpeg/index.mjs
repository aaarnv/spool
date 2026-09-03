// ffmpeg-native walkthrough renderer. Same inputs and same final.mp4 contract as the
// Remotion path: it swaps a per-frame browser screenshot for one filtergraph.
import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildWindows, TAIL_S } from "../retime.mjs";
import { buildCameraTrack, sampleCamera, CTA_S, STAGE } from "../vertical.mjs";
import {
  RIPPLE_BOX,
  createAssetRenderer,
  ctaHtml,
  hookHtml,
  renderBackground,
  renderChrome,
  renderCursor,
  renderMask,
  renderRipples,
  writeConcat,
} from "./assets.mjs";
import { renderCaptionLayer } from "./captions.mjs";
import { buildPlanCards } from "../plan/model.mjs";
import { getPlanTheme, planBgHtml, planStates, renderPlanLayer } from "./plan.mjs";
import { buildAudio } from "./audio.mjs";
import { alphaArgs, encodeArgs, pickEncoder } from "./encode.mjs";
import { buildGraph, rippleSequence } from "./graph.mjs";
import {
  CARD_RADIUS,
  STAGE_RADIUS,
  VERTICAL_CAPTION,
  WIDE_CAPTION,
  buildCursorTrack,
  buildPhrases,
  cardLayout,
  ctaAt,
  durationFrames as outFrames,
  hookAt,
  stepEnvelope,
} from "./scene.mjs";

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const ASSET_DIR = ".spool-ffmpeg";

// Plan captions inherit the theme's surface and sit inside the layout's caption rect.
const planCaptionTokens = (theme, layout) => ({
  ...WIDE_CAPTION,
  fontSize: layout.orientation === "portrait" ? 42 : 30,
  maxWidth: layout.caption.width,
  surface: theme.color.surface,
  border: `1px solid ${theme.color.line}`,
  shadow: theme.shadow,
  text: theme.color.text,
  mutedText: theme.color.mutedText,
});

/** Vertical hook/CTA scrims: one deduplicated PNG per distinct opacity/offset. */
async function renderOverlayLayer(r, { dir, frames, fps, durSec, hook, cta }) {
  const seen = new Map();
  const states = [];
  const runs = [];
  let run = null;
  for (let f = 0; f < frames; f++) {
    const t = f / fps;
    const h = hook ? hookAt(t) : null;
    const c = cta && cta.text ? ctaAt(t, durSec) : null;
    const s = h ? { kind: "hook", ...h } : c ? { kind: "cta", ...c } : null;
    const key = s ? `${s.kind}:${Math.round(s.opacity * 32)}:${Math.round(s.dy * 4)}` : "e";
    let idx = seen.get(key);
    if (idx === undefined) {
      idx = states.length;
      seen.set(key, idx);
      states.push(s ? { ...s, opacity: Math.round(s.opacity * 32) / 32, dy: Math.round(s.dy * 4) / 4 } : null);
    }
    if (run && run.idx === idx) run.frames++;
    else {
      if (run) runs.push(run);
      run = { idx, frames: 1 };
    }
  }
  if (run) runs.push(run);
  if (states.every((s) => s === null)) return null;

  const name = (i) => `ov_${String(i).padStart(4, "0")}.png`;
  await r.still("ov_off.png", "");
  for (const kind of ["hook", "cta"]) {
    const idxs = states.map((s, i) => (s && s.kind === kind ? i : -1)).filter((i) => i >= 0);
    if (!idxs.length) continue;
    await r.load(kind === "hook" ? hookHtml(hook) : ctaHtml(cta));
    for (const i of idxs) {
      const s = states[i];
      await r.page.evaluate((v) => {
        document.getElementById("layer").style.opacity = String(v.opacity);
        document.getElementById("inner").style.transform = `translateY(${v.dy}px)`;
      }, s);
      await r.shot(name(i));
    }
  }
  return writeConcat(
    dir,
    "overlays.txt",
    runs.map((e) => ({ file: states[e.idx] ? name(e.idx) : "ov_off.png", dur: e.frames / fps }))
  );
}

function runFfmpeg(args, { nice, label, durSec }) {
  return new Promise((resolve, reject) => {
    const cmd = nice ? "nice" : FFMPEG;
    const argv = nice ? ["-n", "10", FFMPEG, ...args] : args;
    const p = spawn(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    let lastPct = -1;
    p.stdout.on("data", (b) => {
      const m = /out_time_ms=(\d+)/.exec(String(b));
      if (!m) return;
      const pct = Math.floor((Number(m[1]) / 1e6 / durSec) * 100);
      if (pct !== lastPct && pct % 10 === 0 && pct <= 100) {
        console.log(`[render] ${label} ${pct}%`);
        lastPct = pct;
      }
    });
    p.stderr.on("data", (b) => {
      err += b;
      if (err.length > 40000) err = err.slice(-40000);
    });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}\n${err}`))));
  });
}

/**
 * Render `props` (the same inputProps the composition used to receive) to `out`.
 * `fgOut` additionally writes the composite minus the wallpaper as VP9-with-alpha.
 */
export async function renderFfmpeg({ dir, props, out, preview = false, master = false, fgOut = null }) {
  const t0 = Date.now();
  const fps = props.fps;
  const isVertical = props.format === "vertical";
  const canvasW = isVertical ? 1080 : 1920;
  const canvasH = isVertical ? 1920 : 1080;

  const { windows, totalFrames } = buildWindows(props.timeline, props.manifest || { segments: [] }, fps);
  const frames = outFrames(totalFrames, fps, isVertical);
  const durSec = frames / fps;
  const tailFrames = Math.round((TAIL_S + (isVertical ? CTA_S : 0)) * fps);

  // Plan Spools swap the wallpaper for a themed canvas, park the footage in a
  // reserved rect that only overlay chapters show, and move captions into bounds.
  let plan = null;
  if (props.plan && props.planScript) {
    const theme = getPlanTheme(props.planTheme || "warm-briefing");
    const cards = buildPlanCards({ plan: props.plan, evidence: props.evidence, script: props.planScript });
    const st = planStates({
      cards, script: props.planScript, windows, timeline: props.timeline,
      frames, fps, canvasW, canvasH, theme,
    });
    if (st.states.some(Boolean)) plan = { theme, ...st };
  }
  const isPlan = Boolean(plan);
  const card = cardLayout(
    props.timeline?.viewport,
    canvasW,
    canvasH,
    isPlan ? plan.overlayLayout.media : null
  );

  const assetDir = join(dir, ASSET_DIR);
  await rm(assetDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(assetDir, { recursive: true });

  const cursorTrack = buildCursorTrack(props.timeline?.cursor, windows);
  const clicks = cursorTrack ? windows.flatMap((w) => w.outClicks || []) : [];
  const phrases = buildPhrases(props.manifest || { segments: [] }, windows, isVertical ? 4 : 6);
  // Plan takes never zoom: the footage sits in a fixed rect beside the cards.
  const envelopes = isPlan
    ? windows.map(() => null)
    : windows.map((w) =>
        stepEnvelope({ zoom: w.zoom, clicks: w.outClicks, start: w.startSec, end: w.endSec }, card)
      );
  // Master only: build the card layer at the peak zoom so the footage is upscaled once
  // rather than shrunk to card size and blown back up. Costs ~40% wall time for a
  // sharper zoom apex, which is the wrong trade while iterating.
  const peaks = envelopes.filter(Boolean).map((e) => e.peak);
  const superSample = master && !isVertical && peaks.length ? Math.min(2, Math.max(...peaks)) : 1;
  const spriteScale = isVertical ? 1 : card.scale * superSample;
  const layerW = Math.round(canvasW * superSample);
  const layerH = Math.round(canvasH * superSample);

  const r = await createAssetRenderer({ canvasW: layerW, canvasH: layerH, dir: assetDir });
  let assets;
  let captionLayer;
  let overlayList = null;
  let planLayer = null;
  let ripple = null;
  try {
    const box = isVertical
      ? { ...STAGE, radius: STAGE_RADIUS }
      : {
          x: Math.round(card.x * superSample),
          y: Math.round(card.y * superSample),
          w: Math.round(card.w * superSample),
          h: Math.round(card.h * superSample),
          radius: (isPlan ? plan.theme.radius.item : CARD_RADIUS) * superSample,
        };
    assets = {
      chrome: join(assetDir, await renderChrome(r, box)),
      mask: join(assetDir, await renderMask(r, { w: box.w, h: box.h, radius: box.radius })),
    };
    if (cursorTrack) assets.cursor = join(assetDir, (await renderCursor(r, { spriteScale })).name);
    if (clicks.length) {
      const rip = await renderRipples(r, { spriteScale, fps });
      await r.still("ripple_off.png", "", { clip: { x: 0, y: 0, width: rip.size, height: rip.size } });
      const half = (RIPPLE_BOX / 2) * spriteScale;
      const seq = rippleSequence({
        clicks,
        frames,
        fps,
        names: rip.names,
        at: (c) => ({ x: c.x * spriteScale - half, y: c.y * spriteScale - half }),
      });
      ripple = {
        ...seq,
        list: await writeConcat(assetDir, "ripples.txt", seq.entries.map((e) => ({ file: e.file, dur: e.frames / fps }))),
      };
    }
    await r.size(canvasW, canvasH);
    if (isPlan) {
      assets.bg = join(assetDir, await r.still("bg.png", planBgHtml(plan.theme), { opaque: true, bg: "#000" }));
      planLayer = await renderPlanLayer({
        browser: r.browser,
        dir: assetDir,
        canvasW,
        canvasH,
        fps,
        theme: plan.theme,
        states: plan.states,
        runs: plan.runs,
      });
    } else {
      const bgPath = props.background ? join(dir, props.background) : null;
      assets.bg = join(assetDir, await renderBackground(r, { canvasW, canvasH, bgPath }));
    }
    if (isVertical && !isPlan && props.vertical) {
      overlayList = await renderOverlayLayer(r, {
        dir: assetDir,
        frames,
        fps,
        durSec,
        hook: props.vertical.hook,
        cta: props.vertical.cta,
      });
    }
    const variants = isPlan
      ? plan.layouts.map(({ layout }) => ({ tokens: planCaptionTokens(plan.theme, layout), bounds: layout.caption }))
      : [{ tokens: isVertical ? VERTICAL_CAPTION : WIDE_CAPTION, bounds: null }];
    const variantAt = isPlan
      ? (f) => Math.max(0, plan.layouts.findIndex((v) => v.mode === plan.modeByFrame[f]))
      : null;
    captionLayer = phrases.length
      ? await renderCaptionLayer({
          browser: r.browser,
          dir: assetDir,
          canvasW,
          canvasH,
          variants,
          variantAt,
          phrases,
          title: isVertical || isPlan ? null : props.title,
          frames,
          fps,
        })
      : null;
  } finally {
    await r.close();
  }
  assets.captionList = captionLayer ? captionLayer.list : null;
  assets.overlayList = overlayList;
  assets.planList = planLayer ? planLayer.list : null;
  console.log(
    `[render] assets: ${r.shots + (captionLayer ? captionLayer.states : 0)} layers (${captionLayer ? captionLayer.states : 0} caption states) in ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );

  const camTrack = isVertical && !isPlan ? buildCameraTrack(windows, { width: card.vw, height: card.vh }) : null;
  const ctx = {
    dir,
    fps,
    canvasW,
    canvasH,
    durSec,
    durationFrames: frames,
    tailFrames,
    isVertical: isVertical && !isPlan,
    isPlan,
    planMediaSpans: isPlan ? plan.mediaSpans : null,
    card,
    windows,
    videoPath: join(dir, "video.mp4"),
    assets,
    captionClip: captionLayer ? captionLayer.clip : null,
    cursorTrack,
    clicks,
    ripple,
    envelopes,
    superSample,
    sampleCam: (t) => sampleCamera(camTrack, t, { width: card.vw, height: card.vh }),
    previewScale: preview ? 0.5 : null,
    fgLayer: Boolean(fgOut),
    segments: props.manifest?.segments || [],
    musicPath: isVertical && props.vertical?.music ? join(dir, props.vertical.music) : null,
    speechWindows: (props.manifest?.segments || []).map((seg) => {
      const w = windows.find((x) => x.i === seg.i);
      const start = w ? w.startSec : 0;
      return { start, end: start + (seg.duration || 0) };
    }),
  };

  const { g, video, fgVideo } = buildGraph(ctx);
  const audio = buildAudio(g, ctx);
  const scriptPath = join(assetDir, "graph.txt");
  await writeFile(scriptPath, g.text() + "\n");

  const enc = await pickEncoder({ preview, master });
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-progress", "pipe:1",
    "-y",
    ...g.inputs,
    "-filter_complex_script", scriptPath,
    "-map", video,
    ...(audio ? ["-map", `[${audio}]`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"] : ["-an"]),
    ...encodeArgs(enc),
    "-t", durSec.toFixed(3),
    out,
    // Second output off the same graph: the footage is decoded and zoomed once.
    ...(fgVideo ? ["-map", fgVideo, "-an", ...alphaArgs(), "-t", durSec.toFixed(3), fgOut] : []),
  ];
  if (fgVideo) await mkdir(dirname(fgOut), { recursive: true });
  console.log(`[render] ffmpeg ${g.n} inputs, ${g.chains.length} chains, ${enc.name} (${enc.tier})${fgVideo ? " + vp9 alpha" : ""}`);
  await runFfmpeg(args, { nice: enc.nice, label: "encode", durSec });

  if (!process.env.SPOOL_FFMPEG_KEEP) await rm(assetDir, { recursive: true, force: true }).catch(() => {});
  return { out, frames, fps, seconds: (Date.now() - t0) / 1000 };
}
