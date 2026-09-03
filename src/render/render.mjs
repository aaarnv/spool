import { readFile, writeFile, unlink, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderFfmpeg } from "./engine-ffmpeg/index.mjs";
import { normalize, h264Encoder } from "./normalize.mjs";
import { defaultFpsFor } from "./retime.mjs";
import { resolveBgSource } from "./bg-resolve.mjs";
import { resolveMusicSource, DEFAULT_MUSIC } from "./music-presets.mjs";
import { getPlanTheme } from "./plan/themes.mjs";
import { resolveBgPref, resolveFormatPref } from "../config/prefs.mjs";
import { observe } from "../reliability/journal.mjs";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

// A workdir's steps.mjs `config`, best-effort: {} when there's no snapshot (OS
// sessions, worker re-renders) or it fails to import. The counter keeps the
// cache-buster unique: two imports in the same millisecond would share a URL.
let importSeq = 0;
async function readWorkdirConfig(dir) {
  const sf = join(dir, "steps.mjs");
  if (!existsSync(sf)) return {};
  try {
    return (await import(pathToFileURL(sf).href + `?t=${Date.now()}-${importSeq++}`)).config || {};
  } catch {
    return {};
  }
}

// Render format for a workdir: flag > steps.mjs config.format > SPOOL_FORMAT > prefs > "wide".
// Exported so a caller can resolve once and pass the same format to VO and render.
export async function resolveWorkdirFormat(dir, explicit) {
  const cfg = await readWorkdirConfig(resolve(dir));
  return resolveFormatPref(explicit ?? cfg.format);
}

const hostOf = (u) => {
  try {
    return new URL(u).hostname;
  } catch {
    return "spoolkit.dev";
  }
};

// Vertical authoring fields: steps.mjs config wins, then the previous render.json
// (the edit worker re-renders from published sources, with no steps.mjs), then defaults.
function resolveVertical(cfg, prior, timeline) {
  return {
    hook: cfg.hook ?? prior.hook ?? timeline.title ?? null,
    cta: cfg.cta ?? prior.cta ?? { text: "See the full walkthrough", url: hostOf(timeline.url) },
    music: cfg.music ?? prior.music ?? DEFAULT_MUSIC,
  };
}

// Everything a render decides before it touches ffmpeg: the canvas, the
// format, and (vertical) the authored hook/cta/music bed. One resolution pass, so a
// local render and a cloud render of the same workdir agree.
async function resolveRenderPlan(dir, { rate = 1, bg = null, format = null, fps = null } = {}) {
  // No explicit --bg: fall back to env SPOOL_BG / prefs.bg before the default.
  const bgSpec = bg != null ? bg : await resolveBgPref();
  const timeline = await readJson(join(dir, "timeline.json"));
  const cfg = await readWorkdirConfig(dir);
  const fmt = await resolveFormatPref(format ?? cfg.format);
  // Previous stamp: the worker's only source for the vertical authoring fields.
  const priorRender = existsSync(join(dir, "render.json")) ? await readJson(join(dir, "render.json")).catch(() => ({})) : {};
  const isPlan = existsSync(join(dir, "plan.json"));
  // Warm briefing is the founder-selected default. A workdir config or prior
  // render stamp still wins and is validated here.
  const planTheme = isPlan
    ? getPlanTheme(cfg.planTheme ?? priorRender.planTheme ?? "warm-briefing").id
    : null;
  const vertical = fmt === "vertical" ? resolveVertical(cfg, priorRender.vertical || {}, timeline) : null;
  const bgSource = await resolveBgSource(bgSpec);
  const music = vertical ? resolveMusicSource(vertical.music) : null;
  const envFps = process.env.SPOOL_RENDER_FPS ? Math.max(1, parseInt(process.env.SPOOL_RENDER_FPS, 10)) : null;
  const outFps = fps ?? envFps ?? defaultFpsFor(fmt);
  return { rate, timeline, fmt, fps: outFps, vertical, bgSource, music, musicTag: vertical ? (music ? music.tag : "none") : null, isPlan, planTheme };
}

// The render.json a plan stamps: the rate final.mp4 runs on, which canvas was used,
// the format, and (vertical) the resolved authoring fields a re-render needs.
function planStamp({ rate, bgSource, fmt, fps, vertical, musicTag, planTheme }, extra = {}) {
  return {
    rate: rate && rate !== 1 ? rate : 1,
    bg: bgSource.tag,
    format: fmt,
    // Stamped because the share layer rebuilds the same output windows and its
    // rounding has to land on the rate final.mp4 was actually cut at.
    fps,
    ...(planTheme ? { planTheme } : {}),
    ...(vertical ? { vertical: { hook: vertical.hook, cta: vertical.cta, music: musicTag } } : {}),
    ...extra,
  };
}

/**
 * The render.json a `spool render <dir>` with these options would stamp, without
 * rendering: `{ rate, bg, format }` plus `vertical: { hook, cta, music }` on vertical
 * spools. Same resolution renderSpool uses (steps.mjs config > prior render.json >
 * defaults), so the cloud client can ship the intent for the worker to render from.
 */
export async function resolveRenderIntent(dir, opts = {}) {
  return planStamp(await resolveRenderPlan(resolve(dir), opts));
}

// Speed the fully-rendered mp4 by `rate` in one pass: video via setpts, audio via
// atempo (pitch-preserving). Everything (captions, zooms, VO placement) was laid
// out at natural speed, so compressing the whole clip keeps it in sync.
async function speedUp(src, dst, rate) {
  const enc = await h264Encoder();
  await exec(FFMPEG, [
    "-y",
    "-i",
    src,
    "-filter_complex",
    `[0:v]setpts=PTS/${rate}[v];[0:a]atempo=${rate}[a]`,
    "-map",
    "[v]",
    "-map",
    "[a]",
    "-c:v",
    enc.name,
    ...enc.args,
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-movflags",
    "+faststart",
    dst,
  ]);
}

/**
 * Render a spool workdir to <workdir>/final.mp4.
 *
 * Reads timeline.json + vo/manifest.json, normalizes the capture to CFR H264,
 * then hands the resolved props to the ffmpeg engine, which rasterises the
 * static layers once in a browser and composites the rest in one filtergraph.
 * Pacing is narration-driven (each step's window fits its VO), so `rate`
 * defaults to 1.0; when set it speeds the whole clip and the rate used is
 * stamped into <workdir>/render.json for the share layer.
 *
 * `preview` renders a fast half-scale draft (ultrafast x264, crf 28, no --rate
 * pass, no render.json stamp) to <workdir>/share/preview.mp4; final.mp4 untouched.
 *
 * `format` picks the canvas: "wide" (1920x1080) or "vertical" (1080x1920 short-form,
 * with a hook card, a music bed and an end CTA). Null resolves per resolveWorkdirFormat.
 *
 * @param {string|{workdir:string, preview?:boolean, format?:string|null}} opts
 */
/**
 * Render one take, and journal whether it worked (roadmap R6.3).
 *
 * A render either produces the mp4 or it does not; the reliability question is
 * how often the second happens on already-captured input, because that is work a
 * person has to notice and re-run.
 */
export async function renderSpool(opts) {
  const workdir = typeof opts === "string" ? opts : opts?.workdir;
  return observe("render", () => renderSpoolInner(opts), { target: workdir });
}

async function renderSpoolInner(opts) {
  const { workdir, rate = 1, bg = null, preview = false, format = null, fps = null } = typeof opts === "string" ? { workdir: opts } : opts;
  // Two tiers, decided by what the render is for rather than by a flag: a preview is a
  // draft nobody publishes, and every final.mp4 is a master because publishing is the
  // default end of the pipeline.
  const master = !preview;
  const dir = resolve(workdir);
  const plan = await resolveRenderPlan(dir, { rate, bg, format, fps });
  const { timeline, fmt, vertical, bgSource, music: musicSource, musicTag, isPlan, planTheme } = plan;
  const manifest = await readJson(join(dir, "vo", "manifest.json"));

  // normalize video.webm -> video.mp4 (staticFile target)
  await normalize(dir);

  // Inline each segment's word timings so the browser render has them in props.
  const segments = [];
  for (const seg of manifest.segments || []) {
    let wordsData = [];
    const wpath = join(dir, seg.words);
    if (seg.words && existsSync(wpath)) {
      wordsData = await readJson(wpath);
    } else {
      console.warn(`[render] missing words file for segment ${seg.i}: ${seg.words}`);
    }
    segments.push({ ...seg, wordsData });
  }
  const enrichedManifest = { ...manifest, segments };
  const planPacket = isPlan ? await readJson(join(dir, "plan.json")) : null;
  const planScript = isPlan && existsSync(join(dir, "plan.script.json"))
    ? await readJson(join(dir, "plan.script.json"))
    : null;
  const evidence = isPlan && existsSync(join(dir, "evidence.json"))
    ? await readJson(join(dir, "evidence.json"))
    : null;

  // Wallpaper canvas: copy the resolved bg (preset | macOS wallpaper | path |
  // default) into the workdir. Gradient fallback when the asset is somehow absent.
  let background = null;
  if (existsSync(bgSource.source)) {
    await copyFile(bgSource.source, join(dir, ".spool-bg.jpg"));
    background = ".spool-bg.jpg";
  }

  // Vertical music bed: same staging deal as the wallpaper. The tag is stamped so a
  // re-render resolves the same bed.
  let music = null;
  if (vertical) {
    if (musicSource && existsSync(musicSource.source)) {
      await copyFile(musicSource.source, join(dir, ".spool-music.m4a"));
      music = ".spool-music.m4a";
    } else if (musicSource) {
      console.warn(`[render] music bed "${musicTag}" not found on disk; rendering without one`);
    }
  }

  // Resolved once with the rest of the plan (flag > SPOOL_RENDER_FPS > per-format
  // default), so the stamp, the window math and the encoded rate cannot disagree.
  const outFps = plan.fps;

  const inputProps = {
    timeline,
    manifest: enrichedManifest,
    title: timeline.title || manifest.title || null,
    background,
    workdir: dir,
    format: fmt,
    fps: outFps,
    vertical: vertical ? { ...vertical, music } : null,
    ...(planPacket && planScript ? { plan: planPacket, evidence, planScript, planTheme } : {}),
  };

  let finalOut = join(dir, "final.mp4");
  if (preview) {
    finalOut = join(dir, "share", "preview.mp4");
    await mkdir(join(dir, "share"), { recursive: true });
  }
  const speedUpNeeded = !preview && rate && rate !== 1;
  // The alpha foreground (every layer but the wallpaper) rides beside final.mp4 so a
  // later background change is one overlay pass. A plan take has no wallpaper to swap,
  // and a --rate take would need the layer sped up in lockstep, so both keep re-rendering.
  const fgOut = master && !isPlan && !speedUpNeeded ? join(dir, "layers", "fg.webm") : null;
  // At natural speed render straight to final.mp4; otherwise to an intermediate
  // that the speed pass consumes.
  const renderOut = speedUpNeeded ? join(dir, "render.mp4") : finalOut;
  const t0 = Date.now();
  let renderedFrames;

  const res = await renderFfmpeg({ dir, props: inputProps, out: renderOut, preview, master, fgOut });
  renderedFrames = res.frames;

  if (speedUpNeeded) {
    console.log(`[render] speeding up ${rate}x -> final.mp4`);
    await speedUp(renderOut, finalOut, rate);
    await unlink(renderOut).catch(() => {});
  }

  if (preview) {
    // No render.json stamp: it describes final.mp4, which a preview never touches.
    console.log(`[render] preview wrote ${finalOut} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
    return finalOut;
  }

  // Stamp the rate + bg + format so `spool share`/re-renders know final.mp4's clock
  // differs from timeline.json/video.mp4, which canvas was used, and (vertical) the
  // authored hook/cta/music a worker re-render has no steps.mjs to read.
  await writeFile(
    join(dir, "render.json"),
    JSON.stringify(planStamp(plan, fgOut ? { fg: "layers/fg.webm" } : {}), null, 2) + "\n"
  );

  // Wall clock is the only handle on render cost; the Fly worker's 32-minute vertical
  // was invisible because this path never timed itself.
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[render] wrote ${finalOut} (${secs}s, ${renderedFrames} frames @ ${outFps}fps)`);
  return finalOut;
}

// Direct CLI: node src/render/render.mjs --workdir <dir> [--preview]
const isMain = resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv;
  const wIdx = argv.indexOf("--workdir");
  const workdir = wIdx >= 0 ? argv[wIdx + 1] : argv[2];
  const preview = argv.includes("--preview");
  if (!workdir) {
    console.error("usage: node src/render/render.mjs --workdir <dir> [--preview]");
    process.exit(1);
  }
  renderSpool({ workdir, preview })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[render] failed:", err);
      process.exit(1);
    });
}
