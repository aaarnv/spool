import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle } from "@remotion/bundler";
import { selectComposition, renderMedia } from "@remotion/renderer";
import { normalize } from "./normalize.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(__dirname, "index.mjs");

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

/**
 * Render a loom workdir to <workdir>/final.mp4.
 *
 * Reads timeline.json + vo/manifest.json, normalizes the capture to CFR H264,
 * then bundles the Remotion project with publicDir=workdir so the composition
 * can staticFile() the video and per-segment wavs by their workdir-relative
 * paths. Word timings are inlined into the props (the headless render can't
 * read the fs itself).
 */
export async function renderLoom(workdir) {
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

  const outputLocation = join(dir, "final.mp4");
  let lastPct = -1;
  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    audioCodec: "aac",
    outputLocation,
    inputProps,
    onProgress: ({ progress }) => {
      const pct = Math.floor(progress * 100);
      if (pct !== lastPct && pct % 5 === 0) {
        console.log(`[render] ${pct}%`);
        lastPct = pct;
      }
    },
  });

  console.log(`[render] wrote ${outputLocation}`);
  return outputLocation;
}

// Direct CLI: node src/render/render.mjs --workdir <dir>
const isMain = resolve(process.argv[1] || "") === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const idx = process.argv.indexOf("--workdir");
  const workdir = idx >= 0 ? process.argv[idx + 1] : process.argv[2];
  if (!workdir) {
    console.error("usage: node src/render/render.mjs --workdir <dir>");
    process.exit(1);
  }
  renderLoom(workdir)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[render] failed:", err);
      process.exit(1);
    });
}
