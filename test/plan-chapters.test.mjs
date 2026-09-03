// Plan chapter → recording timeline mapping (roadmap R2.1).
//
// The chain under test is the one a reviewer's click travels back along:
//   steps.mjs / POST /step  →  timeline.json  →  retimed window  →  share/spool.json
// Every link carries `chapterId` and nothing else changes, so an old timeline
// keeps its exact shape. The share fixture is the file the web tests read, so a
// change to the mapping fails here before it reaches the watch page.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chapterRanges, chapterIdOf, isChapterId } from '../src/plan/chapters.mjs';
import { buildWindows, FPS } from '../src/render/retime.mjs';
import { shareStep } from '../src/share/share.mjs';
import { validateStepsModule } from '../src/record/validate.mjs';
import { generatePlanScript, renderStepsModule, resolveStyle } from '../src/plan/generate.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtures = join(repo, 'test', 'fixtures', 'plan');
const readJson = async (p) => JSON.parse(await readFile(p, 'utf8'));

const timeline = await readJson(join(fixtures, 'timeline-chapters.json'));
const manifest = await readJson(join(fixtures, 'manifest-chapters.json'));
const v1Timeline = await readJson(join(repo, 'spool-demo', 'meta-tour', 'timeline.json'));

const buildShareSteps = () => {
  const { windows } = buildWindows(timeline, manifest);
  const byIndex = new Map(windows.map((w) => [w.i, w]));
  const narration = new Map((manifest.segments || []).map((s) => [s.i, s.narration]));
  return timeline.steps.map((s) =>
    shareStep(s, byIndex.get(s.i), narration.get(s.i), `frames/step_${String(s.i).padStart(2, '0')}.png`)
  );
};

// --- the field ----------------------------------------------------------------

test('only a declared plan chapter is a chapter ID', () => {
  for (const id of ['context', 'outcome', 'approach', 'risks', 'decision']) assert.ok(isChapterId(id));
  for (const bad of ['Context', 'approach ', 'intro', '', null, undefined, 3]) assert.equal(isChapterId(bad), false);
  assert.equal(chapterIdOf({ name: 'context' }), null); // a name is not an anchor
});

test('a steps.mjs step may carry a chapterId, and only a real one', () => {
  const mod = (chapterId) => ({
    config: { url: 'http://localhost:3000' },
    steps: [{ name: 'risks', chapterId, narration: 'x', run: async () => {} }],
  });
  assert.equal(validateStepsModule(mod('risks'), 'steps.mjs').steps[0].chapterId, 'risks');
  assert.equal(validateStepsModule(mod(undefined), 'steps.mjs').steps[0].chapterId, undefined);
  assert.throws(() => validateStepsModule(mod('rsiks'), 'steps.mjs'), /chapterId "rsiks"/);
});

test('a generated steps.mjs anchors every step by chapterId, keeping the name', async () => {
  const packet = { plan: await readJson(join(fixtures, 'valid-full.json')), evidence: null };
  const script = generatePlanScript(packet, await resolveStyle());
  const src = renderStepsModule(script, { url: 'http://localhost:3000' });
  for (const c of script.chapters) {
    assert.match(src, new RegExp(`name: "${c.id}",\\n\\s+chapterId: "${c.id}",`));
  }
});

// --- capture → render ----------------------------------------------------------

test('a recorded chapter spans from its first step start to its last step end', () => {
  const ranges = chapterRanges(timeline.steps);
  assert.deepEqual(ranges.map((r) => r.id), ['context', 'outcome', 'approach', 'risks', 'decision']);
  const approach = ranges.find((r) => r.id === 'approach');
  assert.deepEqual(approach.steps, [3, 4]);
  assert.equal(approach.start, 14.2); // steps[3].start
  assert.equal(approach.end, 28.6); // steps[4].end
  // The unmapped opening step belongs to no chapter and shifts none of them.
  assert.ok(!ranges.some((r) => r.steps.includes(0)));
});

test('retiming carries the chapter onto the output window', () => {
  const { windows } = buildWindows(timeline, manifest);
  assert.deepEqual(
    windows.map((w) => w.chapterId ?? null),
    [null, 'context', 'outcome', 'approach', 'approach', 'risks', 'decision']
  );
  // Windows are contiguous, so a chapter range has no gap a seek can fall into.
  windows.forEach((w, i) => i > 0 && assert.equal(w.startF, windows[i - 1].endF));
});

// --- share serialization ---------------------------------------------------------

test('the share bundle keeps the chapter and moves the range onto the output clock', () => {
  const steps = buildShareSteps();
  const ranges = chapterRanges(steps);
  const approach = ranges.find((r) => r.id === 'approach');
  const windows = buildWindows(timeline, manifest).windows;
  assert.equal(approach.start, +windows[3].startSec.toFixed(3));
  assert.equal(approach.end, +windows[4].endSec.toFixed(3));
  // Every range boundary is a real output frame: seeking to it cannot land a
  // frame short of the chapter (see the render contract's retiming rules).
  for (const r of ranges) {
    assert.ok(Math.abs(r.start * FPS - Math.round(r.start * FPS)) < 0.51, `${r.id} start off-frame`);
  }
});

test('the checked-in share fixture is what the share layer produces', async () => {
  const path = join(fixtures, 'spool-chapters.json');
  const fixture = await readJson(path);
  const steps = buildShareSteps();
  if (process.env.SPOOL_WRITE_FIXTURES) {
    await writeFile(path, JSON.stringify({ ...fixture, steps }, null, 2) + '\n');
  }
  // web/lib/planChapters.test.ts reads this same file: the CLI writes it, the
  // watch page consumes it, and neither side may drift from the other.
  assert.deepEqual(fixture.steps, steps);
});

// --- v1 compatibility --------------------------------------------------------------

test('a timeline recorded before chapters keeps its exact shape', () => {
  assert.deepEqual(chapterRanges(v1Timeline.steps), []);
  const { windows } = buildWindows(v1Timeline, { segments: [] });
  for (const w of windows) assert.ok(!('chapterId' in w));
  const step = shareStep(v1Timeline.steps[0], windows[0], 'narration', 'frames/step_00.png');
  assert.deepEqual(Object.keys(step), ['i', 'name', 'narration', 'start', 'end', 'clicks', 'frame']);
});
