#!/usr/bin/env node
// Deterministic comp renderer: loads a comp HTML, injects beat+word data,
// seeks frame by frame (the comp is a pure function of t), screenshots each
// frame, then stitches + muxes with ffmpeg. Deterministic = captions cannot
// drift from the audio.
//
// Usage: node render.mjs <comp.html> <vo-workdir> <out.mp4> [fps]
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadTimeline } from './skia/timeline.mjs';
const run = promisify(execFile);

const [compPath, voDir, outPath, fpsArg] = process.argv.slice(2);
if (!compPath || !voDir || !outPath) {
  console.error('usage: render.mjs <comp.html> <vo-workdir> <out.mp4> [fps]');
  process.exit(1);
}
const FPS = Number(fpsArg) || 30;

// Same timeline the skia engine builds, so the two renders stay identical.
const { manifest, beats, total, diagrams } = await loadTimeline(voDir);

const { chromium } = await import(pathToFileURL(resolve('node_modules/playwright/index.mjs')).href);
// The comp imports layout.mjs, and Chrome blocks module fetches over file:// without this.
const browser = await chromium.launch({ args: ['--allow-file-access-from-files'] });
const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
// Same ambient clip the skia engine gets, so the two renders stay identical.
const bgFile = process.env.SPOOL_AMBIENT_FILE;
if (bgFile) await page.addInitScript((d) => { window.BG_DUR = d; }, Number(process.env.SPOOL_AMBIENT_DUR));
await page.goto(pathToFileURL(resolve(compPath)).href);
if (bgFile) {
  await page.evaluate(([src, dim]) => {
    const v = document.getElementById('loop');
    v.style.filter = `saturate(1.1) brightness(${0.8 * dim})`;
    v.src = src;
  }, [pathToFileURL(resolve(bgFile)).href, Number(process.env.SPOOL_AMBIENT_DIM) || 1]);
  await page.waitForFunction(() => document.getElementById('loop').readyState >= 2);
}
await page.evaluate((data) => window.INIT(data), { beats, total, diagrams });

const framesDir = resolve(dirname(outPath), 'frames-tmp');
await rm(framesDir, { recursive: true, force: true });
await mkdir(framesDir, { recursive: true });

const n = Math.ceil(total * FPS);
const started = Date.now();
for (let f = 0; f < n; f++) {
  await page.evaluate((t) => window.SEEK(t), f / FPS);
  await page.screenshot({ path: join(framesDir, `f${String(f).padStart(5, '0')}.png`) });
  if (f % 150 === 0) console.log(`frame ${f}/${n} (${((Date.now() - started) / 1000).toFixed(0)}s)`);
}
await browser.close();

// Audio: concat the segment wavs.
const list = manifest.segments.map((s) => `file '${resolve(voDir, s.wav)}'`).join('\n');
const listPath = join(framesDir, 'audio.txt');
await writeFile(listPath, list);
await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'pcm_s16le', join(framesDir, 'audio.wav')]);
await run('ffmpeg', ['-y', '-framerate', String(FPS), '-i', join(framesDir, 'f%05d.png'),
  '-i', join(framesDir, 'audio.wav'), '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
  '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-shortest', resolve(outPath)]);
await rm(framesDir, { recursive: true, force: true });
console.log(`done: ${outPath} (${total}s @ ${FPS}fps)`);
