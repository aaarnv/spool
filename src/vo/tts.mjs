#!/usr/bin/env node
// src/vo/tts.mjs — the VO layer entry point. Turns a spool's steps.mjs narration
// into a loudnormed wav per narrated step, plus vo/manifest.json. Word timings
// live in ./timestamps.mjs. Default path is OpenAI (gpt-4o-mini-tts speech +
// whisper-1 word timings); `local` is a thin fallback that shells to
// video-studio's vo.sh (Higgs TTS + whisper). See CONTRACTS.md for file shapes.
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { openaiWordTimestamps, chunksToWords, openaiFetch } from './timestamps.mjs';

const DEFAULT_INSTRUCTIONS = 'an experienced engineer walking a client through their product; confident, familiar, precise — the voice of someone who built this and knows it deeply, never a first-time viewer';
const round2 = (x) => Math.round(x * 100) / 100;

export async function generateVO({ stepsFile, workdir, engine, voice = 'alloy', instructions, speed = 1 } = {}) {
  if (!workdir) throw new Error('generateVO: workdir required');

  // Narration source: a steps.mjs snapshot (scripted/browser) when present, else
  // the session's timeline.json per-step narration (OS sessions have no steps.mjs).
  let steps;
  if (stepsFile && existsSync(resolve(stepsFile))) {
    const mod = await import(pathToFileURL(resolve(stepsFile)).href);
    steps = mod.steps || [];
  } else {
    const tl = JSON.parse(await readFile(join(workdir, 'timeline.json'), 'utf8'));
    steps = (tl.steps || []).map((s) => ({ name: s.name, narration: s.narration || '' }));
  }
  const voDir = join(workdir, 'vo');
  await mkdir(voDir, { recursive: true });

  const instr = instructions ?? DEFAULT_INSTRUCTIONS;
  engine = await resolveEngine(engine);
  const key = engine === 'openai' ? await resolveKey() : null;
  if (engine === 'openai' && !key) throw new Error('OPENAI_API_KEY not set (env, ./.env, or "openaiKey" in ~/.spool.json)');
  const hosted = engine === 'hosted' ? await resolveHosted() : null;

  // One job per narrated step. TTS → loudnorm → whisper stay sequential inside a
  // job; jobs run through a bounded pool so the wall-time is ~total/CONCURRENCY.
  const jobs = steps
    .map((step, i) => ({ name: step.name, i, narration: (step.narration || '').trim() }))
    .filter((j) => j.narration); // un-narrated steps get no segment; index i still mirrors the steps array

  const ctx = { engine, key, hosted, voice, instr, speed, workdir, voDir };
  const CONCURRENCY = 4;
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (true) {
        const k = next++;
        if (k >= jobs.length) break;
        results[k] = await buildSegment(ctx, jobs[k]);
      }
    })
  );
  const segments = results; // jobs were built in step order → manifest stays deterministic

  const manifest = { engine, voice, segments };
  await writeFile(join(voDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}

// Synthesize one segment's wav + word-times into <workdir>/vo/seg_NN.{wav,words.json}.
// ctx carries the resolved engine + credentials; job is { i, name, narration }.
async function buildSegment(ctx, { i, name, narration }) {
  const { engine, key, hosted, voice, instr, speed, workdir, voDir } = ctx;
  const nn = String(i).padStart(2, '0');
  const wavRel = `vo/seg_${nn}.wav`;
  const wordsRel = `vo/seg_${nn}.words.json`;
  const wavAbs = join(workdir, wavRel);
  const wordsAbs = join(workdir, wordsRel);

  if (engine === 'openai') {
    const rawPath = join(voDir, `seg_${nn}.raw.wav`);
    await writeFile(rawPath, await openaiSpeech(key, narration, voice, instr));
    await loudnorm(rawPath, wavAbs, speed);
    await rm(rawPath, { force: true });
    // Transcribe the finished (loudnormed) wav so word times are local to it.
    const words = await openaiWordTimestamps({ key, wavBuf: await readFile(wavAbs), prompt: narration });
    await writeFile(wordsAbs, JSON.stringify(words));
  } else if (engine === 'hosted') {
    const rawPath = join(voDir, `seg_${nn}.raw.wav`);
    const { audio, words } = await hostedSpeech(hosted, narration, voice, instr);
    await writeFile(rawPath, Buffer.from(audio, 'base64'));
    await loudnorm(rawPath, wavAbs, speed);
    await rm(rawPath, { force: true });
    // Server timings are on the raw wav; atempo scales time linearly, so /speed keeps them true.
    const scaled = speed !== 1 ? words.map((w) => ({ word: w.word, start: round2(w.start / speed), end: round2(w.end / speed) })) : words;
    await writeFile(wordsAbs, JSON.stringify(scaled));
  } else if (engine === 'local') {
    await localSegment(narration, voDir, nn, wordsAbs);
  } else {
    throw new Error(`generateVO: unknown engine "${engine}"`);
  }
  return { i, name, narration, wav: wavRel, words: wordsRel, duration: round2(await probeDuration(wavAbs)) };
}

// Regenerate a SINGLE segment's wav + words in place (the edit worker's re-TTS path).
// Resolves its own engine/key exactly like generateVO, so callers need only OPENAI_API_KEY.
export async function synthesizeSegment({ workdir, i, name, narration, engine, voice = 'alloy', instructions, speed = 1 } = {}) {
  if (!workdir) throw new Error('synthesizeSegment: workdir required');
  const voDir = join(workdir, 'vo');
  await mkdir(voDir, { recursive: true });
  const instr = instructions ?? DEFAULT_INSTRUCTIONS;
  engine = await resolveEngine(engine);
  const key = engine === 'openai' ? await resolveKey() : null;
  if (engine === 'openai' && !key) throw new Error('OPENAI_API_KEY not set (env, ./.env, or "openaiKey" in ~/.spool.json)');
  const hosted = engine === 'hosted' ? await resolveHosted() : null;
  return buildSegment({ engine, key, hosted, voice, instr, speed, workdir, voDir }, { i, name, narration: (narration || '').trim() });
}

// --- OpenAI TTS ------------------------------------------------------------

async function openaiSpeech(key, text, voice, instructions) {
  const body = { model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'wav' };
  if (instructions) body.instructions = instructions;
  const res = await openaiFetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return Buffer.from(await res.arrayBuffer());
}

// Resolve an OpenAI key from env, the target project's .env, then ~/.spool.json.
// Returns null when none is set (the caller decides whether that's fatal).
async function resolveKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const m = (await readFile(join(process.cwd(), '.env'), 'utf8')).match(/^\s*OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* try next source */ }
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.spool.json'), 'utf8'));
    if (cfg.openaiKey) return cfg.openaiKey;
  } catch { /* no key anywhere */ }
  return null;
}

// Resolve hosted VO {host, token} from env, then ~/.spool.json; null if incomplete.
async function resolveHosted() {
  let host = process.env.SPOOL_HOST;
  let token = process.env.SPOOL_PUBLISH_TOKEN;
  if (!host || !token) {
    try {
      const cfg = JSON.parse(await readFile(join(homedir(), '.spool.json'), 'utf8'));
      host = host || cfg.host;
      token = token || cfg.token;
    } catch { /* no config */ }
  }
  return host && token ? { host: host.replace(/\/$/, ''), token } : null;
}

// Pick the engine: explicit wins; else a local key → openai; else hosted config → hosted.
async function resolveEngine(explicit) {
  if (explicit) return explicit;
  if (await resolveKey()) return 'openai';
  if (await resolveHosted()) return 'hosted';
  throw new Error(
    'no VO engine available — set OPENAI_API_KEY (env, ./.env, or "openaiKey" in ~/.spool.json), ' +
      'add host+token to ~/.spool.json for hosted voice, or pass --engine local with SPOOL_VO_SH'
  );
}

// --- hosted VO (spool web app: OpenAI without the user's own key) -----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST narration to {host}/api/vo → { audio: base64 wav, words: [{word,start,end}] }.
async function hostedSpeech({ host, token }, text, voice, instructions) {
  const res = await hostedFetch(`${host}/api/vo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, voice, instructions }),
  });
  const json = await res.json();
  return { audio: json.audio, words: json.words || [] };
}

// Retry 5xx once with backoff; surface the server's error (incl. 429 daily cap).
async function hostedFetch(url, opts, attempt = 0) {
  const res = await fetch(url, opts);
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  if (res.status >= 500 && attempt < 1) {
    await sleep(1500 * (attempt + 1));
    return hostedFetch(url, opts, attempt + 1);
  }
  let msg = body;
  try { msg = JSON.parse(body).error || body; } catch { /* non-json body */ }
  throw new Error(`hosted VO ${res.status}: ${msg}`);
}

// --- local fallback (video-studio vo.sh: Higgs TTS + whisper) --------------

async function localSegment(text, voDir, nn, wordsAbs) {
  const voSh = process.env.SPOOL_VO_SH || join(homedir(), 'Projects/video-studio/scripts/vo.sh');
  if (!existsSync(voSh)) throw new Error(`local engine needs a vo.sh (set SPOOL_VO_SH; looked at ${voSh})`);
  // vo.sh writes <base>.wav (already loudnormed 24kHz mono) + <base>_words.json ([[start,end,text],…]).
  const base = join(voDir, `seg_${nn}`); // => base.wav is exactly our seg_NN.wav
  await run('bash', [voSh, text, base]);
  const chunks = JSON.parse(await readFile(`${base}_words.json`, 'utf8'));
  await writeFile(wordsAbs, JSON.stringify(chunksToWords(chunks)));
  await rm(`${base}_words.json`, { force: true }).catch(() => {});
  await rm(`${base}.srt`, { force: true }).catch(() => {});
}

// --- ffmpeg / ffprobe ------------------------------------------------------

async function loudnorm(inPath, outPath, speed = 1) {
  // atempo is pitch-preserving; applied before transcription so word times match the final wav
  const af = speed !== 1 ? `atempo=${speed},loudnorm=I=-16:TP=-1.5` : 'loudnorm=I=-16:TP=-1.5';
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', inPath, '-af', af, '-ar', '24000', '-ac', '1', outPath]);
}

async function probeDuration(path) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nk=1:nw=1', path]);
  return parseFloat(stdout.trim());
}

function run(cmd, args) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res({ stdout: out, stderr: err }) : rej(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}

// --- CLI -------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  const map = { '--steps': 'stepsFile', '--workdir': 'workdir', '--engine': 'engine', '--voice': 'voice', '--instructions': 'instructions', '--speed': 'speed' };
  for (let i = 0; i < argv.length; i += 2) {
    const key = map[argv[i]];
    if (!key) throw new Error(`unknown flag: ${argv[i]}`);
    out[key] = key === 'speed' ? Number(argv[i + 1]) : argv[i + 1];
  }
  return out;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  generateVO(parseArgs(process.argv.slice(2)))
    .then((m) => {
      console.log(`vo: ${m.segments.length} segment(s), engine=${m.engine}, voice=${m.voice}`);
      for (const s of m.segments) console.log(`  seg_${String(s.i).padStart(2, '0')} ${s.name} — ${s.duration}s`);
    })
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
