// Cheap background swap. A published walkthrough ships layers/fg.webm — every layer
// the render drew except the wallpaper, in VP9 with alpha — so changing the canvas is
// one overlay pass over a fresh background instead of a whole re-render. Audio is
// copied from the published final.mp4, which the swap never re-encodes.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createAssetRenderer, renderBackground } from "./engine-ffmpeg/assets.mjs";
import { encodeArgs, pickEncoder } from "./engine-ffmpeg/encode.mjs";
import { resolveBgSource } from "./bg-resolve.mjs";
import { defaultFpsFor } from "./retime.mjs";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

async function hasAudio(file) {
  try {
    const { stdout } = await exec(FFPROBE, [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=codec_type", "-of", "csv=p=0", file,
    ]);
    return stdout.trim().startsWith("audio");
  } catch {
    return false;
  }
}

/** The canvas PNG a full render would have composited, rasterised the same way. */
async function bakeBackground({ dir, bg, canvasW, canvasH }) {
  const source = await resolveBgSource(bg);
  const assetDir = join(dir, ".spool-bgswap");
  await mkdir(assetDir, { recursive: true });
  const r = await createAssetRenderer({ canvasW, canvasH, dir: assetDir });
  try {
    const name = await renderBackground(r, {
      canvasW,
      canvasH,
      bgPath: existsSync(source.source) ? source.source : null,
    });
    return { png: join(assetDir, name), assetDir, tag: source.tag };
  } finally {
    await r.close();
  }
}

/**
 * Composite `fg` (VP9 with alpha) over a freshly baked `bg` canvas and write `out`,
 * carrying the audio track of `audioFrom` across untouched.
 *
 * Returns { out, bg, seconds }. Throws when the foreground layer is missing — the
 * caller falls back to a full re-render.
 */
export async function swapBackground({ dir, fg, audioFrom, out, bg, format = "wide", fps = null, master = false }) {
  if (!existsSync(fg)) throw new Error(`bg-swap: no foreground layer at ${fg}`);
  const t0 = Date.now();
  const canvasW = format === "vertical" ? 1080 : 1920;
  const canvasH = format === "vertical" ? 1920 : 1080;
  const rate = fps || defaultFpsFor(format);
  const baked = await bakeBackground({ dir, bg, canvasW, canvasH });
  const enc = await pickEncoder({ master });
  const audio = audioFrom && existsSync(audioFrom) && (await hasAudio(audioFrom));

  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-loop", "1", "-framerate", String(rate), "-i", baked.png,
    // The default vp9 decoder drops alpha; libvpx-vp9 is what carries it.
    "-c:v", "libvpx-vp9", "-i", fg,
    ...(audio ? ["-i", audioFrom] : []),
    "-filter_complex",
    `[0:v]format=yuv420p[bg];[1:v]fps=${rate},format=yuva420p[fg];` +
      `[bg][fg]overlay=0:0:shortest=1:format=yuv420,format=yuv420p[v]`,
    "-map", "[v]",
    ...(audio ? ["-map", "2:a:0", "-c:a", "copy"] : ["-an"]),
    ...encodeArgs(enc),
    out,
  ];
  await exec(FFMPEG, args, { maxBuffer: 1 << 24 });
  await rm(baked.assetDir, { recursive: true, force: true }).catch(() => {});
  const seconds = (Date.now() - t0) / 1000;
  console.log(`[bg-swap] wrote ${out} (${seconds.toFixed(1)}s, bg ${baked.tag}, ${enc.name})`);
  return { out, bg: baked.tag, seconds };
}

/**
 * `spool bg <workdir> <bg>`: swap a rendered workdir's canvas in place. Rewrites
 * final.mp4 from layers/fg.webm and restamps render.json's `bg`. The share bundle is
 * untouched: keyframes and preview.gif come from the recording, not the deliverable.
 */
export async function swapWorkdirBackground(workdir, bg) {
  const dir = resolve(workdir);
  const final = join(dir, "final.mp4");
  const fg = join(dir, "layers", "fg.webm");
  if (!existsSync(final)) throw new Error(`no final.mp4 in ${dir} — run \`spool render\` first`);
  if (!existsSync(fg)) {
    throw new Error(`no layers/fg.webm in ${dir} — re-render this workdir to write one, then \`spool bg\` works`);
  }
  let stamp = {};
  if (existsSync(join(dir, "render.json"))) {
    try {
      stamp = JSON.parse(await readFile(join(dir, "render.json"), "utf8"));
    } catch {
      /* an unreadable stamp only costs the format/fps hints */
    }
  }
  const tmp = join(dir, ".spool-bgswap.mp4");
  const res = await swapBackground({
    dir, fg, audioFrom: final, out: tmp, bg,
    format: stamp.format || "wide",
    fps: stamp.fps || null,
  });
  await rename(tmp, final);
  await writeFile(join(dir, "render.json"), JSON.stringify({ ...stamp, bg: res.bg }, null, 2) + "\n");
  return { ...res, out: final };
}
