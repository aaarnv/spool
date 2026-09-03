// The plan narration + steps generator: what it says, what it refuses to say,
// and that it says the same thing twice.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CHAPTER_MAX,
  DURATION_MAX_SECONDS,
  DURATION_MIN_SECONDS,
  REQUIRED_CHAPTERS,
  STEPS_MARKER,
  VISUAL_LANGUAGES,
  VOICE_PROFILES,
  formatScript,
  generatePlanScript,
  lintPlanScript,
  renderStepsModule,
  resolveStyle,
  writeStepsModule,
} from '../src/plan/generate.mjs';
import { refinePlanScript } from '../src/plan/outline-llm.mjs';
import { validatePacket } from '../src/plan/schema.mjs';
import { validateStepsModule } from '../src/record/validate.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'plan');
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

const FULL = { plan: fixture('valid-full.json'), evidence: fixture('valid-full.evidence.json') };
const MINIMAL = { plan: fixture('valid-minimal.json'), evidence: null };

const style = (voice = 'direct-technical', visuals = 'code-forward') => ({
  voice: VOICE_PROFILES[voice],
  visuals: VISUAL_LANGUAGES[visuals],
});

const chapter = (script, id) => script.chapters.find((c) => c.id === id);

// --- shape ------------------------------------------------------------------

test('generates the acceptance chapter shape with a visual per chapter', () => {
  const script = generatePlanScript(FULL, style());
  for (const id of REQUIRED_CHAPTERS) {
    assert.ok(chapter(script, id), `expected a "${id}" chapter`);
  }
  assert.ok(script.chapters.length >= 3 && script.chapters.length <= CHAPTER_MAX);
  for (const c of script.chapters) {
    assert.ok(c.visual && c.visual.kind, `${c.id} has no visual`);
    assert.ok(c.narration.trim().length > 0);
    assert.equal(c.step.name, c.id);
    assert.equal(c.step.narration, c.narration);
  }
});

test('the outline lands inside the 45 to 120 second format', () => {
  const script = generatePlanScript(FULL, style());
  assert.ok(script.estimatedSeconds >= DURATION_MIN_SECONDS, `${script.estimatedSeconds}s is under the floor`);
  assert.ok(script.estimatedSeconds <= DURATION_MAX_SECONDS, `${script.estimatedSeconds}s is over the ceiling`);
  const summed = script.chapters.reduce((s, c) => s + c.estimatedSeconds, 0);
  assert.equal(script.estimatedSeconds, Math.round(summed * 10) / 10);
});

test('the decision chapter carries a card that matches plan.json', () => {
  const script = generatePlanScript(FULL, style());
  const card = chapter(script, 'decision').card;
  assert.equal(card.type, FULL.plan.decision.type);
  assert.equal(card.prompt, FULL.plan.decision.prompt);
  assert.deepEqual(card.options.map((o) => o.id), FULL.plan.decision.options);
  // The named alternative is spelled out, not left as "alternative:<id>".
  assert.equal(card.options[1].label, 'Use an unanchored thread only');
  assert.match(chapter(script, 'decision').narration, /Use an unanchored thread only/);
});

test('chapters follow the order plan.json declares', () => {
  const script = generatePlanScript(FULL, style());
  assert.deepEqual(script.chapters.map((c) => c.id), FULL.plan.chapters.map((c) => c.id));
});

test('a plan without chapters gets the five canonical ones', () => {
  const script = generatePlanScript(MINIMAL, style());
  assert.deepEqual(script.chapters.map((c) => c.id), ['context', 'outcome', 'approach', 'risks', 'decision']);
});

// --- determinism ---------------------------------------------------------------

test('generation is deterministic', () => {
  const a = JSON.stringify(generatePlanScript(FULL, style()));
  const b = JSON.stringify(generatePlanScript(FULL, style()));
  assert.equal(a, b);
});

test('style changes the narration and the visual preference', () => {
  const technical = generatePlanScript(FULL, style('direct-technical', 'code-forward'));
  const client = generatePlanScript(FULL, style('calm-client-ready', 'product-forward'));
  assert.notEqual(technical.chapters[0].narration, client.chapters[0].narration);
  assert.equal(technical.voice.profile, 'direct-technical');
  assert.equal(client.visualLanguage, 'product-forward');
  // code-forward names the artifact on screen; product-forward keeps it out.
  assert.match(technical.chapters[0].narration, /Existing AskPanel implementation/);
  assert.doesNotMatch(client.chapters[0].narration, /Existing AskPanel implementation/);
  assert.ok(technical.voice.instructions.length > 0);
});

test('resolveStyle rejects an unknown profile by name', async () => {
  await assert.rejects(() => resolveStyle({ voice: 'shouty' }), /unknown plan voice "shouty"/);
  await assert.rejects(() => resolveStyle({ visuals: 'vibes' }), /unknown plan visual language "vibes"/);
});

// --- it never invents ------------------------------------------------------------

test('every sentence traces back to a packet path', () => {
  const script = generatePlanScript(FULL, style());
  const report = lintPlanScript(script, FULL);
  assert.deepEqual(report.errors, []);
  for (const c of script.chapters) assert.ok(c.sources.length > 0, `${c.id} records no source`);
  assert.deepEqual(chapter(script, 'context').sources, ['evidence:ev-askpanel', 'plan.currentState[0].claim']);
});

test('narration only repeats claims the author wrote', () => {
  const script = generatePlanScript(FULL, style());
  // Every author claim in the packet is spoken verbatim somewhere.
  const spoken = script.chapters.map((c) => c.narration).join(' ');
  for (const claim of [
    FULL.plan.currentState[0].claim,
    ...FULL.plan.approach.map((a) => a.summary),
    ...FULL.plan.risks,
    FULL.plan.decision.prompt,
  ]) {
    assert.ok(spoken.includes(claim), `not spoken: ${claim}`);
  }
});

test('an invented source is a lint error', () => {
  const script = generatePlanScript(FULL, style());
  chapter(script, 'risks').sources.push('plan.risks[7]');
  const report = lintPlanScript(script, FULL);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'invented-source' && e.message.includes('plan.risks[7]')));
});

test('a chapter showing undeclared evidence is a lint error', () => {
  const script = generatePlanScript(FULL, style());
  chapter(script, 'context').visual.source = 'evidence:ev-imaginary';
  const report = lintPlanScript(script, FULL);
  assert.ok(report.errors.some((e) => e.code === 'unknown-evidence'));
});

test('a decision card that drifts from plan.json is a lint error', () => {
  const script = generatePlanScript(FULL, style());
  chapter(script, 'decision').card.prompt = 'Ship it, no questions.';
  assert.ok(lintPlanScript(script, FULL).errors.some((e) => e.code === 'decision-drift'));

  const drifted = generatePlanScript(FULL, style());
  chapter(drifted, 'decision').card.options.pop();
  assert.ok(lintPlanScript(drifted, FULL).errors.some((e) => e.code === 'decision-drift'));
});

// --- quality lint -------------------------------------------------------------------

test('a missing required chapter fails the lint by name', () => {
  const plan = { ...FULL.plan, chapters: [{ id: 'context' }, { id: 'approach' }, { id: 'decision' }] };
  const packet = { ...FULL, plan };
  const report = lintPlanScript(generatePlanScript(packet, style()), packet);
  assert.equal(report.ok, false);
  const missing = report.errors.find((e) => e.code === 'missing-chapter');
  assert.match(missing.message, /no "risks" chapter/);
  assert.match(missing.message, /Add \{"id": "risks"\} to plan\.json chapters/);
});

test('an over-length outline fails and an under-length one warns', () => {
  const long = { ...FULL, plan: { ...FULL.plan, risks: Array.from({ length: 40 }, (_, i) => `Risk number ${i} needs a careful and lengthy explanation before anyone can judge it.`) } };
  const longReport = lintPlanScript(generatePlanScript(long, style()), long);
  assert.ok(longReport.errors.some((e) => e.code === 'too-long'));

  const shortReport = lintPlanScript(generatePlanScript(MINIMAL, style()), MINIMAL);
  assert.equal(shortReport.ok, true);
  assert.ok(shortReport.warnings.some((w) => w.code === 'too-short'));
});

test('a context chapter with no currentState warns that the premise is missing', () => {
  const report = lintPlanScript(generatePlanScript(MINIMAL, style()), MINIMAL);
  assert.ok(report.warnings.some((w) => w.code === 'thin-context'));
});

test('a chapter with no evidence warns, and the decision card does not', () => {
  const report = lintPlanScript(generatePlanScript(FULL, style()), FULL);
  const cardWarnings = report.warnings.filter((w) => w.code === 'no-evidence-visual');
  assert.deepEqual(cardWarnings.map((w) => w.path), ['chapters[2].visual']); // risks only
});

test('every lint message names the chapter it is about', () => {
  const report = lintPlanScript(generatePlanScript(MINIMAL, style()), MINIMAL);
  for (const d of [...report.errors, ...report.warnings]) {
    assert.ok(d.path && d.message, 'a diagnostic must carry a path and a message');
  }
});

test('a script from a newer generator is rejected loudly', () => {
  const script = generatePlanScript(FULL, style());
  const report = lintPlanScript({ ...script, version: 99 }, FULL);
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].code, 'unsupported-version');
});

// --- authored visual hints ---------------------------------------------------------

test('a chapter visual hint overrides the derived visual', () => {
  const plan = {
    ...FULL.plan,
    chapters: FULL.plan.chapters.map((c) =>
      c.id === 'approach'
        ? { ...c, visual: { kind: 'browser', url: 'http://localhost:3000/plans', selector: '.plan-card', label: 'The plan list' } }
        : c
    ),
  };
  const packet = { ...FULL, plan };
  // The hint is additive: the packet is still valid without the generator.
  assert.equal(validatePacket(packet).ok, true);

  const visual = chapter(generatePlanScript(packet, style()), 'approach').visual;
  assert.equal(visual.kind, 'browser');
  assert.equal(visual.ref, 'http://localhost:3000/plans');
  assert.deepEqual(visual.zoom, { selector: '.plan-card' });
});

test('a hint can point a chapter at a declared evidence descriptor', () => {
  const plan = {
    ...FULL.plan,
    chapters: FULL.plan.chapters.map((c) => (c.id === 'risks' ? { ...c, visual: { evidence: 'ev-schema' } } : c)),
  };
  const packet = { ...FULL, plan };
  const visual = chapter(generatePlanScript(packet, style()), 'risks').visual;
  assert.equal(visual.source, 'evidence:ev-schema');
  assert.equal(visual.kind, 'code');
  assert.equal(lintPlanScript(generatePlanScript(packet, style()), packet).ok, true);
});

// --- steps.mjs emitter ----------------------------------------------------------------

test('the emitted steps.mjs is a valid steps module, one step per chapter', async () => {
  const script = generatePlanScript(FULL, style());
  const dir = await mkdtemp(join(tmpdir(), 'spool-gen-'));
  try {
    const p = await writeStepsModule(dir, script, { url: 'http://localhost:3000', title: 'Plan' });
    const mod = await import(pathToFileURL(p).href);
    validateStepsModule(mod, 'steps.mjs');
    assert.deepEqual(mod.steps.map((s) => s.name), script.chapters.map((c) => c.id));
    assert.equal(mod.steps[0].narration, script.chapters[0].narration);
    assert.equal(mod.config.url, 'http://localhost:3000');
    assert.ok(readFileSync(p, 'utf8').includes(STEPS_MARKER));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a browser visual navigates and a selector is waited for', () => {
  const plan = {
    ...FULL.plan,
    chapters: FULL.plan.chapters.map((c) =>
      c.id === 'approach' ? { ...c, visual: { kind: 'browser', url: 'http://localhost:3000/plans', selector: '.plan-card' } } : c
    ),
  };
  const src = renderStepsModule(generatePlanScript({ ...FULL, plan }, style()), { url: 'http://localhost:3000' });
  assert.match(src, /await page\.goto\("http:\/\/localhost:3000\/plans"\)/);
  assert.match(src, /await page\.waitForSelector\("\.plan-card"\)/);
  assert.match(src, /await h\.hover\("\.plan-card"\)/);
});

test('the emitter refuses to clobber a steps.mjs it did not write', async () => {
  const script = generatePlanScript(FULL, style());
  const dir = await mkdtemp(join(tmpdir(), 'spool-gen-'));
  try {
    await writeFile(join(dir, 'steps.mjs'), '// hand-authored\nexport const config = { url: "http://x" };\nexport const steps = [];\n');
    await assert.rejects(() => writeStepsModule(dir, script, { url: 'http://x' }), /--force/);
    await writeStepsModule(dir, script, { url: 'http://x', force: true });
    assert.ok((await readFile(join(dir, 'steps.mjs'), 'utf8')).includes(STEPS_MARKER));
    // Its own output is regenerated without --force.
    await writeStepsModule(dir, script, { url: 'http://x' });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the emitter needs a URL', () => {
  assert.throws(() => renderStepsModule(generatePlanScript(FULL, style()), {}), /url required/);
});

test('formatScript prints one line per chapter', () => {
  const out = formatScript(generatePlanScript(FULL, style()));
  assert.match(out, /4 chapters/);
  for (const id of REQUIRED_CHAPTERS) assert.match(out, new RegExp(`\\n  ${id}`));
});

// --- the live path -----------------------------------------------------------------

test('chapters carry the POST /step body a live session replays', () => {
  const script = generatePlanScript(FULL, style());
  for (const c of script.chapters) {
    assert.deepEqual(Object.keys(c.step).sort(), ['chapterId', 'name', 'narration', 'zoom']);
    assert.ok(c.step.narration.length > 0); // the control protocol requires it
    assert.equal(c.step.chapterId, c.id); // the anchor the watch page seeks by
  }
});

// --- optional LLM refinement ----------------------------------------------------------

const stub = (reply) => async () => (typeof reply === 'string' ? reply : JSON.stringify(reply));

test('an LLM rewrite is kept when it stays inside the packet', async () => {
  const script = generatePlanScript(FULL, style());
  const rewritten = script.chapters.map((c) => ({ id: c.id, narration: c.narration.replace('First, where things stand today.', 'Here is the state today.') }));
  const { script: refined, warnings } = await refinePlanScript(script, FULL, { complete: stub({ chapters: rewritten }) });
  assert.deepEqual(warnings, []);
  assert.equal(refined.generator, 'llm-refined');
  assert.match(chapter(refined, 'context').narration, /Here is the state today/);
  assert.equal(chapter(refined, 'context').step.narration, chapter(refined, 'context').narration);
  assert.equal(lintPlanScript(refined, FULL).ok, true);
});

test('an invented fact is dropped per chapter, with the reason', async () => {
  const script = generatePlanScript(FULL, style());
  const rewritten = script.chapters.map((c) =>
    c.id === 'context' ? { id: c.id, narration: c.narration.replace('Watch pages', 'The 47 watch pages in web/app/legacy.tsx') } : { id: c.id, narration: c.narration }
  );
  const { script: refined, warnings } = await refinePlanScript(script, FULL, { complete: stub({ chapters: rewritten }) });
  assert.equal(chapter(refined, 'context').narration, chapter(script, 'context').narration);
  assert.ok(warnings.some((w) => w.code === 'llm-invented-fact' && w.message.includes('web/app/legacy.tsx')));
});

test('a changed chapter set drops the whole rewrite', async () => {
  const script = generatePlanScript(FULL, style());
  const { script: refined, warnings } = await refinePlanScript(script, FULL, {
    complete: stub({ chapters: [{ id: 'context', narration: 'Just this one.' }] }),
  });
  assert.equal(refined, script);
  assert.ok(warnings.some((w) => w.code === 'chapter-set-changed'));
});

test('an unreadable model reply falls back to the deterministic script', async () => {
  const script = generatePlanScript(FULL, style());
  const { script: refined, warnings } = await refinePlanScript(script, FULL, { complete: stub('not json') });
  assert.equal(refined, script);
  assert.ok(warnings.some((w) => w.code === 'llm-unusable'));
});

test('a rewrite that drifts in length is dropped', async () => {
  const script = generatePlanScript(FULL, style());
  const rewritten = script.chapters.map((c) => ({ id: c.id, narration: c.id === 'risks' ? 'Short.' : c.narration }));
  const { warnings } = await refinePlanScript(script, FULL, { complete: stub({ chapters: rewritten }) });
  assert.ok(warnings.some((w) => w.code === 'llm-length-drift'));
});
