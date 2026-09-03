import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  activePlanVisual,
  buildPlanCards,
  chapterCardType,
  planStageLayout,
  visualModeForChapter,
} from '../src/render/plan/model.mjs';
import {
  PLAN_THEME_IDS,
  contrastRatio,
  getPlanTheme,
} from '../src/render/plan/themes.mjs';
import { resolveRenderIntent } from '../src/render/render.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plan = JSON.parse(readFileSync(join(here, 'fixtures/plan/valid-full.json'), 'utf8'));
const evidence = JSON.parse(readFileSync(join(here, 'fixtures/plan/valid-full.evidence.json'), 'utf8'));

const script = {
  kind: 'plan-script',
  goal: plan.goal,
  chapters: ['context', 'outcome', 'approach', 'risks', 'decision'].map((id) => ({
    id,
    title: {
      context: 'What exists today',
      outcome: 'What changes',
      approach: 'How we build it',
      risks: 'What could go wrong',
      decision: 'What we need from you',
    }[id],
    visual: { kind: id === 'risks' || id === 'decision' ? 'card' : 'browser' },
  })),
};

test('builds all six semantic cards from one plan packet', () => {
  const cards = buildPlanCards({ plan, evidence, script });
  assert.deepEqual(cards.map((card) => card.type), [
    'context',
    'outcome',
    'sequence',
    'risks',
    'decision',
    'evidence',
  ]);

  assert.equal(cards[0].claims[0], plan.currentState[0].claim);
  assert.equal(cards[1].statement, plan.outcome);
  assert.deepEqual(cards[2].steps.map((step) => step.label), plan.approach.map((step) => step.summary));
  assert.deepEqual(cards[3].risks, plan.risks);
  assert.deepEqual(cards[3].assumptions, plan.assumptions);
  assert.equal(cards[4].prompt, plan.decision.prompt);
  assert.deepEqual(cards[4].options.map((option) => option.id), plan.decision.options);
  assert.deepEqual(cards[5].items.map((item) => item.label), evidence.items.map((item) => item.label));
});

test('maps canonical chapters to their semantic card type', () => {
  assert.equal(chapterCardType('context'), 'context');
  assert.equal(chapterCardType('outcome'), 'outcome');
  assert.equal(chapterCardType('approach'), 'sequence');
  assert.equal(chapterCardType('risks'), 'risks');
  assert.equal(chapterCardType('decision'), 'decision');
  assert.equal(chapterCardType('unknown'), null);
});

test('uses an overlay for browser and OS evidence, and a card-only fallback', () => {
  assert.equal(visualModeForChapter({ visual: { kind: 'browser' }, timeline: { target: 'browser' } }), 'overlay');
  assert.equal(visualModeForChapter({ visual: { kind: 'terminal' }, timeline: { target: 'os' } }), 'overlay');
  assert.equal(visualModeForChapter({ visual: { kind: 'card' }, timeline: { target: 'os' } }), 'card-only');
  assert.equal(visualModeForChapter({ visual: null, timeline: {} }), 'card-only');
});

test('wide overlay reserves separate media and card bounds', () => {
  const layout = planStageLayout({ width: 1920, height: 1080, mode: 'overlay' });
  assert.deepEqual(layout.canvas, { width: 1920, height: 1080 });
  assert.ok(layout.media.width >= 1040);
  assert.ok(layout.card.width >= 500);
  assert.ok(layout.media.x + layout.media.width <= layout.card.x);
  assert.ok(layout.card.x + layout.card.width <= 1920);
  assert.ok(layout.caption.y >= layout.media.y + layout.media.height);
});

test('portrait overlay stacks media and card without overlap', () => {
  const layout = planStageLayout({ width: 1080, height: 1920, mode: 'overlay' });
  assert.ok(layout.media.y + layout.media.height <= layout.card.y);
  assert.ok(layout.card.y + layout.card.height <= layout.caption.y);
  assert.ok(layout.caption.y + layout.caption.height <= 1920);
});

test('card-only layout removes the media stage and centers a readable card', () => {
  const layout = planStageLayout({ width: 1920, height: 1080, mode: 'card-only' });
  assert.equal(layout.media, null);
  assert.ok(layout.card.width >= 1200);
  assert.ok(layout.card.height >= 700);
  assert.ok(layout.card.x > 0 && layout.card.y > 0);
});

test('ships three distinct token-driven visual directions', () => {
  assert.deepEqual(PLAN_THEME_IDS, [
    'editorial-minimal',
    'technical-system',
    'warm-briefing',
  ]);
  const themes = PLAN_THEME_IDS.map(getPlanTheme);
  assert.equal(new Set(themes.map((theme) => theme.font.display)).size, 3);
  assert.equal(new Set(themes.map((theme) => theme.color.surface)).size, 3);
  assert.equal(new Set(themes.map((theme) => theme.radius.card)).size, 3);
  assert.equal(new Set(themes.map((theme) => theme.motion.reveal)).size, 3);
});

test('every theme meets WCAG AA text contrast', () => {
  for (const id of PLAN_THEME_IDS) {
    const theme = getPlanTheme(id);
    assert.ok(
      contrastRatio(theme.color.text, theme.color.surface) >= 4.5,
      `${id} primary text lacks 4.5:1 contrast`,
    );
    assert.ok(
      contrastRatio(theme.color.mutedText, theme.color.surface) >= 4.5,
      `${id} muted text lacks 4.5:1 contrast`,
    );
    assert.ok(
      contrastRatio(theme.color.accentText, theme.color.accent) >= 4.5,
      `${id} accent text lacks 4.5:1 contrast`,
    );
  }
});

test('theme lookup rejects an unknown direction', () => {
  assert.throws(() => getPlanTheme('corporate-blue'), /unknown plan theme/);
});

test('resolves the active chapter, semantic card, mode, and evidence', () => {
  const cards = buildPlanCards({ plan, evidence, script });
  const windows = [
    { name: 'context', startSec: 0, endSec: 2 },
    { name: 'approach', startSec: 2, endSec: 6 },
    { name: 'risks', startSec: 6, endSec: 9 },
  ];
  const state = activePlanVisual({ cards, script, windows, timeline: { target: 'os' }, time: 3 });
  assert.equal(state.chapter.id, 'approach');
  assert.equal(state.card.type, 'sequence');
  assert.equal(state.mode, 'overlay');
  assert.deepEqual(state.evidence.map((item) => item.id), ['ev-schema']);

  const fallback = activePlanVisual({ cards, script, windows, timeline: { target: 'os' }, time: 7 });
  assert.equal(fallback.card.type, 'risks');
  assert.equal(fallback.mode, 'card-only');
});

test('render intent preserves an explicit plan theme for reproducible renders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-plan-visual-'));
  try {
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ viewport: { width: 1600, height: 900 }, steps: [] }));
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
    await writeFile(join(dir, 'steps.mjs'), 'export const config = { format: "wide", planTheme: "technical-system" };\n');
    const intent = await resolveRenderIntent(dir, { bg: 'indigo', format: 'wide' });
    assert.equal(intent.planTheme, 'technical-system');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('render intent uses the founder-selected warm briefing default', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-plan-default-theme-'));
  try {
    await writeFile(join(dir, 'timeline.json'), JSON.stringify({ viewport: { width: 1600, height: 900 }, steps: [] }));
    await writeFile(join(dir, 'plan.json'), JSON.stringify(plan));
    const intent = await resolveRenderIntent(dir, { bg: 'indigo', format: 'wide' });
    assert.equal(intent.planTheme, 'warm-briefing');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('visual baseline manifest covers every card and source mode in every direction', async () => {
  const manifestPath = join(here, 'fixtures/plan-visuals/manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const cardTypes = ['context', 'outcome', 'sequence', 'risks', 'decision', 'evidence'];
  const directionFrames = ['overview', 'browser-overlay', 'os-overlay', 'card-only', 'portrait'];

  assert.deepEqual(manifest.themes, PLAN_THEME_IDS);
  assert.deepEqual(manifest.cardTypes, cardTypes);
  assert.deepEqual(manifest.directionFrames, directionFrames);
  assert.equal(manifest.baselines.length, PLAN_THEME_IDS.length * (cardTypes.length + directionFrames.length));

  const expected = PLAN_THEME_IDS.flatMap((theme) => [
    ...cardTypes.map((name) => `${theme}/cards/${name}.png`),
    ...directionFrames.map((name) => `${theme}/${name}.png`),
  ]).sort();
  assert.deepEqual(manifest.baselines.map((item) => item.file).sort(), expected);

  // The rendered baselines live in docs/design, which the OSS mirror strips.
  const baselineDir = join(here, '..', 'docs/design/r2-directions');
  if (!existsSync(baselineDir)) return;
  for (const baseline of manifest.baselines) {
    const file = join(baselineDir, baseline.file);
    const info = await stat(file);
    assert.ok(info.size > 10_000, `${baseline.file} is not a rendered baseline`);
  }
});
