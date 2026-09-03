// The pilot's arithmetic (roadmap R6.1).
//
// Every number the pilot reports is a pure function of records the product already
// wrote, so these tests are the whole verification of the measurement: if the join is
// right here, the dashboard is right. They also pin the two rules the numbers would be
// dishonest without — an absent fact is null rather than guessed, and every rate names
// its denominator.

import test from 'node:test';
import assert from 'node:assert/strict';

import { chainRecord, summarize } from '../src/pilot/chain.mjs';
import { coverage, validateRoster } from '../src/pilot/scenarios.mjs';

const REV1 = '11111111-1111-4111-8111-111111111111';
const REV2 = '22222222-2222-4222-8222-222222222222';

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const t = (ms) => new Date(Date.parse('2026-08-01T00:00:00.000Z') + ms).toISOString();

/** One redirected-then-approved-then-proved plan, as the event log records it. */
const EVENTS = [
  { type: 'plan_published', revisionId: REV1, at: t(0), payload: { revision: 1 } },
  { type: 'plan_question_created', revisionId: REV1, at: t(1 * HOUR), payload: {} },
  { type: 'plan_decision_submitted', revisionId: REV1, at: t(2 * HOUR), payload: { action: 'redirect', type: 'redirect', reason: 'use the queue' } },
  { type: 'plan_revision_created', revisionId: REV2, at: t(20 * HOUR), payload: { revision: 2 } },
  { type: 'plan_decision_submitted', revisionId: REV2, at: t(21 * HOUR), payload: { action: 'approve', type: 'approve' } },
  { type: 'implementation_started', revisionId: REV2, at: t(22 * HOUR), payload: { policy: 'advisory', bypassed: false } },
  {
    type: 'proof_published',
    revisionId: REV2,
    at: t(3 * DAY),
    payload: {
      spoolId: 'proof-spool',
      proved: true,
      proof: { mode: 'video', outcome: { status: 'partial' }, deviations: [{ from: 'approach', summary: 'shipped collapsed' }] },
    },
  },
];

const REVISIONS = [
  { revisionId: REV1, revision: 1, createdAt: t(0) },
  { revisionId: REV2, revision: 2, createdAt: t(20 * HOUR) },
];

const PAYLOAD = {
  spoolId: 'plan-spool',
  status: 'proved',
  revision: 2,
  revisionId: REV2,
  goal: 'Add the queue.',
  links: { task: 'SPL-99', watch: 'https://spool.dev/l/plan-spool' },
  decision: { action: 'approve', type: 'approve', at: t(21 * HOUR) },
  proofs: [],
  implementation: { verdict: 'on_plan', planValid: true },
};

const ENTRY = { taskKey: 'SPL-99', title: 'Add the queue', scenario: 'risky-refactor', why: 'it is risky' };

test('a full chain reports every stage from the records the product wrote', () => {
  const c = chainRecord({ entry: ENTRY, payload: PAYLOAD, events: EVENTS, revisions: REVISIONS });

  assert.equal(c.taskKey, 'SPL-99');
  assert.equal(c.scenario, 'risky-refactor');
  assert.equal(c.outcome, 'proved');
  assert.equal(c.revisions, 2);
  assert.equal(c.rework, 1, 'rework is revisions beyond the first');
  assert.equal(c.redirects, 1);
  assert.equal(c.questions, 1);

  // The headline number: revision 1 published to the first decision anybody made.
  assert.equal(c.timeToFirstDecisionMs, 2 * HOUR);
  // And each decision timed against the revision the reviewer actually met.
  assert.deepEqual(
    c.decisions.map((d) => [d.action, d.sincePublishMs]),
    [
      ['redirect', 2 * HOUR],
      ['approve', 1 * HOUR],
    ]
  );

  assert.equal(c.implementation.bypassed, false);
  assert.equal(c.implementation.policy, 'advisory');
  assert.equal(c.implementation.verdict, 'on_plan');

  // Deviations are a field of the proof block, never a count of sentences.
  assert.equal(c.deviations, 1);
  assert.equal(c.proof.outcome, 'partial');
  // The north star measures from the approval, not from publication.
  assert.equal(c.timeToProofMs, 3 * DAY - 21 * HOUR);
  assert.equal(c.closedInWindow, true);
  assert.deepEqual(c.notes, []);
});

test('a proof outside the window is closed=false, not omitted', () => {
  const late = EVENTS.map((e) => (e.type === 'proof_published' ? { ...e, at: t(30 * DAY) } : e));
  const c = chainRecord({ entry: ENTRY, payload: PAYLOAD, events: late, revisions: REVISIONS });
  assert.equal(c.outcome, 'proved');
  assert.equal(c.closedInWindow, false);
});

test('without an event log the chain still reports, and says what it could not measure', () => {
  const c = chainRecord({ entry: ENTRY, payload: PAYLOAD, events: null, revisions: REVISIONS });

  // The payload carries the decision on the CURRENT revision, so that one is timed.
  assert.equal(c.decisions.length, 1);
  assert.equal(c.decisions[0].action, 'approve');
  assert.equal(c.decisions[0].sincePublishMs, 1 * HOUR);
  // But the history is gone, so the redirect is invisible rather than assumed absent.
  assert.equal(c.redirects, 0);
  assert.match(c.notes.join(' '), /no event log/);
});

test('an unpublished draft has no revisions, so it cannot enter the rework denominator', () => {
  // The local read of an unpublished packet: a plan, a draft status, no spool id.
  const draft = { spoolId: null, status: 'draft', revision: null, revisionId: null, goal: 'g', links: { task: 'SPL-97' }, decision: null };
  const c = chainRecord({ entry: { ...ENTRY, taskKey: 'SPL-97' }, payload: draft });
  assert.equal(c.revisions, 0, 'revision 1 exists only once the server opened it');
  assert.equal(c.rework, 0);
  assert.equal(c.publishedAt, null);

  // The same packet once it is published reads as revision 1.
  const live = chainRecord({ entry: { ...ENTRY, taskKey: 'SPL-97' }, payload: { ...draft, spoolId: 'sp-1', status: 'awaiting_decision' } });
  assert.equal(live.revisions, 1);
});

test('a rostered chain that never published is a row, not an absence', () => {
  const c = chainRecord({ entry: { ...ENTRY, taskKey: 'PILOT-01', scenario: 'ui-feature' } });
  assert.equal(c.taskKey, 'PILOT-01');
  assert.equal(c.outcome, 'open');
  assert.equal(c.status, null);
  assert.equal(c.timeToFirstDecisionMs, null, 'an unknown time is null, never zero');
  assert.match(c.notes.join(' '), /nothing published yet/);
});

test('an explicit stop is declared, because the lifecycle has no abandoned state', () => {
  const c = chainRecord({
    entry: { ...ENTRY, stop: { at: t(5 * HOUR), reason: 'the requirement went away' } },
    payload: { ...PAYLOAD, status: 'redirected' },
    events: EVENTS.slice(0, 3),
    revisions: REVISIONS.slice(0, 1),
  });
  assert.equal(c.outcome, 'stopped');
  assert.equal(c.stopReason, 'the requirement went away');
});

test('a proof read from the payload has no clock, so its time is null', () => {
  const payload = {
    ...PAYLOAD,
    proofs: [{ spoolId: 'proof-spool', current: true, deviations: [{ from: 'plan', summary: 'x' }] }],
  };
  const c = chainRecord({ entry: ENTRY, payload, events: null, revisions: REVISIONS });
  assert.equal(c.proof.at, null);
  assert.equal(c.deviations, 1);
  assert.equal(c.timeToProofMs, null, 'no proof clock means no duration, never a guess');
});

test('every rate names its own denominator', () => {
  const proved = chainRecord({ entry: ENTRY, payload: PAYLOAD, events: EVENTS, revisions: REVISIONS });
  const awaiting = chainRecord({
    entry: { ...ENTRY, taskKey: 'SPL-98' },
    payload: { ...PAYLOAD, status: 'awaiting_decision', decision: null, revision: 1, revisionId: REV1 },
    events: [EVENTS[0]],
    revisions: REVISIONS.slice(0, 1),
  });
  const unstarted = chainRecord({ entry: { ...ENTRY, taskKey: 'PILOT-02', scenario: 'ui-feature' } });

  const s = summarize([proved, awaiting, unstarted]);
  assert.equal(s.chains, 3);
  assert.equal(s.decided, 1);
  assert.equal(s.approved, 1);
  assert.equal(s.proved, 1);
  assert.equal(s.open, 2);

  // Rework and redirect are over DECIDED chains; a chain nobody decided on cannot
  // have caused rework, and counting it as "no rework" would flatter the number.
  assert.equal(s.reworkRate, 1);
  assert.equal(s.redirectRate, 1);
  // Proof rate and the north star are over APPROVED chains.
  assert.equal(s.proofRate, 1);
  assert.equal(s.northStar.approved, 1);
  assert.equal(s.northStar.closedInWindow, 1);
  assert.equal(s.northStar.rate, 1);
  assert.equal(s.northStar.window, '14d');

  assert.equal(s.timeToDecisionMs.n, 1);
  assert.equal(s.timeToDecisionMs.median, 2 * HOUR);
  assert.equal(s.deviationsStated, 1);
  assert.deepEqual(s.byScenario, { 'risky-refactor': 2, 'ui-feature': 1 });
});

test('an empty pilot summarizes to nulls, never to zero rates', () => {
  const s = summarize([]);
  assert.equal(s.chains, 0);
  assert.equal(s.reworkRate, null);
  assert.equal(s.proofRate, null);
  assert.equal(s.timeToDecisionMs.median, null);
  assert.equal(s.northStar.rate, null);
});

test('the roster refuses an unknown scenario, a duplicate key and a reasonless stop', () => {
  const bad = validateRoster({
    version: 1,
    entries: [
      { taskKey: 'A-1', title: 'ok', scenario: 'ui-feature', why: 'because' },
      { taskKey: 'A-1', title: 'dup', scenario: 'bug-fix', why: 'because' },
      { taskKey: 'A-2', title: 'no shape', scenario: 'chore', why: 'because' },
      { taskKey: 'A-3', title: 'stopped', scenario: 'bug-fix', why: 'because', stop: { at: t(0) } },
    ],
  });
  assert.equal(bad.ok, false);
  const codes = bad.errors.map((e) => e.code);
  assert.ok(codes.includes('duplicate'));
  assert.ok(codes.includes('unknown-scenario'));
  assert.ok(codes.includes('required'), 'a stop must say why');

  const missingWhy = validateRoster({ version: 1, entries: [{ taskKey: 'A-1', title: 'ok', scenario: 'bug-fix' }] });
  assert.equal(missingWhy.ok, true, 'a missing "why" is a warning, not a refusal');
  assert.equal(missingWhy.warnings[0].code, 'missing-why');
});

test('coverage names the shape that is short, not just the total', () => {
  const entries = [
    { taskKey: 'A-1', title: 'a', scenario: 'ui-feature', why: 'w' },
    { taskKey: 'A-2', title: 'b', scenario: 'bug-fix', why: 'w' },
  ];
  const cov = coverage(entries, [
    { taskKey: 'A-1', outcome: 'proved', publishedAt: t(0), firstDecisionAt: t(HOUR) },
    { taskKey: 'A-2', outcome: 'open', publishedAt: null, spoolId: null, firstDecisionAt: null },
  ]);

  assert.equal(cov.total, 2);
  const ui = cov.scenarios.find((r) => r.scenario === 'ui-feature');
  assert.deepEqual([ui.planned, ui.live, ui.decided, ui.closed], [1, 1, 1, 1]);
  assert.ok(cov.gaps.some((g) => /at least 15/.test(g)), 'a sample under 15 is a gap');
  assert.ok(cov.gaps.some((g) => /risky refactor/.test(g)), 'a shape with nothing planned is a gap');
});
