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

export async function generateVO({ stepsFile, workdir, engine = 'openai', voice = 'alloy', instructions, speed = 1 } = {}) {
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
  const key = engine === 'openai' ? await resolveKey() : null;

  // One job per narrated step. TTS → loudnorm → whisper stay sequential inside a
  // job; jobs run through a bounded pool so the wall-time is ~total/CONCURRENCY.
  const jobs = steps
    .map((step, i) => ({ step, i, narration: (step.narration || '').trim() }))
    .filter((j) => j.narration); // un-narrated steps get no segment; index i still mirrors the steps array

  async function buildSegment({ step, i, narration }) {
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
    } else if (engine === 'local') {
      await localSegment(narration, voDir, nn, wordsAbs);
    } else {
      throw new Error(`generateVO: unknown engine "${engine}"`);
    }
    return { i, name: step.name, narration, wav: wavRel, words: wordsRel, duration: round2(await probeDuration(wavAbs)) };
  }

  const CONCURRENCY = 4;
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, jobs.length) }, async () => {
      while (true) {
        const k = next++;
        if (k >= jobs.length) break;
        results[k] = await buildSegment(jobs[k]);
      }
    })
  );
  const segments = results; // jobs were built in step order → manifest stays deterministic

  const manifest = { engine, voice, segments };
  await writeFile(join(voDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
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

async function resolveKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  // Fallbacks: the target project's .env, then the shared CLI config (~/.spool.json).
  try {
    const m = (await readFile(join(process.cwd(), '.env'), 'utf8')).match(/^\s*OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* try next source */ }
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.spool.json'), 'utf8'));
    if (cfg.openaiKey) return cfg.openaiKey;
  } catch { /* fall through to the error below */ }
  throw new Error('OPENAI_API_KEY not set (env, ./.env, or "openaiKey" in ~/.spool.json)');
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
