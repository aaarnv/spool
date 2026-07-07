import { readFile, writeFile, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { normalize } from "./normalize.mjs";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "index.mjs");

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

// Speed the fully-rendered mp4 by `rate` in one pass: video via setpts, audio via
// atempo (pitch-preserving). Everything (captions, zooms, VO placement) was laid
// out in Remotion at natural speed, so compressing the whole clip keeps it in sync.
async function speedUp(src, dst, rate) {
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
    "libx264",
    "-crf",
    "20",
    "-preset",
    "medium",
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
 * Render a loom workdir to <workdir>/final.mp4.
 *
 * Reads timeline.json + vo/manifest.json, normalizes the capture to CFR H264,
 * then bundles the Remotion project with publicDir=workdir so the composition
 * can staticFile() the video and per-segment wavs by their workdir-relative
 * paths. Word timings are inlined into the props (the headless render can't
 * read the fs itself). Finally the whole clip is sped up by `rate` (default
 * 1.25) so the deliverable plays at a natural-but-brisk pace; the rate used is
 * stamped into <workdir>/render.json for the share layer.
 *
 * @param {string|{workdir:string, rate?:number}} opts
 */
export async function renderLoom(opts) {
  const { workdir, rate = 1.25 } = typeof opts === "string" ? { workdir: opts } : opts;
  const dir = resolve(workdir);
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

  const inputProps = {
    timeline,
    manifest: enrichedManifest,
    title: timeline.title || manifest.title || null,
    workdir: dir,
  };

  console.log("[render] bundling Remotion project...");
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    publicDir: dir,
    onProgress: (p) => {
      if (p % 25 === 0) console.log(`[render] bundle ${p}%`);
    },
  });

  console.log("[render] selecting composition...");
  const composition = await selectComposition({
    serveUrl,
    id: "Loom",
    inputProps,
  });
  console.log(
    `[render] ${composition.durationInFrames} frames @ ${composition.fps}fps (${composition.width}x${composition.height})`
  );

  const finalOut = join(dir, "final.mp4");
  const speedUpNeeded = rate && rate !== 1;
  // At natural speed render straight to final.mp4; otherwise to an intermediate
  // that the speed pass consumes.
  const renderOut = speedUpNeeded ? join(dir, "render.mp4") : finalOut;
  let lastPct = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation: renderOut,
    inputProps,
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

  // Stamp the rate so `loom share` can record it and knows final.mp4's clock
  // differs from timeline.json/video.mp4.
  await writeFile(join(dir, "render.json"), JSON.stringify({ rate: speedUpNeeded ? rate : 1 }, null, 2) + "\n");

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
  const rate = rIdx >= 0 ? Number(argv[rIdx + 1]) : 1.25;
  if (!workdir) {
    console.error("usage: node src/render/render.mjs --workdir <dir> [--rate <n>]");
    process.exit(1);
  }
  renderLoom({ workdir, rate })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[render] failed:", err);
      process.exit(1);
    });
}
