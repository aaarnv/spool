// The record layer: drive a steps.mjs script through a real Chromium session at
// natural interaction speed, capture it to video.webm, and emit timeline.json per
// CONTRACTS.md. Record-first: VO is generated in parallel and the renderer retimes
// each step into a window that fits its narration, so nothing is padded here.

import { chromium } from 'playwright';
import { pathToFileURL } from 'url';
import { mkdir, rename, writeFile, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { CURSOR_INIT_SCRIPT, makeHelpers } from './cursor.js';
import { PAD_S } from '../render/retime.mjs';
import { validateStepsModule } from './validate.mjs';
import { resolveLaunchChannel } from '../config/prefs.mjs';

const SETTLE_MS = 1000; // after goto, let first paint/layout settle
// After a step's interactions, let the resulting UI paint and the screencast
// emit it before we cut — the last frame is what the renderer freeze-holds.
const STEP_SETTLE_MS = 250;

export async function record({ stepsFile, workdir, headed = false, dry = false }) {
  const absSteps = path.resolve(stepsFile);
  if (!existsSync(absSteps)) throw new Error(`steps file not found: ${absSteps}`);
  const mod = await import(pathToFileURL(absSteps).href);
  const { config, steps } = validateStepsModule(mod, absSteps);

  workdir = path.resolve(workdir);
  await mkdir(workdir, { recursive: true });

  // VO is produced in parallel (record no longer waits on or pads to it). A
  // manifest may already exist though; if so, dry reports an informational compare.
  const manPath = path.join(workdir, 'vo', 'manifest.json');
  let voManifest = null;
  if (existsSync(manPath)) {
    voManifest = JSON.parse(await readFile(manPath, 'utf8'));
  }
  const voDurationFor = (i) => {
    if (!voManifest || !Array.isArray(voManifest.segments)) return null;
    const seg = voManifest.segments.find((s) => s.i === i) || voManifest.segments[i];
    return seg && typeof seg.duration === 'number' ? seg.duration : null;
  };

  const viewport = config.viewport || { width: 1600, height: 900 };
  const channel = await resolveLaunchChannel();
  const browser = await chromium.launch({ headless: !headed, ...(channel ? { channel } : {}) });
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
  // consuming agent can debug the app from the spool. Buffered, flushed at the end.
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
      console.log(`[record] step ${i} "${step.name}" start t=${start.toFixed(2)}s`);
      await step.run(page, h);
      await page.waitForTimeout(STEP_SETTLE_MS); // capture the settled end state

      const end = now();
      timeline.steps.push({
        i,
        name: step.name,
        start: +start.toFixed(3),
        end: +end.toFixed(3),
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
    console.log('\n[record] dry timing report (natural interaction speed, no padding):');
    for (const s of timeline.steps) {
      const dur = s.end - s.start;
      const vo = voDurationFor(s.i); // null unless a manifest already exists
      const compare = vo != null ? `  vo+pad=${(vo + PAD_S).toFixed(2)}s → window=${Math.max(vo + PAD_S, dur).toFixed(2)}s` : '';
      console.log(`  ${String(s.i).padStart(2)} ${s.name.padEnd(24)} run=${dur.toFixed(2)}s${compare}`);
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
