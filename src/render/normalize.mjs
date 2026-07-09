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
  const src = join(workdir, "video.webm");
  const out = join(workdir, "video.mp4");
  if (!existsSync(src)) throw new Error(`normalize: missing ${src}`);

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
