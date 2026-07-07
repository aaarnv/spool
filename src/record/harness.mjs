// The record layer: drive a steps.mjs script through a real Chromium session,
// capture it to video.webm, and emit timeline.json per CONTRACTS.md. VO must
// already exist (loom vo) so we can pad each step to fit its narration.

import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { mkdir, rename, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { CURSOR_INIT_SCRIPT, makeHelpers } from './cursor.js';

const SETTLE_MS = 1000; // after goto, let first paint/layout settle
const PAD_S = 0.4; // per-contract minimum slack past voDuration

function validate(mod, stepsFile) {
  const { config, steps } = mod;
  if (!config || typeof config !== 'object') {
    throw new Error(`${stepsFile}: missing \`export const config\``);
  }
  if (typeof config.url !== 'string' || !config.url) {
    throw new Error(`${stepsFile}: config.url is required (a string)`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${stepsFile}: \`export const steps\` must be a non-empty array`);
  }
  steps.forEach((s, i) => {
    if (typeof s.name !== 'string' || !s.name) {
      throw new Error(`${stepsFile}: steps[${i}] needs a string \`name\``);
    }
    if (typeof s.run !== 'function') {
      throw new Error(`${stepsFile}: step "${s.name}" needs an async \`run(page, h)\``);
    }
  });
  if (config.prep != null && typeof config.prep !== 'function') {
    throw new Error(`${stepsFile}: config.prep must be an async function`);
  }
  return { config, steps };
}

export async function record({ stepsFile, workdir, headed = false, dry = false }) {
  const absSteps = path.resolve(stepsFile);
  if (!existsSync(absSteps)) throw new Error(`steps file not found: ${absSteps}`);
  const mod = await import(pathToFileURL(absSteps).href);
  const { config, steps } = validate(mod, absSteps);

  workdir = path.resolve(workdir);
  await mkdir(workdir, { recursive: true });

  // VO durations drive step padding. Required for a real record; optional in dry.
  const manPath = path.join(workdir, 'vo', 'manifest.json');
  let voManifest = null;
  if (existsSync(manPath)) {
    voManifest = JSON.parse(await readFile(manPath, 'utf8'));
  } else if (!dry) {
    throw new Error(`missing ${manPath} — run \`loom vo\` first`);
  }
  const voDurationFor = (i) => {
    if (!voManifest || !Array.isArray(voManifest.segments)) return 0;
    const seg = voManifest.segments.find((s) => s.i === i) || voManifest.segments[i];
    return seg && typeof seg.duration === 'number' ? seg.duration : 0;
  };
  const voDur = steps.map((_, i) => voDurationFor(i));

  const viewport = config.viewport || { width: 1440, height: 900 };
  const browser = await chromium.launch({ headless: !headed });
  const contextOpts = { viewport };
  if (!dry) contextOpts.recordVideo = { dir: workdir, size: viewport };
  const context = await browser.newContext(contextOpts);
  await context.addInitScript(CURSOR_INIT_SCRIPT);

  const page = await context.newPage();
  const tOrigin = Date.now(); // video t=0
  const now = () => (Date.now() - tOrigin) / 1000;
  const video = dry ? null : page.video();

  const state = { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) };
  let currentClicks = [];
  const logClick = (x, y) =>
    currentClicks.push({ x: Math.round(x), y: Math.round(y), t: +now().toFixed(3) });
  const h = makeHelpers(page, state, logClick);

  // Browser telemetry captured alongside the recording (→ console.jsonl), so a
  // consuming agent can debug the app from the loom. Buffered, flushed at the end.
  const telemetry = [];
  const trunc = (s) => (typeof s === 'string' && s.length > 2000 ? s.slice(0, 2000) : String(s ?? ''));
  const logEvent = (e) => telemetry.push({ t: +now().toFixed(3), ...e, text: trunc(e.text) });
  page.on('console', (msg) => logEvent({ kind: 'console', level: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => logEvent({ kind: 'pageerror', text: err && err.message ? err.message : String(err) }));
  page.on('requestfailed', (req) => {
    const f = req.failure();
    logEvent({ kind: 'requestfailed', text: `${req.method()} ${req.url()} ${f ? f.errorText : ''}`.trim() });
  });

  const timeline = {
    version: 1,
    ...(typeof config.title === 'string' && config.title ? { title: config.title } : {}),
    ...(typeof config.url === 'string' && config.url ? { url: config.url } : {}),
    viewport,
    fps: null,
    video: 'video.webm',
    steps: [],
    total: 0,
  };

  let curName = 'goto';
  try {
    await page.goto(config.url, { waitUntil: 'load' });
    await page.waitForTimeout(SETTLE_MS);

    if (config.prep) {
      curName = 'prep';
      currentClicks = [];
      const start = now();
      console.log(`[record] prep start t=${start.toFixed(2)}s`);
      await config.prep(page, h);
      console.log(`[record] prep end t=${now().toFixed(2)}s clicks=${currentClicks.length}`);
      // prep is recorded but not narrated and not padded → not a timeline step.
    }

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      curName = step.name;
      currentClicks = [];
      const start = now();
      console.log(`[record] step ${i} "${step.name}" start t=${start.toFixed(2)}s vo=${voDur[i].toFixed(2)}s`);
      await step.run(page, h);

      if (!dry) {
        const target = voDur[i] + PAD_S;
        const remaining = target - (now() - start);
        if (remaining > 0) await page.waitForTimeout(Math.ceil(remaining * 1000));
      }

      const end = now();
      timeline.steps.push({
        i,
        name: step.name,
        start: +start.toFixed(3),
        end: +end.toFixed(3),
        voDuration: voDur[i],
        zoom: step.zoom ?? 'auto',
        clicks: currentClicks,
      });
      console.log(`[record] step ${i} "${step.name}" end t=${end.toFixed(2)}s dur=${(end - start).toFixed(2)}s clicks=${currentClicks.length}`);
    }

    timeline.total = +now().toFixed(3);
  } catch (err) {
    const shot = path.join(workdir, `error_${curName}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    await context.close().catch(() => {}); // flush partial video
    await browser.close().catch(() => {});
    const e = new Error(`record failed in step "${curName}": ${err.message}`);
    e.cause = err;
    e.screenshot = shot;
    throw e;
  }

  await context.close(); // finalizes the video file

  // Always write console.jsonl (empty when nothing fired) so consumers can rely on it.
  const consolePath = path.join(workdir, 'console.jsonl');
  await writeFile(consolePath, telemetry.map((e) => JSON.stringify(e)).join('\n') + (telemetry.length ? '\n' : ''));
  console.log(`[record] wrote ${consolePath} (${telemetry.length} event${telemetry.length === 1 ? '' : 's'})`);

  if (!dry) {
    const src = await video.path();
    await rename(src, path.join(workdir, 'video.webm'));
    await writeFile(path.join(workdir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');
    console.log(`[record] wrote ${path.join(workdir, 'video.webm')}`);
    console.log(`[record] wrote ${path.join(workdir, 'timeline.json')} (total ${timeline.total.toFixed(2)}s)`);
  } else {
    const out = path.join(workdir, 'timeline.dry.json');
    await writeFile(out, JSON.stringify(timeline, null, 2) + '\n');
    console.log('\n[record] dry timing report:');
    for (const s of timeline.steps) {
      const dur = s.end - s.start;
      const need = s.voDuration + PAD_S;
      const flag = dur < need ? `  (needs ${(need - dur).toFixed(2)}s more pad)` : '';
      console.log(`  ${String(s.i).padStart(2)} ${s.name.padEnd(24)} run=${dur.toFixed(2)}s  vo+pad=${need.toFixed(2)}s${flag}`);
    }
    console.log(`[record] wrote ${out} (total ${timeline.total.toFixed(2)}s)`);
  }

  await browser.close();
  return timeline;
}

function parseArgs(argv) {
  const out = { headed: false, dry: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--steps') out.stepsFile = argv[++i];
    else if (a === '--workdir') out.workdir = argv[++i];
    else if (a === '--headed') out.headed = true;
    else if (a === '--dry') out.dry = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  if (!out.stepsFile || !out.workdir) {
    throw new Error('usage: node src/record/harness.mjs --steps <path> --workdir <dir> [--headed] [--dry]');
  }
  return out;
}

// Direct-run entrypoint.
if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  record(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(`\n[record] ERROR: ${err.message}`);
    if (err.screenshot) console.error(`[record] screenshot: ${err.screenshot}`);
    process.exit(1);
  });
}
