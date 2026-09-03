// Two tiers: hardware H264 for iteration, libx264 slow/crf17 for a master. The
// worker has no VideoToolbox, so detection alone keeps Linux on libx264.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";

let _vt;
async function hasVideotoolbox() {
  if (_vt !== undefined) return _vt;
  try {
    const { stdout } = await exec(FFMPEG, ["-hide_banner", "-encoders"]);
    _vt = /h264_videotoolbox/.test(stdout);
  } catch {
    _vt = false;
  }
  return _vt;
}

export async function pickEncoder({ master = false, preview = false } = {}) {
  if (preview) return { name: "libx264", args: ["-preset", "ultrafast", "-crf", "28"], nice: false, tier: "preview" };
  if (master) return { name: "libx264", args: ["-preset", "slow", "-crf", "17"], nice: true, tier: "master" };
  if (await hasVideotoolbox())
    return { name: "h264_videotoolbox", args: ["-b:v", "12M", "-maxrate", "16M"], nice: false, tier: "fast" };
  return { name: "libx264", args: ["-preset", "veryfast", "-crf", "18"], nice: false, tier: "fast" };
}

export function encodeArgs(enc) {
  return ["-c:v", enc.name, ...enc.args, "-pix_fmt", "yuv420p", "-movflags", "+faststart"];
}

// The alpha foreground layer. VP9 in WebM is the one broadly available codec that
// carries a real alpha channel; the swap path decodes it with libvpx-vp9.
export function alphaArgs() {
  return [
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-b:v", "0",
    "-crf", "26",
    "-row-mt", "1",
    "-deadline", "realtime",
    "-cpu-used", "8",
    "-tile-columns", "2",
    "-g", "240",
  ];
}
