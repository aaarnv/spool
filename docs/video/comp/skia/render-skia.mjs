#!/usr/bin/env node
// Native comp renderer: the scene is a pure function of t drawn with skia-canvas,
// striped across N worker processes that each pipe raw RGBA into their own ffmpeg
// segment encode. Segments concat losslessly, then the VO wavs are muxed on.
// Drop-in for render.mjs.
//
// Usage: node render-skia.mjs <scene> <vo-workdir> <out.mp4> [fps] [--master]
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { cpus } from 'node:os';
import { promisify } from 'node:util';
import { loadTimeline } from './timeline.mjs';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const master = argv.includes('--master');
const [sceneArg, voDir, outPath, fpsArg] = argv.filter((a) => !a.startsWith('--'));
if (!sceneArg || !voDir || !outPath) {
  console.error('usage: render-skia.mjs <scene> <vo-workdir> <out.mp4> [fps] [--master]');
  process.exit(1);
}
const FPS = Number(fpsArg) || 30;

// Accept the comp HTML path render.mjs takes, so callers can swap engines by binary name.
const sceneMod = /\.html$/.test(sceneArg)
  ? join(here, `scene-${basename(sceneArg, '.html')}.mjs`)
  : resolve(sceneArg);

const mod = await import(pathToFileURL(sceneMod).href);
const { manifest, total } = await loadTimeline(voDir);
const n = Math.ceil(total * FPS);

const tmp = resolve(dirname(outPath), '.skia-' + basename(outPath, '.mp4'));
await rm(tmp, { recursive: true, force: true });
await mkdir(tmp, { recursive: true });

// Encoder tier: videotoolbox for previews, x264 medium for masters, x264 veryfast if
// the hardware encoder is missing. slow/crf17 shipped 8 Mbps social clips for no
// visible gain over medium/crf20, at roughly twice the encode time.
const encoders = await run('ffmpeg', ['-hide_banner', '-encoders']).then((r) => r.stdout).catch(() => '');
const hasVT = encoders.includes('h264_videotoolbox');
const encode = master
  ? ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p']
  : hasVT
    ? ['-c:v', 'h264_videotoolbox', '-b:v', '12M', '-profile:v', 'high', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19', '-pix_fmt', 'yuv420p'];
if (master && !hasVT) console.log('note: h264_videotoolbox unavailable');

// Background: trim the ambient clip to the comp's loop length, then concat enough
// copies to cover the render so every worker can seek into one seekable file.
let bgLoop = null;
if (mod.background) {
  // Trim by exact frame count: -t keeps one frame too many, which would drift the
  // loop against the comp's `videoTime = t % clipDur` every wrap.
  const rate = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=r_frame_rate', '-of', 'csv=p=0', mod.background.src]).then((r) => r.stdout.trim());
  const [num, den] = rate.split('/').map(Number);
  const loopFrames = Math.round(mod.background.clipDur * (num / (den || 1)));
  const one = join(tmp, 'bg-one.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-i', mod.background.src, '-frames:v', String(loopFrames),
    '-c', 'copy', one]);
  const reps = Math.ceil(total / mod.background.clipDur) + 1;
  const list = join(tmp, 'bg.txt');
  await writeFile(list, Array.from({ length: reps }, () => `file '${one}'`).join('\n'));
  bgLoop = join(tmp, 'bg-loop.mp4');
  await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', bgLoop]);
}

const workers = Math.max(1, Number(process.env.SPOOL_SKIA_WORKERS) || Math.max(1, Math.floor(cpus().length / 2)));
const bounds = Array.from({ length: workers + 1 }, (_, i) => Math.floor((i * n) / workers));
const segs = [];
const started = Date.now();
console.log(`skia render: ${n} frames @ ${FPS}fps across ${workers} workers (${master ? 'master x264' : hasVT ? 'videotoolbox' : 'x264 veryfast'})`);

await Promise.all(bounds.slice(0, -1).map((start, i) => {
  const end = bounds[i + 1];
  const out = join(tmp, `seg${String(i).padStart(3, '0')}.mp4`);
  segs.push(out);
  if (end <= start) return Promise.resolve();
  const job = { sceneMod, voDir: resolve(voDir), start, end, fps: FPS, out, bgLoop, encode, nice: master, log: i === 0 };
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, [join(here, 'frame-worker.mjs'), JSON.stringify(job)], { stdio: 'inherit' });
    p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`worker ${i} exit ${c}`))));
  });
}));
const drawn = (Date.now() - started) / 1000;
console.log(`frames done in ${drawn.toFixed(1)}s (${(n / drawn).toFixed(0)} fps)`);

const vlist = join(tmp, 'video.txt');
await writeFile(vlist, segs.filter(Boolean).map((s) => `file '${s}'`).join('\n'));
const alist = join(tmp, 'audio.txt');
await writeFile(alist, manifest.segments.map((s) => `file '${resolve(voDir, s.wav)}'`).join('\n'));
await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', alist,
  '-c:a', 'pcm_s16le', join(tmp, 'audio.wav')]);
await run('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', vlist,
  '-i', join(tmp, 'audio.wav'), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
  '-movflags', '+faststart', '-shortest', resolve(outPath)]);
await rm(tmp, { recursive: true, force: true });
console.log(`done: ${outPath} (${total}s @ ${FPS}fps) in ${((Date.now() - started) / 1000).toFixed(1)}s`);
