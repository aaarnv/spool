// Packet in, watchable vertical MP4 + share bundle out — with no browser, no
// capture and no coding agent. This is the deterministic half of
// docs/video/tools/make-video.mjs, arranged so a render worker can run it:
// author (OpenAI, gated) → VO → skia comp render → share bundle.
//
// The comp renderer and its ambient pool live under docs/video/comp, which the npm
// package does not ship. `compRoot()` says so out loud rather than failing deep in a
// spawn, because packet rendering is a platform capability, not a CLI one.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { generateVO } from '../vo/tts.mjs';
import { shareSpool } from '../share/share.mjs';
import { authorPacketVideo, inferMode, inferVisual } from './author.mjs';

export const PACKET_FPS = 60;
export const PACKET_FORMAT = 'vertical';

const COMP = fileURLToPath(new URL('../../docs/video/comp/', import.meta.url));

/** The comp renderer's directory, or null when this install does not carry it. */
export function compRoot() {
  return existsSync(join(COMP, 'skia', 'render-skia.mjs')) ? COMP : null;
}

export function assertComp() {
  if (!compRoot()) {
    throw new Error(
      'packet rendering needs the comp renderer at docs/video/comp, which the published CLI does not ship — render the packet on spoolkit.dev instead'
    );
  }
}

// Measured on the worker image: ~1.1GB resident per stripe (a 1080x1920 RGBA canvas
// plus that stripe's own ffmpeg decoding the ambient clip), over a ~250MB floor.
const RAM_PER_WORKER = 1.25 * 1024 * 1024 * 1024;
const RAM_FLOOR = 512 * 1024 * 1024;

// os.totalmem() reports the HOST's memory from inside a container, so a 4-core Fly
// machine on a big host would size its pool against memory it cannot have.
function memoryBudget() {
  for (const p of ['/sys/fs/cgroup/memory.max', '/sys/fs/cgroup/memory/memory.limit_in_bytes']) {
    try {
      const n = Number(readFileSync(p, 'utf8').trim());
      if (Number.isFinite(n) && n > 0 && n < totalmem()) return n;
    } catch { /* not cgrouped, or not readable */ }
  }
  return totalmem();
}

/**
 * How many frame stripes to render at once.
 *
 * The comp renderer sizes its own pool off core count alone, which is right on a
 * workstation and fatal in a container: an 18-core box capped at 8GB asks for nine
 * stripes, needs ~10GB, and gets them SIGKILLed mid-encode. Cores still cap it —
 * memory only ever lowers the number.
 */
export function skiaWorkers() {
  const env = Number(process.env.SPOOL_SKIA_WORKERS);
  if (Number.isFinite(env) && env > 0) return Math.floor(env);
  const byRam = Math.floor((memoryBudget() - RAM_FLOOR) / RAM_PER_WORKER);
  return Math.max(1, Math.min(Math.floor(cpus().length / 2), byRam));
}

const run = (cmd, args, opts) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...opts });
    p.on('error', rej);
    p.on('exit', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}`))));
  });

// The timeline the VO layer narrates from. Times are filled in afterwards, once the
// segments exist and their real durations are known.
function draftTimeline(beats, title) {
  return {
    version: 1,
    title: title ?? null,
    target: 'packet',
    retimed: true,
    steps: beats.map((b, i) => ({ i, name: b.name, narration: b.narration, start: 0, end: 0, clicks: [] })),
  };
}

// The rendered file plays each beat for exactly its segment duration, back to back
// (docs/video/comp/skia/timeline.mjs), so the output clock is the running sum.
function timedTimeline(timeline, manifest) {
  const byIndex = new Map((manifest.segments || []).map((s) => [s.i, s]));
  let t = 0;
  const steps = timeline.steps.map((s) => {
    const dur = byIndex.get(s.i)?.duration ?? 0;
    const step = { ...s, start: +t.toFixed(3), end: +(t + dur).toFixed(3) };
    t += dur;
    return step;
  });
  return { ...timeline, steps, duration: +t.toFixed(3) };
}

/**
 * Everything after authoring: the beats and their visual layer, voiced, composited and
 * bundled into `<workdir>/final.mp4` plus `share/`.
 *
 * Split out of `renderPacketVideo` when the recap lane arrived (src/recap/video.mjs).
 * The two lanes disagree only about what they author FROM — a plan packet against a
 * merged pull request — and agree about every step after it, so this is the one copy
 * of the VO → comp → share chain. A caller writes whatever semantic artifact it wants
 * in the bundle (plan.json, recap.json) into the workdir BEFORE calling: share.mjs
 * reads the workdir, and a file written after it is a file the bundle never saw.
 *
 * `stamp` is merged into render.json — the lane's own marker, which a later cloud edit
 * reads back to know what it is re-rendering.
 */
export async function renderAuthoredVideo({
  workdir,
  authored,
  title = null,
  stamp = {},
  tag = 'packet',
  voice = 'alloy',
  speed = 1,
  engine,
  bg = 'random',
  seed = '',
  fps = PACKET_FPS,
  log = console.error,
} = {}) {
  assertComp();
  if (!workdir) throw new Error('renderAuthoredVideo: workdir required');
  await mkdir(workdir, { recursive: true });
  await writeFile(join(workdir, 'beats.json'), JSON.stringify(authored.beats, null, 2) + '\n');

  if (authored.visual === 'mockup') {
    // One file the renderer reads: the spec that made each screen, and the shot it
    // made. Paths are relative so the bundle survives being moved or re-uploaded.
    const shots = authored.shots.map((s) => ({
      beat: s.beat,
      variant: s.variant,
      png: relative(workdir, s.png),
      mockup: authored.mockups.find((m) => m.beat === s.beat)?.mockup ?? null,
    }));
    log(`[${tag}] ${authored.beats.length} beats, ${shots.length} mockups (${shots.filter((s) => s.variant).map((s) => s.variant).join(', ')})`);
    await writeFile(join(workdir, 'mockups.json'), JSON.stringify(shots, null, 2) + '\n');
  } else {
    log(`[${tag}] ${authored.beats.length} beats, ${authored.diagrams.filter((d) => d.diagram).length} diagrams`);
    await writeFile(join(workdir, 'diagrams.json'), JSON.stringify(authored.diagrams, null, 2) + '\n');
  }

  await writeFile(join(workdir, 'timeline.json'), JSON.stringify(draftTimeline(authored.beats, title), null, 2) + '\n');

  log(`[${tag}] voicing...`);
  const manifest = await generateVO({ stepsFile: null, workdir, engine, voice, speed, format: PACKET_FORMAT });

  const timeline = timedTimeline(draftTimeline(authored.beats, title), manifest);
  await writeFile(join(workdir, 'timeline.json'), JSON.stringify(timeline, null, 2) + '\n');

  const root = compRoot();
  const { pickAmbient } = await import(new URL('ambient.mjs', `file://${root}`).href);
  const ambient = pickAmbient(bg, seed || title || 'packet');
  log(`[${tag}] rendering ${timeline.duration}s at ${fps}fps (bg ${ambient.slug})...`);

  const out = join(workdir, 'final.mp4');
  // A packet render IS the final cut, so it encodes at the master tier. Without this
  // the worker fell back to the draft encoder, and a published video was the only
  // final.mp4 in the product that was not a master.
  await run(process.execPath, [join(root, 'skia', 'render-skia.mjs'), join(root, 'skia', 'scene-auto.mjs'), workdir, out, String(fps), '--master'], {
    env: {
      ...process.env,
      SPOOL_SKIA_WORKERS: String(skiaWorkers()),
      SPOOL_AMBIENT_FILE: ambient.src,
      SPOOL_AMBIENT_DUR: String(ambient.clipDur),
      SPOOL_AMBIENT_DIM: String(ambient.dim ?? 1),
    },
  });
  await rm(join(workdir, `.skia-final`), { recursive: true, force: true }).catch(() => {});

  // The render stamp share.mjs and any later cloud edit read back.
  await writeFile(
    join(workdir, 'render.json'),
    JSON.stringify({ rate: 1, bg: ambient.slug, format: PACKET_FORMAT, fps, visual: authored.visual, ...stamp }, null, 2) + '\n'
  );

  const shareDir = await shareSpool(workdir);
  return { shareDir, out, visual: authored.visual, beats: authored.beats.length, duration: timeline.duration, title };
}

/**
 * Render a plan packet to `<workdir>/final.mp4` plus a full share bundle.
 *
 * `packet` is `{ plan, evidence? }`. The workdir is created if absent and ends up
 * holding everything a publish needs: plan.json, beats.json, diagrams.json,
 * timeline.json, render.json, vo/ and share/. Returns the render's facts.
 */
export async function renderPacketVideo({
  workdir,
  packet,
  mode,
  visual,
  model,
  voice = 'alloy',
  speed = 1,
  engine,
  bg = 'random',
  seed = '',
  fps = PACKET_FPS,
  log = console.error,
} = {}) {
  assertComp();
  if (!workdir) throw new Error('renderPacketVideo: workdir required');
  if (!packet?.plan) throw new Error('renderPacketVideo: packet.plan required');
  await mkdir(workdir, { recursive: true });

  const register = mode || inferMode(packet);
  const layer = visual || inferVisual(packet);
  log(`[packet] mode ${register}, visuals ${layer}`);
  const authored = await authorPacketVideo({ packet, mode: register, visual: layer, model, workdir, log });

  // The packet is the spool: publishing it is what opens the decision, so it has to
  // sit in the workdir for share.mjs to pick up.
  await writeFile(join(workdir, 'plan.json'), JSON.stringify(packet.plan, null, 2) + '\n');
  if (packet.evidence) await writeFile(join(workdir, 'evidence.json'), JSON.stringify(packet.evidence, null, 2) + '\n');

  const rendered = await renderAuthoredVideo({
    workdir,
    authored,
    title: packet.plan.goal ?? null,
    stamp: { packet: true, mode: register },
    model,
    voice,
    speed,
    engine,
    bg,
    seed,
    fps,
    log,
  });
  return { ...rendered, mode: register };
}
