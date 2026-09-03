// The MCP tools, against a stub host (mcp/src/tools.mjs, mcp/src/server.mjs).
//
// Two kinds of assertion live here. The schema tests are a contract with whatever agent
// picks this server up: a tool whose input schema lies is worse than a missing tool,
// because the agent will call it and be refused for a reason it cannot see. The
// behaviour tests drive the handlers over a stub HTTP server, so the long-poll loop, the
// cursor round-trip and the blocked refusal are exercised for real without a platform.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerHash } from '../mcp/src/config.mjs';
import { readState } from '../mcp/src/cursor.mjs';
import { DEFAULT_AWAIT_SECONDS, MAX_AWAIT_SECONDS, toolTable } from '../mcp/src/tools.mjs';

/** Every tool the exit test and the wake story need, by name. */
const EXPECTED = [
  'plan_propose',
  'plan_read',
  'gate_check',
  'await_events',
  'ack_comment',
  'answer_question',
  // The agent's own half of the conversation: answer_question replies in a thread that
  // exists, send_message starts one that does not.
  'send_message',
  'plan_sources',
  'plan_record_start',
  'plan_render',
  'plan_publish',
  'plan_request_decision',
  'plan_revise',
  'implementation_start',
  'proof_submit',
  'status_report',
];

const byName = () => new Map(toolTable().map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

test('every declared tool is present, described, and has an input schema', () => {
  const tools = byName();
  assert.deepEqual([...tools.keys()].sort(), [...EXPECTED].sort());
  for (const tool of tools.values()) {
    assert.ok(tool.title, `${tool.name} needs a title`);
    assert.ok(tool.description.length > 60, `${tool.name} needs a description an agent can act on`);
    assert.equal(typeof tool.inputSchema, 'object');
    assert.equal(typeof tool.handler, 'function');
  }
});

test('the ids a tool needs are required, and everything else is optional', () => {
  const tools = byName();
  const required = {
    plan_read: ['spoolId'],
    gate_check: ['spoolId'],
    ack_comment: ['spoolId', 'questionId'],
    answer_question: ['spoolId', 'questionId', 'body'],
    proof_submit: ['spoolId', 'summary'],
    implementation_start: ['spoolId', 'policy'],
    plan_revise: ['spoolId', 'parentRevisionId'],
    plan_propose: ['plan'],
    status_report: ['parent', 'verdict'],
  };
  for (const [name, keys] of Object.entries(required)) {
    const shape = tools.get(name).inputSchema;
    for (const key of keys) assert.equal(shape[key].isOptional(), false, `${name}.${key} must be required`);
    for (const [key, schema] of Object.entries(shape)) {
      if (!keys.includes(key)) assert.equal(schema.isOptional(), true, `${name}.${key} should be optional`);
    }
  }
});

test('await_events states its own bounds rather than letting a caller discover them', () => {
  const shape = byName().get('await_events').inputSchema;
  assert.throws(() => shape.timeoutSeconds.parse(MAX_AWAIT_SECONDS + 1));
  assert.equal(shape.timeoutSeconds.parse(DEFAULT_AWAIT_SECONDS), DEFAULT_AWAIT_SECONDS);
  for (const from of ['cursor', 'now', 'beginning']) assert.equal(shape.from.parse(from), from);
  assert.throws(() => shape.from.parse('tail'), 'the three starts are the whole vocabulary');
});

test('a status report may only carry a verdict the contract has', () => {
  const shape = byName().get('status_report').inputSchema;
  assert.throws(() => shape.verdict.parse('done'), 'there is no `done` verdict; finished work is on_plan');
  for (const v of ['on_plan', 'changed', 'blocked']) assert.equal(shape.verdict.parse(v), v);
  for (const r of ['milestone', 'blocker', 'decision']) assert.equal(shape.reason.parse(r), r);
});

test('the server registers every tool over the real protocol', async () => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createServer: createMcp } = await import('../mcp/src/server.mjs');

  const { server } = await createMcp({ cfg: { host: 'https://example.test', token: 'spk_x', ownerHash: 'deadbeef' }, env: {} });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort());
  const read = tools.find((t) => t.name === 'plan_read');
  assert.deepEqual(read.inputSchema.required, ['spoolId']);
  assert.equal(read.inputSchema.properties.spoolId.type, 'string');
  await client.close();
});

// ---------------------------------------------------------------------------
// Behaviour, against a stub host
// ---------------------------------------------------------------------------

/** A host that answers exactly what a test tells it to, and records what it was asked. */
async function stubHost(routes) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://stub');
    let body = '';
    for await (const c of req) body += c;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body: body ? JSON.parse(body) : null, auth: req.headers.authorization });
    const key = `${req.method} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `no stub for ${key}` }));
      return;
    }
    const answer = typeof route === 'function' ? await route(calls.filter((c) => `${c.method} ${c.path}` === key).length - 1) : route;
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(answer.body));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { host: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

async function ctxFor(host, { token = 'spk_test_token' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-mcp-tools-'));
  return {
    ctx: { cfg: { host, token, ownerHash: ownerHash(host, token), version: 'test' }, env: { SPOOL_MCP_HOME: dir } },
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const run = (name, ctx, args) => byName().get(name).handler(ctx, args);

test('await_events re-issues the 25s poll until something lands, then persists the cursor', async () => {
  const event = { id: 'e1', type: 'plan_decision_submitted', planSpoolId: 'PLAN', at: '2026-08-20T11:00:00Z', cursor: 'c1' };
  const stub = await stubHost({
    'GET /api/events': (n) =>
      n < 2
        ? { body: { payloadVersion: 1, events: [], cursor: null, hasMore: false, waited: true } }
        : { body: { payloadVersion: 1, events: [event], cursor: 'c1', hasMore: false, waited: false } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('await_events', ctx, { timeoutSeconds: 30 });
    assert.equal(out.json.polls, 3, 'two empty waits, then the page that had the event');
    assert.deepEqual(out.json.events, [event]);
    assert.match(out.text, /1 event after/);
    assert.match(out.text, /plan_decision_submitted/);

    // The wait asked for is the platform's ceiling, never more.
    for (const call of stub.calls) assert.ok(Number(call.query.wait) <= 25, `asked for wait=${call.query.wait}`);
    assert.equal(stub.calls[0].auth, 'Bearer spk_test_token');

    // Staged, not committed: a crash here replays the page rather than losing it.
    const state = await readState(ctx.cfg, ctx.env);
    assert.equal(state.pending, 'c1');
    assert.equal(state.committed, null);
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('the next call commits the last page and resumes strictly after it', async () => {
  const stub = await stubHost({
    'GET /api/events': (n) =>
      n === 0
        ? { body: { events: [{ id: 'e1', type: 'plan_published', planSpoolId: 'P', at: 'x', cursor: 'c1' }], cursor: 'c1', hasMore: false } }
        : { body: { events: [], cursor: 'c1', hasMore: false } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    await run('await_events', ctx, { timeoutSeconds: 5 });
    await run('await_events', ctx, { timeoutSeconds: 0 });
    assert.equal(stub.calls[0].query.cursor, undefined, 'the first read has no cursor, so it replays from the beginning');
    assert.equal(stub.calls[1].query.cursor, 'c1', 'the second resumes strictly after the page it was handed');
    assert.equal((await readState(ctx.cfg, ctx.env)).committed, 'c1');
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('from "now" anchors at the head so a fresh follower is not handed the history', async () => {
  const stub = await stubHost({
    'GET /api/events': (n) => ({ body: n === 0 ? { events: [], cursor: 'head' } : { events: [], cursor: 'head' } }),
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('await_events', ctx, { timeoutSeconds: 0, from: 'now' });
    assert.equal(stub.calls[0].query.tail, '1');
    assert.equal(stub.calls[1].query.cursor, 'head');
    assert.equal(out.json.anchored, true);
    assert.match(out.text, /anchored at the head/);
    assert.equal((await readState(ctx.cfg, ctx.env)).anchored, true);
  } finally {
    await cleanup();
    await stub.close();
  }
});

const STEER = {
  id: 'q-9',
  body: 'Use the queue, not a cron.',
  askedBy: 'reviewer',
  at: '2026-08-20T11:00:00Z',
  anchor: { type: 'chapter', chapterId: 'approach', label: 'approach', start: null, end: null, target: null, missing: false },
  ackAt: '/api/plans/P/questions/q-9/ack',
};

test('a blocked refusal is rendered from the list the platform sent, and nothing else', async () => {
  const stub = await stubHost({
    'POST /api/plans/P/implementation/start': {
      status: 409,
      body: { error: '1 comment has not been acknowledged', reason: 'unacked_comments', status: 'approved', blockedBy: [STEER] },
    },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('implementation_start', ctx, { spoolId: 'P', policy: 'advisory' });
    assert.equal(out.isError, true);
    assert.equal(out.json.blocked, true);
    assert.equal(out.json.blockingCount, 1);
    assert.match(out.text, /^BLOCKED: 1 thread/);
    assert.match(out.text, /you may not start implementation/);
    assert.match(out.text, /Use the queue, not a cron\./);
    assert.match(out.text, /"questionId": "q-9"/);
    assert.equal(stub.calls.length, 1, 'the refusal is self-sufficient: no second request to understand it');
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('a blocked refusal that carries no blockedBy is reported as a platform bug, not repaired', async () => {
  // Reading the list back off the plan would work here, and it would also make the next
  // route that forgets the field look exactly like one that did not. So this fails loudly.
  const stub = await stubHost({
    'POST /api/plans/P/implementation/start': { status: 409, body: { error: '1 comment has not been acknowledged', reason: 'unacked_comments', status: 'approved' } },
    'GET /api/plans/P': { body: { spoolId: 'P', status: 'approved', revision: 1, blockedBy: [STEER] } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('implementation_start', ctx, { spoolId: 'P', policy: 'advisory' });
    assert.equal(out.isError, true);
    assert.match(out.text, /refused as blocked, but the platform did not say by what/);
    assert.match(out.text, /named `unacked_comments` and carried no `blockedBy`/);
    assert.match(out.text, /You are still blocked — do not proceed/, 'a broken refusal must never read as permission');
    assert.match(out.text, /it is a platform bug/);
    assert.equal(out.json.blocked, true);
    assert.equal(out.json.blockingCount, null, 'the count is unknown, and is not guessed at');
    assert.equal(out.json.contractViolation, 'blockedBy missing from a blocked refusal');

    assert.deepEqual(
      stub.calls.map((c) => c.path),
      ['/api/plans/P/implementation/start'],
      'the plan is NOT re-read: a silent repair would hide the next instance of this bug'
    );
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('a conflict that is NOT a block keeps the platform\'s own words', async () => {
  const stub = await stubHost({
    'POST /api/plans/P/implementation/proved': { status: 409, body: { error: 'this plan is draft', reason: 'wrong_state', current: { status: 'draft', revision: 1 } } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('proof_submit', ctx, { spoolId: 'P', summary: 'done' });
    assert.equal(out.isError, true);
    assert.match(out.text, /refused: 409 this plan is draft/);
    assert.match(out.text, /reason: wrong_state/);
    assert.match(out.text, /the plan is now draft at revision 1/);
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('a repeated lifecycle call reports that it changed nothing, and is not an error', async () => {
  const stub = await stubHost({
    'POST /api/plans/P/request-decision': { body: { ok: true, status: 'awaiting_decision', revision: 2, revisionId: 'r2', recorded: false } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('plan_request_decision', ctx, { spoolId: 'P' });
    assert.ok(!out.isError);
    assert.match(out.text, /nothing to do: the plan is already awaiting_decision/);
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('an ack that leaves work behind says what is still blocking', async () => {
  const left = { id: 'q-2', body: 'And bound the retries.', askedBy: 'owner', at: 'x', anchor: { type: 'chapter', label: 'risks' }, ackAt: '/a' };
  const stub = await stubHost({
    'POST /api/plans/P/questions/q-1/ack': { body: { ok: true, questionId: 'q-1', revisionId: 'r1', replayed: false, blockedBy: [left] } },
    'POST /api/plans/P/questions/q-2/ack': { body: { ok: true, questionId: 'q-2', revisionId: 'r1', replayed: true, blockedBy: [] } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const first = await run('ack_comment', ctx, { spoolId: 'P', questionId: 'q-1' });
    assert.equal(first.json.blocked, true);
    assert.match(first.text, /And bound the retries\./);

    const second = await run('ack_comment', ctx, { spoolId: 'P', questionId: 'q-2' });
    assert.equal(second.json.blocked, false);
    assert.match(second.text, /already acknowledged/);
    assert.match(second.text, /still OPEN/, 'an ack must never read as having handled the feedback');
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('without a token the write tools say which variable to set, rather than failing at the host', async () => {
  const stub = await stubHost({});
  const { ctx, cleanup } = await ctxFor(stub.host, { token: null });
  try {
    for (const name of ['plan_propose', 'ack_comment', 'await_events', 'proof_submit']) {
      const out = await run(name, ctx, { spoolId: 'P', questionId: 'q', summary: 's', plan: {} });
      assert.equal(out.isError, true, name);
      assert.match(out.text, /SPOOL_TOKEN/, name);
    }
    assert.equal(stub.calls.length, 0, 'nothing should have been sent');
  } finally {
    await cleanup();
    await stub.close();
  }
});

const PARENT_ID = 'nM5FGJ7V51PkMkrWiE9_Eg';

test('status_report scaffolds a workdir and is honest that nothing is published yet', async () => {
  const plan = {
    spoolId: PARENT_ID,
    revisionId: 'r1',
    revision: 1,
    status: 'implementing',
    goal: 'ship the cursor',
    approach: [{ id: 'stream', summary: 'Follow plan_events.', chapterId: 'approach' }],
    links: { watch: 'https://spoolkit.dev/l/' + PARENT_ID },
  };
  const stub = await stubHost({
    [`GET /api/plans/${PARENT_ID}`]: { body: plan },
    [`GET /api/plans/${PARENT_ID}/questions`]: { body: { questions: [] } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  const dir = await mkdtemp(join(tmpdir(), 'spool-mcp-status-'));
  try {
    const out = await run('status_report', ctx, { parent: PARENT_ID, verdict: 'on_plan', completed: ['stream'], next: 'Wire the wake daemon.', dir });
    assert.ok(!out.isError, out.text);
    assert.equal(out.json.published, false, 'a status is a recording; this only scaffolds it');
    assert.equal(out.json.reply.status.verdict, 'on_plan');
    assert.deepEqual(out.json.reply.status.completed, ['stream']);
    assert.equal(out.json.reply.parent.spoolId, PARENT_ID);
    assert.match(out.text, /spool live /);
    assert.match(out.text, /spool publish /);
    assert.ok(out.json.steps, 'the narration skeleton is written beside the descriptor');

    // The report is checked before anything is recorded, against the parent's own packet.
    const bad = await run('status_report', ctx, { parent: PARENT_ID, verdict: 'on_plan', planValid: false, dir });
    assert.equal(bad.isError, true, 'a plan that no longer holds cannot be reported as on plan');
    const unknown = await run('status_report', ctx, { parent: PARENT_ID, verdict: 'on_plan', completed: ['not-a-step'], dir, force: true });
    assert.equal(unknown.isError, true, 'a completed id must be an approach step OF THIS PLAN');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await cleanup();
    await stub.close();
  }
});

test('plan_render reports the job as queued and does not pretend it finished', async () => {
  const stub = await stubHost({
    'POST /api/plans/P/render': { status: 202, body: { spoolId: 'P', jobId: 'job-1', kind: 'render_packet', status: 'queued', warning: 'no plan.script.json', links: { job: 'http://x/api/edit-jobs/job-1' } } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('plan_render', ctx, { spoolId: 'P' });
    assert.match(out.text, /render job job-1 is queued/);
    assert.match(out.text, /it is NOT finished/);
    assert.match(out.text, /warning: no plan\.script\.json/);
    assert.equal(out.json.status, 'queued');
  } finally {
    await cleanup();
    await stub.close();
  }
});

// ---------------------------------------------------------------------------
// send_message — the agent's own half of the conversation (Phase 4b)
// ---------------------------------------------------------------------------

test('send_message opens a general thread, with no chapter and no timestamp to invent', async () => {
  // The steer surface used to be one-directional: a human could start a thread, an agent
  // could only reply to one. An agent with something to raise had to anchor it to a
  // chapter it was not really about.
  const stub = await stubHost({
    'POST /api/plans/P/questions': { status: 201, body: { ok: true, questionId: 'q-new', anchor: { type: 'general', label: 'the plan' }, at: '2026-08-21T09:00:00Z' } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('send_message', ctx, { spoolId: 'P', body: 'staging is down, I cannot verify this' });
    assert.equal(out.isError, undefined);
    assert.deepEqual(stub.calls[0].body.anchor, { type: 'general' });
    assert.equal(stub.calls[0].body.revisionId, undefined, 'a general steer needs no revision to be current with');
    assert.match(out.text, /Thread q-new is open/);
    assert.match(out.text, /Your own message does not block you/);
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('send_message with a questionId continues the thread instead of forking one', async () => {
  const stub = await stubHost({
    'POST /api/plans/P/questions/q-9/replies': { body: { ok: true, replyId: 'r-1', status: 'answered', answers: true } },
  });
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('send_message', ctx, { spoolId: 'P', questionId: 'q-9', body: 'switching to cron' });
    assert.equal(stub.calls[0].path, '/api/plans/P/questions/q-9/replies');
    assert.match(out.text, /in the existing thread/);
  } finally {
    await cleanup();
    await stub.close();
  }
});

test('send_message needs a token, like every other write', async () => {
  const stub = await stubHost({});
  const { ctx, cleanup } = await ctxFor(stub.host);
  try {
    const out = await run('send_message', { ...ctx, cfg: { ...ctx.cfg, token: '' } }, { spoolId: 'P', body: 'hello' });
    assert.equal(out.isError, true);
    assert.equal(stub.calls.length, 0);
  } finally {
    await cleanup();
    await stub.close();
  }
});
