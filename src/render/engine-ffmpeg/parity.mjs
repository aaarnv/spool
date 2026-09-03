// Regression harness: render a workdir and score it against a known-good mp4.
// It compared engines while both existed; the references it produced then are the
// baselines now. Averages hide a broken layer, so the worst frames are the proof.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { renderSpool } from "../render.mjs";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";

async function metric(kind, a, b, out) {
  const log = join(out, `${kind}.log`);
  await exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-i", a, "-i", b,
    "-lavfi", `[0:v][1:v]${kind}=stats_file=${log}`, "-f", "null", "-"]);
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  return lines.map((l) => {
    const n = /\bn:(\d+)/.exec(l);
    const v = kind === "ssim" ? /\bAll:([0-9.]+)/.exec(l) : /\bpsnr_avg:([0-9.]+)/.exec(l);
    return { n: n ? Number(n[1]) : 0, v: v ? Number(v[1]) : NaN };
  }).filter((r) => Number.isFinite(r.v));
}

async function frameAt(src, n, dest) {
  await exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", src,
    "-vf", `select=eq(n\\,${n})`, "-vsync", "0", "-frames:v", "1", dest]);
  return dest;
}

async function pair(a, b, dest) {
  await exec(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", "-i", a, "-i", b,
    "-filter_complex", "[0][1]vstack=inputs=2", dest]);
}

async function probeFps(file) {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=r_frame_rate", "-of", "default=nw=1:nk=1", file]);
  const [num, den] = stdout.trim().split("/").map(Number);
  return den ? num / den : num;
}

/**
 * Render `workdir` and compare with `reference`. Pass `reuse` to score an mp4 that
 * is already there instead of re-rendering.
 */
export async function parity(workdir, { reference, reuse = false, worst = 8, fps = null, master = false } = {}) {
  const dir = resolve(workdir);
  const ref = resolve(reference);
  if (!existsSync(ref)) throw new Error(`reference not found: ${ref}`);
  const out = join(dir, "parity");
  await mkdir(out, { recursive: true });
  const rendered = join(dir, "ffmpeg.mp4");

  let seconds = null;
  if (!reuse || !existsSync(rendered)) {
    const t = Date.now();
    await renderSpool({ workdir: dir, fps, master });
    await rename(join(dir, "final.mp4"), rendered);
    seconds = (Date.now() - t) / 1000;
    console.log(`[parity] render: ${seconds.toFixed(1)}s`);
  }

  const ssim = await metric("ssim", ref, rendered, out);
  const psnr = await metric("psnr", ref, rendered, out);
  if (!ssim.length) throw new Error("no frames scored — do the two files have the same frame count?");
  const mean = (a) => a.reduce((s, r) => s + r.v, 0) / a.length;
  const rate = fps || (await probeFps(ref));

  const bySecond = new Map();
  for (const r of ssim) {
    const s = Math.floor(r.n / rate);
    if (!bySecond.has(s)) bySecond.set(s, []);
    bySecond.get(s).push(r.v);
  }
  console.log(`\n[parity] frames scored: ${ssim.length}  mean SSIM ${mean(ssim).toFixed(4)}  mean PSNR ${mean(psnr).toFixed(2)} dB`);
  console.log("[parity] per-second SSIM:");
  console.log(
    [...bySecond.entries()]
      .map(([s, v]) => `${String(s).padStart(3)}s ${(v.reduce((a, b) => a + b, 0) / v.length).toFixed(4)}`)
      .join("  ")
  );

  const bad = [...ssim].sort((a, b) => a.v - b.v).slice(0, worst);
  console.log(`\n[parity] ${worst} worst frames (reference top / render bottom):`);
  for (let i = 0; i < bad.length; i++) {
    const { n, v } = bad[i];
    const a = await frameAt(ref, n, join(out, `w${i}_${n}_ref.png`));
    const b = await frameAt(rendered, n, join(out, `w${i}_${n}_new.png`));
    const p = join(out, `worst_${i}_f${n}_ssim${v.toFixed(3)}.png`);
    await pair(a, b, p);
    await rm(a).catch(() => {});
    await rm(b).catch(() => {});
    console.log(`  frame ${n} (t=${(n / rate).toFixed(2)}s) ssim ${v.toFixed(4)} -> ${p}`);
  }
  return { seconds, ssim: mean(ssim), psnr: mean(psnr), worst: bad, out };
}

const argv = process.argv;
if (resolve(argv[1] || "") === resolve(new URL(import.meta.url).pathname)) {
  const dir = argv[2];
  const flag = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : null);
  const reference = flag("--reference");
  if (!dir || !reference) {
    console.error("usage: node src/render/engine-ffmpeg/parity.mjs <workdir> --reference <mp4> [--reuse] [--fps N] [--worst N] [--master]");
    process.exit(1);
  }
  parity(dir, {
    reference,
    reuse: argv.includes("--reuse"),
    master: argv.includes("--master"),
    fps: flag("--fps") ? Number(flag("--fps")) : null,
    worst: flag("--worst") ? Number(flag("--worst")) : 8,
  })
    .then(() => process.exit(0))
    .catch((e) => {
      console.error("[parity] failed:", e);
      process.exit(1);
    });
}
