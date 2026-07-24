import { readFile, writeFile, unlink, copyFile, mkdir, cp, rm, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { cpus, tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { normalize, h264Encoder } from "./normalize.mjs";
import { resolveBgSource } from "./bg-resolve.mjs";
import { resolveBgPref } from "../config/prefs.mjs";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "index.mjs");
const require = createRequire(import.meta.url);

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

// Cache the Remotion webpack bundle across builds. The compile depends only on
// src/render/** + the remotion version, so key the cache dir on their hash and
// reuse it when unchanged; per-spool static assets are synced into its public/
// folder each render (staticFile resolves against <serveUrl>/public).
async function srcHash() {
  const h = createHash("sha1");
  const files = (await readdir(__dirname)).filter((f) => /\.(mjs|jsx|js)$/.test(f)).sort();
  for (const f of files) {
    const s = await stat(join(__dirname, f));
    h.update(f).update(String(Math.round(s.mtimeMs)));
  }
  h.update(require("remotion/package.json").version);
  return h.digest("hex").slice(0, 16);
}

async function getServeUrl() {
  const cacheDir = join(tmpdir(), `spool-remotion-${await srcHash()}`);
  if (existsSync(join(cacheDir, "index.html"))) {
    console.log("[render] reusing cached Remotion bundle");
    return cacheDir;
  }
  console.log("[render] bundling Remotion project (cache miss)...");
  await rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  const emptyPublic = join(tmpdir(), `spool-empty-public-${process.pid}`);
  await mkdir(emptyPublic, { recursive: true });
  const url = await bundle({
    entryPoint: ENTRY,
    outDir: cacheDir,
    publicDir: emptyPublic,
    onProgress: (p) => {
      if (p % 25 === 0) console.log(`[render] bundle ${p}%`);
    },
  });
  await rm(emptyPublic, { recursive: true, force: true }).catch(() => {});
  return url;
}

// Mirror the spool's staticFile() targets into the cached bundle's public/ dir.
async function syncPublic(serveUrl, dir, background) {
  const pub = join(serveUrl, "public");
  await mkdir(pub, { recursive: true });
  await cp(join(dir, "video.mp4"), join(pub, "video.mp4"));
  await rm(join(pub, "vo"), { recursive: true, force: true }).catch(() => {});
  if (existsSync(join(dir, "vo"))) await cp(join(dir, "vo"), join(pub, "vo"), { recursive: true });
  if (background) await cp(join(dir, background), join(pub, background));
}

// Speed the fully-rendered mp4 by `rate` in one pass: video via setpts, audio via
// atempo (pitch-preserving). Everything (captions, zooms, VO placement) was laid
// out in Remotion at natural speed, so compressing the whole clip keeps it in sync.
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
 * then bundles the Remotion project with publicDir=workdir so the composition
 * can staticFile() the video and per-segment wavs by their workdir-relative
 * paths. Word timings are inlined into the props (the headless render can't
 * read the fs itself). Pacing is now narration-driven (each step's window fits
 * its VO), so `rate` defaults to 1.0; when set it speeds the whole clip and the
 * rate used is stamped into <workdir>/render.json for the share layer.
 *
 * `preview` renders a fast half-scale draft (ultrafast x264, crf 28, no --rate
 * pass, no render.json stamp) to <workdir>/share/preview.mp4; final.mp4 untouched.
 *
 * @param {string|{workdir:string, rate?:number, bg?:string|null, preview?:boolean}} opts
 */
export async function renderSpool(opts) {
  const { workdir, rate = 1, bg = null, preview = false, hq = false } = typeof opts === "string" ? { workdir: opts } : opts;
  const dir = resolve(workdir);
  // No explicit --bg: fall back to env SPOOL_BG / prefs.bg before the default.
  const bgSpec = bg != null ? bg : await resolveBgPref();
  const timeline = await readJson(join(dir, "timeline.json"));
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

  // Wallpaper canvas: resolve the requested bg (preset | macOS wallpaper | path |
  // default) and copy the source into the workdir (publicDir) so the composition can
  // staticFile() it. Gradient fallback when the asset is somehow absent.
  const { source: bgAsset, tag: bgTag } = await resolveBgSource(bgSpec);
  let background = null;
  if (existsSync(bgAsset)) {
    await copyFile(bgAsset, join(dir, ".spool-bg.jpg"));
    background = ".spool-bg.jpg";
  }

  const inputProps = {
    timeline,
    manifest: enrichedManifest,
    title: timeline.title || manifest.title || null,
    background,
    workdir: dir,
  };

  const serveUrl = await getServeUrl();
  await syncPublic(serveUrl, dir, background);

  console.log("[render] selecting composition...");
  const composition = await selectComposition({
    serveUrl,
    id: "Spool",
    inputProps,
  });
  console.log(
    `[render] ${composition.durationInFrames} frames @ ${composition.fps}fps (${composition.width}x${composition.height})`
  );

  let finalOut = join(dir, "final.mp4");
  if (preview) {
    finalOut = join(dir, "share", "preview.mp4");
    await mkdir(join(dir, "share"), { recursive: true });
  }
  const speedUpNeeded = !preview && rate && rate !== 1;
  // At natural speed render straight to final.mp4; otherwise to an intermediate
  // that the speed pass consumes.
  const renderOut = speedUpNeeded ? join(dir, "render.mp4") : finalOut;
  const t0 = Date.now();
  let lastPct = -1;
  // os.cpus() reports host cores inside a container, so on a memory-capped box the
  // default over-subscribes and OOM-kills chromium/compositor. SPOOL_RENDER_CONCURRENCY
  // pins it (the Fly worker sets 2 for shared-cpu-2x/4GB).
  const concurrency = process.env.SPOOL_RENDER_CONCURRENCY
    ? Math.max(1, parseInt(process.env.SPOOL_RENDER_CONCURRENCY, 10))
    : Math.max(2, cpus().length - 1);
  // delayRender defaults to 30s; long takes on a loaded box time out fetching
  // video segments. SPOOL_RENDER_TIMEOUT_MS overrides (default 120s).
  const timeoutInMilliseconds = process.env.SPOOL_RENDER_TIMEOUT_MS
    ? Math.max(30000, parseInt(process.env.SPOOL_RENDER_TIMEOUT_MS, 10))
    : 120000;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: renderOut,
    inputProps,
    concurrency,
    timeoutInMilliseconds,
    // Preview trades quality for speed: half-scale software x264, high crf.
    // hq renders 2x-supersampled (the card inset downscales the capture below
    // native at 1x, and platform players give 4K uploads a higher bitrate ladder).
    ...(preview
      ? { scale: 0.5, crf: 28, x264Preset: "ultrafast" }
      : hq
        ? { scale: 2, crf: 16, x264Preset: "medium" }
        : { x264Preset: "veryfast" }),
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        console.log(`[render] ${pct}%`);
        lastPct = pct;
      }
    },
  });

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

  // Stamp the rate + bg so `spool share`/re-renders know final.mp4's clock differs
  // from timeline.json/video.mp4 and which canvas was used.
  await writeFile(join(dir, "render.json"), JSON.stringify({ rate: speedUpNeeded ? rate : 1, bg: bgTag }, null, 2) + "\n");

  console.log(`[render] wrote ${finalOut}`);
  return finalOut;
}

// Direct CLI: node src/render/render.mjs --workdir <dir> [--rate <n>]
const isMain = resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const argv = process.argv;
  const wIdx = argv.indexOf("--workdir");
  const workdir = wIdx >= 0 ? argv[wIdx + 1] : argv[2];
  const rIdx = argv.indexOf("--rate");
  const rate = rIdx >= 0 ? Number(argv[rIdx + 1]) : 1;
  const bIdx = argv.indexOf("--bg");
  const bg = bIdx >= 0 ? argv[bIdx + 1] : null;
  const preview = argv.includes("--preview");
  const hq = argv.includes("--hq");
  if (!workdir) {
    console.error("usage: node src/render/render.mjs --workdir <dir> [--rate <n>] [--bg <preset|path>] [--preview] [--hq]");
    process.exit(1);
  }
  renderSpool({ workdir, rate, bg, preview, hq })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[render] failed:", err);
      process.exit(1);
    });
}
