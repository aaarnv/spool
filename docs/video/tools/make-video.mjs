#!/usr/bin/env node
// The V0 pipeline: plan packet in, finished vertical MP4 out.
//   node docs/video/tools/make-video.mjs <plan.json> <out.mp4> [--mode pov|commentary|broadcast|ambient] [--voice <id>] [--engine hosted|fish|openai] [--bg <slug|random>]
//
// Steps: scriptwriter (claude) -> slop lint (retry once with findings) ->
// diagrammer (claude) -> VO (spool vo) -> deterministic render (render.mjs).
//
// The prompts and the two gates live in src/packet/, because the render worker runs
// the same pipeline with the platform's model instead of the local claude CLI
// (src/packet/author.mjs) and src/ is what ships.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickAmbient } from '../comp/ambient.mjs';
import { lintBeats } from '../../../src/packet/sloplint.mjs';
import { lintDiagrams } from '../../../src/packet/diaglint.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const args = process.argv.slice(2);
const [packetPath, outPath] = args;
const flag = (name, dflt) => { const i = args.indexOf('--' + name); return i === -1 ? dflt : args[i + 1]; };
if (!packetPath || !outPath) { console.error('usage: make-video.mjs <plan.json> <out.mp4> [--mode m] [--voice v] [--engine e] [--bg slug|random]'); process.exit(1); }

const packet = JSON.parse(readFileSync(packetPath, 'utf8'));

// Mode: explicit flag wins; else derive from what the packet is.
let mode = flag('mode', null);
if (!mode) {
  const status = packet.status || packet.state || '';
  const hasDeviation = JSON.stringify(packet).includes('"deviation');
  if (/proved|proof/.test(status)) mode = 'broadcast';
  else if (hasDeviation) mode = 'commentary';
  else mode = 'pov';
}
console.log(`mode: ${mode}`);

const work = resolve(dirname(outPath), '.mv-' + basename(outPath, '.mp4'));
mkdirSync(work, { recursive: true });

const claude = (prompt) => execFileSync('claude', ['-p', prompt, '--model', 'claude-opus-5'],
  { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  .replace(/^```(json)?\n?/, '').replace(/\n?```$/, '');

// 1. script, gated
const swPrompt = readFileSync(join(repo, 'src/packet/SCRIPTWRITER.md'), 'utf8');
let beats, lintOut = '';
for (let attempt = 0; attempt < 2; attempt++) {
  const extra = attempt ? `\n\nYOUR PREVIOUS DRAFT FAILED THE LINT:\n${lintOut}\nFix every finding.` : '';
  const raw = claude(`${swPrompt}${extra}\n\nMODE: ${mode}\n\nPACKET:\n${JSON.stringify(packet)}`);
  // a truncated or unquoted reply is just another finding to hand back
  try { beats = JSON.parse(raw); } catch (e) {
    lintOut = `not valid JSON: ${e.message}`; console.error(`lint attempt ${attempt + 1}: ${lintOut}`); continue;
  }
  writeFileSync(join(work, 'beats.json'), JSON.stringify(beats, null, 2));
  const findings = lintBeats(beats);
  if (!findings.length) { lintOut = ''; break; }
  lintOut = findings.join('\n'); console.error(`lint attempt ${attempt + 1}:\n${lintOut}`);
}
if (lintOut) { console.error('script failed the gate twice; refusing to render slop'); process.exit(1); }
console.log(`script: ${beats.length} beats, lint clean`);

// 2. diagrams, gated the same way — a bare beat is dead air, so coverage is enforced
const dgPrompt = readFileSync(join(repo, 'src/packet/DIAGRAMMER.md'), 'utf8');
let diagrams, dgOut = '';
for (let attempt = 0; attempt < 3; attempt++) {
  const extra = attempt ? `\n\nYOUR PREVIOUS SPEC FAILED THE LINT:\n${dgOut}\nFix every finding.` : '';
  const raw = claude(`${dgPrompt}${extra}\n\nBEATS:\n${JSON.stringify(beats)}`);
  try { diagrams = JSON.parse(raw); } catch (e) {
    dgOut = `not valid JSON: ${e.message}`; console.error(`diagram lint attempt ${attempt + 1}: ${dgOut}`); continue;
  }
  writeFileSync(join(work, 'diagrams.json'), JSON.stringify(diagrams, null, 2));
  const findings = lintDiagrams(diagrams, beats);
  if (!findings.length) { dgOut = ''; break; }
  dgOut = findings.join('\n'); console.error(`diagram lint attempt ${attempt + 1}:\n${dgOut}`);
}
if (dgOut) { console.error('diagram spec failed the gate twice; refusing to render dead air'); process.exit(1); }
console.log(`diagrams: ${diagrams.filter((d) => d.diagram).length}/${beats.length} beats drawn, lint clean`);

// 3. VO
writeFileSync(join(work, 'steps.mjs'), 'export const steps = ' + JSON.stringify(
  beats.map((b) => ({ name: b.name, narration: b.narration })), null, 2) + ';\n');
const engine = flag('engine', 'hosted');
const voice = flag('voice', engine === 'fish' ? 'd75c270eaee14c8aa1e9e980cc37cf1b' : 'alloy');
execSync(`node "${join(repo, 'bin/spool.mjs')}" vo "${work}" --engine ${engine} --voice ${voice} --format vertical`, { cwd: repo, stdio: 'inherit' });

// 4. render (the renderer reads diagrams.json out of the workdir)
// SPOOL_V0_ENGINE=chrome falls back to the screenshot renderer.
const renderer = process.env.SPOOL_V0_ENGINE === 'chrome'
  ? 'docs/video/comp/render.mjs' : 'docs/video/comp/skia/render-skia.mjs';
// The brand ground is the default. --bg names a footage clip, which is what asks for
// the footage ground; seed the pick with the packet name so a re-render keeps it.
const wantsFootage = process.env.SPOOL_GROUND === 'footage' || Boolean(flag('bg', ''));
const bg = wantsFootage ? pickAmbient(flag('bg', 'random'), basename(packetPath, '.json')) : null;
console.log(`ground: ${bg ? `${bg.slug} (${bg.clipDur}s)` : 'brand'}`);
execSync(`node "${join(repo, renderer)}" "${join(repo, 'docs/video/comp/auto.html')}" "${work}" "${resolve(outPath)}" 30`,
  { cwd: repo, stdio: 'inherit', env: { ...process.env, SPOOL_GROUND: bg ? 'footage' : 'brand',
    ...(bg ? { SPOOL_AMBIENT_FILE: bg.src, SPOOL_AMBIENT_DUR: String(bg.clipDur),
      SPOOL_AMBIENT_DIM: String(bg.dim ?? 1) } : {}) } });
console.log(`\nfinished: ${outPath}`);
