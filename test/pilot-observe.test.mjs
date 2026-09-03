// Self-observation, read back (roadmap R6.2).
//
// The verdicts in `spool pilot synthesize` are arithmetic over these rows, so this file
// is where the arithmetic is pinned: what a receipt becomes, which receipt wins when a
// session leaves two, and that every rate names the denominator it was taken over.

import test from 'node:test';
import assert from 'node:assert/strict';

import { OBSERVATION_EVENT, observationSummary, observationsOf, quotes } from '../src/pilot/observe.mjs';

const REV1 = '11111111-1111-4111-8111-111111111111';
const REV2 = '22222222-2222-4222-8222-222222222222';
const at = (n) => new Date(Date.parse('2026-08-01T00:00:00.000Z') + n * 60_000).toISOString();

const chapter = (id, over = {}) => ({
  id,
  coverage: 1,
  rewatchedRatio: 0,
  skipped: false,
  rewatched: false,
  ...over,
});

const observation = ({ revisionId = REV1, minute = 0, chapters, decision, note } = {}) => ({
  type: OBSERVATION_EVENT,
  revisionId,
  at: at(minute),
  actorType: 'owner',
  payload: {
    version: 1,
    trace: {
      version: 1,
      videoMs: 120_000,
      watchedMs: 90_000,
      watchedRatio: 0.75,
      reachedEnd: false,
      positionMs: 100_000,
      sinceFirstPlayMs: 240_000,
      chapters: chapters ?? [chapter('context'), chapter('risks', { coverage: 0.1, skipped: true })],
    },
    decision: decision === null ? null : { action: 'approve', atVideoMs: 100_000, beforeEnd: true, sinceFirstPlayMs: 240_000, ...decision },
    note:
      note === undefined
        ? null
        : { perspective: 'decider', effect: 'quality', wouldRequire: 'yes', faster: '', distrust: '', stillNeeded: '', ...note },
  },
});

test("an observation flattens into the row the metrics read", () => {
  const [row] = observationsOf([observation()], 'SPL-99');
  assert.equal(row.taskKey, 'SPL-99');
  assert.equal(row.revisionId, REV1);
  assert.deepEqual(row.skipped, ['risks']);
  assert.deepEqual(row.rewatched, []);
  assert.equal(row.decidedBeforeEnd, true);
  assert.equal(row.sessionToDecisionMs, 240_000);
  // Measured and not asked is a different fact from asked and left empty.
  assert.equal(row.note, null);
});

test("the receipt with a note beats the one without, and one revision yields one row", () => {
  const rows = observationsOf(
    [observation({ minute: 0 }), observation({ minute: 1, note: { distrust: 'the diff link 404ed' } })],
    'SPL-99'
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].note.distrust, 'the diff link 404ed');
});

test("two revisions are two observations: each is about a different cut of the plan", () => {
  const rows = observationsOf([observation({ revisionId: REV1 }), observation({ revisionId: REV2, minute: 30 })], 'SPL-99');
  assert.equal(rows.length, 2);
});

test("a plan with no observations reports none rather than empty ones", () => {
  assert.deepEqual(observationsOf([{ type: 'plan_published', revisionId: REV1 }], 'SPL-99'), []);
  assert.deepEqual(observationsOf(null, 'SPL-99'), []);
});

test("every rate is taken over the denominator it names", () => {
  const rows = [
    ...observationsOf([observation({ note: { effect: 'quality', wouldRequire: 'yes' } })], 'SPL-1'),
    ...observationsOf([observation({ note: { effect: 'presentation', wouldRequire: 'unsure', stillNeeded: 'the migration list' } })], 'SPL-2'),
    // Measured, never asked: it counts as a session and a decision, and not as a note.
    ...observationsOf([observation({ decision: { beforeEnd: false } })], 'SPL-3'),
  ];
  const s = observationSummary(rows);

  assert.equal(s.observations, 3);
  assert.equal(s.chains, 3);
  assert.equal(s.withDecision, 3);
  assert.equal(s.withNote, 2);
  // Two of three DECISIONS came before the end — not two of two notes.
  assert.equal(s.decidedBeforeEndRate, 0.667);
  assert.equal(s.effect.quality, 1);
  assert.equal(s.effect.presentation, 1);
  assert.equal(s.effect.neither, 0);
  assert.equal(s.stillNeededNamed, 1);
  assert.equal(s.distrustNamed, 0);
});

test("chapter rates are taken over the sessions that saw the chapter", () => {
  const rows = [
    ...observationsOf([observation({ chapters: [chapter('risks', { skipped: true, coverage: 0.1 })] })], 'SPL-1'),
    ...observationsOf([observation({ chapters: [chapter('risks'), chapter('approach', { rewatched: true, rewatchedRatio: 0.6 })] })], 'SPL-2'),
  ];
  const s = observationSummary(rows);
  const risks = s.chapters.find((c) => c.id === 'risks');
  const approach = s.chapters.find((c) => c.id === 'approach');

  assert.equal(risks.seen, 2);
  assert.equal(risks.skipRate, 0.5);
  // Only one session ever saw the approach chapter, so its rate is over one.
  assert.equal(approach.seen, 1);
  assert.equal(approach.rewatchRate, 1);
});

test("a quote carries the chain it came from, so no claim is unattributed", () => {
  const rows = [
    ...observationsOf([observation({ note: { distrust: 'the evidence link was dead' } })], 'SPL-7'),
    ...observationsOf([observation({ note: { distrust: '' } })], 'SPL-8'),
  ];
  assert.deepEqual(
    quotes(rows, 'distrust').map((q) => [q.taskKey, q.text]),
    [['SPL-7', 'the evidence link was dead']]
  );
});
