// Blocking comments, as the MCP server surfaces them (mcp/src/blocking.mjs).
//
// The platform enforces the rule; this layer's whole job is that a stock agent cannot
// MISS it. So the assertions are about position and prose, not about policy: the block
// is the first key of the object and the first line of the text, every steer is named
// with the exact call that clears it, and the "acknowledging is not answering" split is
// stated where the agent reads rather than only in the docs.
//
// The other half is what must NOT change: the payload rides through untouched, because
// it is additive-stable and agents downstream branch on its documented fields.

import test from 'node:test';
import assert from 'node:assert/strict';

import { blockedRefusal, blockedText, blockersOf, frameGate, frameRead, isBlockedRefusal } from '../mcp/src/blocking.mjs';

const steer = {
  id: 'q-1',
  body: 'Use the queue, not a cron.',
  askedBy: 'reviewer',
  at: '2026-08-20T11:00:00.000Z',
  anchor: { type: 'chapter', chapterId: 'approach', label: 'approach', start: null, end: null, target: null, missing: false },
  ackAt: '/api/plans/PLAN/questions/q-1/ack',
};

const blockedPayload = {
  payloadVersion: 1,
  spoolId: 'PLAN',
  status: 'approved',
  revision: 2,
  revisionId: 'rev-2',
  actor: 'agent',
  nextAction: { action: 'acknowledge_comments', endpoint: null, reason: 'A comment is waiting.' },
  may: ['plan.read', 'plan.acknowledge'],
  blockedBy: [steer],
  openQuestions: [],
  goal: 'ship it',
};

const clearPayload = {
  payloadVersion: 1,
  spoolId: 'PLAN',
  status: 'approved',
  revision: 2,
  revisionId: 'rev-2',
  actor: 'agent',
  nextAction: {
    action: 'start_implementation',
    endpoint: { id: 'startImplementation', method: 'POST', path: '/api/plans/:spoolId/implementation/start' },
    reason: 'The plan is approved.',
  },
  may: ['plan.read', 'plan.start_implementation'],
  blockedBy: [],
};

test('a read of a blocked plan leads with the block, in both the prose and the object', () => {
  const framed = frameRead(blockedPayload);
  assert.match(framed.text.split('\n')[0], /^BLOCKED: 1 thread/);
  assert.equal(Object.keys(framed.json)[0], 'blocked', 'a client that renders the head of the object still shows it');
  assert.equal(framed.json.blocked, true);
  assert.equal(framed.json.blockingCount, 1);
});

test('the block names each steer, who left it, where, and the exact call that clears it', () => {
  const text = blockedText('PLAN', [steer]);
  assert.match(text, /from the reviewer on chapter: approach: Use the queue, not a cron\./);
  assert.match(text, /ack_comment \{ "spoolId": "PLAN", "questionId": "q-1" \}/);
  assert.match(text, /answer_question \{ "spoolId": "PLAN", "questionId": "q-1", "body": "…" \}/);
});

test('acknowledging is not answering — the split is stated where the agent reads', () => {
  assert.match(blockedText('PLAN', [steer]), /Acknowledging is not answering/);
  assert.match(blockedText('PLAN', [steer]), /the question stays open until you reply/);
});

test('a clear plan leads with what to do next instead', () => {
  const framed = frameRead(clearPayload);
  assert.equal(framed.json.blocked, false);
  assert.doesNotMatch(framed.text, /BLOCKED/);
  assert.match(framed.text, /next: start_implementation/);
  assert.match(framed.text, /POST \/api\/plans\/:spoolId\/implementation\/start/);
});

test('the payload rides through untouched — it is additive-stable and agents branch on it', () => {
  const framed = frameRead(blockedPayload);
  for (const [key, value] of Object.entries(blockedPayload)) assert.deepEqual(framed.json[key], value, key);
});

test('the gate refuses to say PROCEED while a steer is unacknowledged', () => {
  const gate = frameGate(blockedPayload);
  assert.equal(gate.json.mayProceed, false);
  assert.equal(gate.json.blockingCount, 1);
  assert.match(gate.text.split('\n')[0], /^BLOCKED/);
});

test('the gate says WAIT rather than PROCEED when the next step is somebody else\'s', () => {
  const waiting = frameGate({ ...clearPayload, nextAction: { action: 'await_decision', endpoint: null, reason: 'A reviewer has it.' } });
  assert.equal(waiting.json.waiting, true);
  assert.equal(waiting.json.mayProceed, false);
  assert.match(waiting.text, /gate: WAIT/);
});

test('the gate says PROCEED with the capabilities behind it', () => {
  const gate = frameGate(clearPayload);
  assert.equal(gate.json.mayProceed, true);
  assert.match(gate.text, /gate: PROCEED/);
  assert.match(gate.text, /plan\.start_implementation/);
});

test('only a 409 that names unacked_comments is framed as a block', () => {
  const block = { status: 409, data: { reason: 'unacked_comments', blockedBy: [steer], error: '1 comment…' } };
  const other = { status: 409, data: { reason: 'wrong_state', error: 'the plan is proved' } };
  assert.equal(isBlockedRefusal(block), true);
  assert.equal(isBlockedRefusal(other), false);
  assert.equal(blockedRefusal('PLAN', other), null, 'an unrelated conflict must not be swallowed by this module');

  const framed = blockedRefusal('PLAN', block, { verb: 'start implementation' });
  assert.equal(Object.keys(framed.json)[0], 'blocked');
  assert.equal(framed.json.reason, 'unacked_comments');
  assert.equal(framed.json.refused, 'start implementation');
  assert.match(framed.text, /you may not start implementation/);
  assert.match(framed.text, /Use the queue, not a cron\./);
});

test('a payload with no blockedBy field at all reads as clear, not as broken', () => {
  assert.deepEqual(blockersOf({}), []);
  assert.deepEqual(blockersOf(null), []);
  assert.equal(frameRead({ spoolId: 'PLAN', status: 'draft' }).json.blocked, false);
});

// ---------------------------------------------------------------------------
// A steer is a conversation (Phase 4b)
// ---------------------------------------------------------------------------

/** owner steers, agent replies, owner corrects. The tail is what the agent must read. */
const thread = {
  ...steer,
  anchor: { type: 'general', chapterId: null, start: null, end: null, label: 'the plan', target: null, missing: false },
  unacked: [
    { id: 'q-1', body: 'Use the queue, not a cron.', author: 'owner', agent: null, at: '2026-08-20T11:00:00.000Z' },
    { id: 'r-2', body: 'Actually no — cron is fine, it is the batch size I meant.', author: 'owner', agent: null, at: '2026-08-20T11:20:00.000Z' },
  ],
  latest: { id: 'r-2', body: 'Actually no — cron is fine, it is the batch size I meant.', author: 'owner', agent: null, at: '2026-08-20T11:20:00.000Z' },
};

test('a steer thread prints its whole unacknowledged tail, not just the message that opened it', () => {
  // An agent shown only the first line of a thread whose last line reverses it will
  // confidently do the thing it was told to stop doing.
  const text = blockedText('PLAN', [thread], { verb: 'start implementation' });
  assert.match(text, /Use the queue, not a cron\./);
  assert.match(text, /then the owner added: Actually no/);
  assert.match(text, /2 unacknowledged messages in this thread; one ack covers all of them/);
  // And it still names the exact calls, once for the thread rather than once per message.
  assert.match(text, /ack_comment \{ "spoolId": "PLAN", "questionId": "q-1" \}/);
});

test('the block says an ack only reaches the newest message', () => {
  // The property the rule now has and did not before. Stated where the agent reads, not
  // only in CONTRACTS.md, for the same reason "acknowledging is not answering" is.
  assert.match(blockedText('PLAN', [thread]), /An ack covers a thread only up to its newest message/);
});

test('a general steer is not dressed up as an anchor', () => {
  // "from the owner on general: the plan:" is noise wearing the costume of context.
  const text = blockedText('PLAN', [thread]);
  assert.match(text, /^ {2}1\. from the owner: Use the queue/m);
  assert.doesNotMatch(text, /on general/);
});

// ---------------------------------------------------------------------------
// The decision the agent has to read back (Phase 4a)
// ---------------------------------------------------------------------------

test('a read says WHAT was decided, because the status no longer says it', () => {
  // Three verbs land on `approved` and two on `redirected`. "The plan is approved" cannot
  // tell an agent whether to build the headline approach or the alternative it was handed.
  const framed = frameRead({
    ...clearPayload,
    decision: {
      action: 'approve_alternative',
      type: 'select_alternative',
      optionId: 'alternative:queue',
      conditionIds: null,
      notes: null,
      at: '2026-08-21T09:00:00.000Z',
    },
  });
  assert.match(framed.text, /decision: approve_alternative — build alternative:queue, not the headline approach/);
});

test('an approval with conditions says the conditions are what is holding it', () => {
  const framed = frameGate({
    ...clearPayload,
    decision: {
      action: 'approve_with_conditions',
      type: 'approved_with_conditions',
      optionId: null,
      conditionIds: ['c-1', 'c-2'],
      notes: null,
      at: '2026-08-21T09:00:00.000Z',
    },
  });
  assert.match(framed.text, /2 condition\(s\) attached — they are steers, and they block you until acked/);
});

test('a plan with no decision says nothing about one', () => {
  // The line is omitted, not printed empty: a read of an undecided plan must not look
  // like a read of a decided one with a blank verdict.
  assert.doesNotMatch(frameRead(clearPayload).text, /decision:/);
});

// ---------------------------------------------------------------------------
// Which option won (Aarnav, 2026-08-21: options are tappable cards)
// ---------------------------------------------------------------------------

const OPTIONS = [
  { optionId: 'approve', action: 'approve', label: 'The proposed approach', summary: 'Walk the table in id order.', tradeoffs: ['holds a lock'], recommended: true, selectable: true, chosen: false },
  { optionId: 'alternative:queue', action: 'approve_alternative', label: 'Queue', summary: 'Drive it off a queue.', tradeoffs: ['one more moving part'], recommended: false, selectable: true, chosen: false },
];
const chose = (optionId) => OPTIONS.map((o) => ({ ...o, chosen: o.optionId === optionId }));

test('a read names the option that won, by label and by summary', () => {
  // `optionId` on its own is an opaque string. The agent has to know what it is BUILDING.
  const framed = frameRead({
    ...clearPayload,
    decision: { action: 'approve_alternative', type: 'select_alternative', optionId: 'alternative:queue', conditionIds: null, notes: null, at: '2026-08-21T09:00:00.000Z' },
    options: chose('alternative:queue'),
  });
  assert.match(framed.text, /build "Queue" \(alternative:queue\): Drive it off a queue\./);
});

test('a plain approve still names an option — the recommended one', () => {
  // The most common decision of all carries no optionId, and it does not mean "no option
  // won". An agent that had to infer that from the action is the inference this removes.
  const framed = frameRead({
    ...clearPayload,
    decision: { action: 'approve', type: 'approve', optionId: null, conditionIds: null, notes: null, at: '2026-08-21T09:00:00.000Z' },
    options: chose('approve'),
  });
  assert.match(framed.text, /build "The proposed approach" \(approve\)/);
});

test('the gate carries the options, so PROCEED says what to proceed with', () => {
  const framed = frameGate({ ...clearPayload, options: chose('alternative:queue') });
  assert.equal(framed.json.options.length, 2);
  assert.equal(framed.json.options.find((o) => o.chosen).optionId, 'alternative:queue');
});

test('a payload with no options degrades to the optionId, and then to nothing', () => {
  // The payload is additive-stable, so this layer must not assume a field it just gained.
  const older = frameRead({
    ...clearPayload,
    decision: { action: 'approve_alternative', type: 'select_alternative', optionId: 'alternative:queue', conditionIds: null, notes: null, at: '2026-08-21T09:00:00.000Z' },
  });
  assert.match(older.text, /build alternative:queue, not the headline approach/);
  assert.doesNotMatch(frameRead(clearPayload).text, /decision:/);
});
