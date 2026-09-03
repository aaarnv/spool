#!/usr/bin/env node
// Renders one frame stripe and pipes raw RGBA straight into its own ffmpeg segment
// encode. Spawned by render-skia.mjs; the job arrives as a single JSON argv.
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { Canvas } from 'skia-canvas';
import { loadTimeline } from './timeline.mjs';

const job = JSON.parse(process.argv[2]);
const { sceneMod, voDir, start, end, fps, out, bgLoop, encode, nice: renice } = job;

const mod = await import(pathToFileURL(sceneMod).href);
const tl = await loadTimeline(voDir);
// A scene that composites images decodes them before the first frame, so building
// one is allowed to be async; a scene that does not still returns synchronously.
const scene = await mod.createScene(tl);
const bg = mod.background;
const w = (mod.W || 540) * (mod.SCALE || 2), h = (mod.H || 960) * (mod.SCALE || 2);

const args = ['-y', '-hide_banner', '-v', 'error'];
if (bgLoop) args.push('-ss', String((start + 0.5) / fps), '-i', bgLoop);
args.push('-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-r', String(fps), '-i', 'pipe:0');
if (bgLoop) {
  // setpts pins the first frame after the seek to PTS 0, else overlay's framesync
  // drops the stripe's opening frame.
  args.push('-filter_complex',
    `[0:v]setpts=PTS-STARTPTS,fps=${fps},format=rgba,${bg.filter}[bg];`
    + '[bg][1:v]overlay=0:0:format=rgb:eof_action=endall,format=yuv420p[v]',
    '-map', '[v]');
} else args.push('-vf', 'format=yuv420p');
args.push('-an', '-frames:v', String(end - start), ...encode, out);

const cmd = renice ? 'nice' : 'ffmpeg';
const argv = renice ? ['-n', '10', 'ffmpeg', ...args] : args;
const ff = spawn(cmd, argv, { stdio: ['pipe', 'ignore', 'inherit'] });
const done = new Promise((res, rej) => {
  ff.on('exit', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exit ${c} (${out})`))));
  ff.on('error', rej);
});
ff.stdin.on('error', () => { /* ffmpeg died; the exit handler reports it */ });

const canvas = new Canvas(w, h);
const ctx = canvas.getContext('2d');
for (let f = start; f < end; f++) {
  scene.draw(ctx, f / fps);
  const buf = await canvas.toBuffer('raw');
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
  if (job.log && (f - start) % 120 === 0) process.stderr.write(`  stripe ${out.slice(-10)} ${f - start}/${end - start}\n`);
}
ff.stdin.end();
await done;
