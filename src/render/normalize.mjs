import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { existsSync } from "node:fs";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

// Detect the fastest good H264 encoder once per process: Apple's hardware
// VideoToolbox when present (with a high bitrate so quality stays faithful),
// else libx264 at -preset veryfast (down from medium). Shared with render.mjs.
let _encoder;
export async function h264Encoder() {
  if (_encoder) return _encoder;
  try {
    const { stdout } = await exec(FFMPEG, ["-hide_banner", "-encoders"]);
    _encoder = /h264_videotoolbox/.test(stdout)
      ? { name: "h264_videotoolbox", args: ["-b:v", "12M", "-maxrate", "16M"] }
      : { name: "libx264", args: ["-crf", "20", "-preset", "veryfast"] };
  } catch {
    _encoder = { name: "libx264", args: ["-crf", "20", "-preset", "veryfast"] };
  }
  return _encoder;
}

// Is `file` already constant-frame-rate H264? (OS captures are; browser webm is VFR VP8.)
async function isCfrH264(file) {
  try {
    const { stdout } = await exec(FFPROBE, [
      "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=codec_name,r_frame_rate,avg_frame_rate",
      "-of", "default=noprint_wrappers=1:nokey=1", file,
    ]);
    const [codec, rfr, afr] = stdout.trim().split("\n");
    return codec === "h264" && rfr && rfr === afr && rfr !== "0/0";
  } catch {
    return false;
  }
}

async function duration(file) {
  const { stdout } = await exec(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return parseFloat(stdout.trim());
}

/**
 * Transcode the raw Playwright capture (video.webm) to a clean video.mp4.
 *
 * Why the re-encode: Playwright's WebM is variable-frame-rate VP8 with no seek
 * cues. Remotion's OffthreadVideo seeks that pathologically slowly (every frame
 * request scans from the start), so a render can take minutes per second of
 * footage. Forcing constant 30fps H264 with faststart fixes both the seek cost
 * and the VFR timing drift, and yuv420p keeps it broadly decodable. Audio is
 * dropped (-an) — the VO is muxed in later by the renderer.
 */
export async function normalize(workdir) {
  // video.webm (browser recordVideo) or capture.mp4 (OS avfoundation capture).
  const webm = join(workdir, "video.webm");
  const capMp4 = join(workdir, "capture.mp4");
  const src = existsSync(webm) ? webm : existsSync(capMp4) ? capMp4 : null;
  const out = join(workdir, "video.mp4");
  if (!src) throw new Error(`normalize: missing capture (video.webm or capture.mp4) in ${workdir}`);

  // Already CFR H264 (OS capture): remux to the staticFile target instead of
  // re-encoding. Playwright's VFR VP8 webm still needs the full re-encode below.
  if (await isCfrH264(src)) {
    console.log(`[normalize] ${src} -> ${out} (copy, already CFR H264)`);
    await exec(FFMPEG, ["-y", "-i", src, "-c", "copy", "-an", "-movflags", "+faststart", out]);
    const d = await duration(out);
    console.log(`[normalize] out=${d.toFixed(2)}s (remuxed)`);
    return { out, duration: d };
  }

  const enc = await h264Encoder();
  console.log(`[normalize] ${src} -> ${out} (${enc.name})`);
  await exec(FFMPEG, [
    "-y",
    "-fflags",
    "+genpts",
    "-i",
    src,
    "-vf",
    "fps=30,format=yuv420p",
    "-c:v",
    enc.name,
    ...enc.args,
    "-movflags",
    "+faststart",
    "-an",
    out,
  ]);

  const [din, dout] = await Promise.all([duration(src), duration(out)]);
  const drift = Math.abs(dout - din) / din;
  console.log(
    `[normalize] in=${din.toFixed(2)}s out=${dout.toFixed(2)}s drift=${(drift * 100).toFixed(1)}%`
  );
  if (drift > 0.02) {
    console.warn(
      `[normalize] WARNING: output duration drifts ${(drift * 100).toFixed(1)}% from input (>2%)`
    );
  }
  return { out, duration: dout };
}
