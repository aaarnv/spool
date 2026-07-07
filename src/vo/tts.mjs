#!/usr/bin/env node
// src/vo/tts.mjs — the VO layer entry point. Turns a loom's steps.mjs narration
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

const DEFAULT_INSTRUCTIONS = 'calm, friendly product-walkthrough narrator; conversational, unhurried';
const round2 = (x) => Math.round(x * 100) / 100;

export async function generateVO({ stepsFile, workdir, engine = 'openai', voice = 'alloy', instructions, speed = 1 } = {}) {
  if (!stepsFile) throw new Error('generateVO: stepsFile required');
  if (!workdir) throw new Error('generateVO: workdir required');

  const mod = await import(pathToFileURL(resolve(stepsFile)).href);
  const steps = mod.steps || [];
  const voDir = join(workdir, 'vo');
  await mkdir(voDir, { recursive: true });

  const instr = instructions ?? DEFAULT_INSTRUCTIONS;
  const key = engine === 'openai' ? await resolveKey() : null;

  const segments = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const narration = (step.narration || '').trim();
    if (!narration) continue; // un-narrated steps get no segment; index i still mirrors the steps array

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

    segments.push({ i, name: step.name, narration, wav: wavRel, words: wordsRel, duration: round2(await probeDuration(wavAbs)) });
  }

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
  const envPath = join(homedir(), 'Projects/life-dashboard/.env');
  try {
    const m = (await readFile(envPath, 'utf8')).match(/^\s*OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  } catch { /* fall through to the error below */ }
  throw new Error(`OPENAI_API_KEY not found in env or ${envPath}`);
}

// --- local fallback (video-studio vo.sh: Higgs TTS + whisper) --------------

async function localSegment(text, voDir, nn, wordsAbs) {
  const voSh = join(homedir(), 'Projects/video-studio/scripts/vo.sh');
  if (!existsSync(voSh)) throw new Error(`local engine needs ${voSh} (not found)`);
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
