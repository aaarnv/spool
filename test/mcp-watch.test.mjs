// The wake daemon (mcp/src/watch.mjs, mcp/src/sinks.mjs).
//
// MCP cannot wake an idle agent: a tool only runs when something is already running to
// call it. So the wake story is a daemon holding the same cursor, and the properties
// worth pinning are the two that decide whether a steer can be lost. The cursor moves
// only after every sink has accepted, and a first start follows from the head rather
// than firing a wake per row of history.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerHash } from '../mcp/src/config.mjs';
import { readState } from '../mcp/src/cursor.mjs';
import { commandSink, eventHeadline, logSink, notifySink } from '../mcp/src/sinks.mjs';
import { WAKE_TYPES, sinksFrom, watch } from '../mcp/src/watch.mjs';

const event = (type, id) => ({ id, type, planSpoolId: 'PLAN', revisionId: 'r1', actor: { kind: 'reviewer', id: null }, payload: {}, at: '2026-08-20T11:00:00.000Z', cursor: id });

async function stub(pages) {
  const calls = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://stub');
    calls.push(Object.fromEntries(url.searchParams));
    const page = pages[Math.min(calls.length - 1, pages.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { host: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

async function ctxFor(host) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-mcp-watch-'));
  const token = 'spk_watch';
  return {
    ctx: { cfg: { host, token, ownerHash: ownerHash(host, token), version: 'test' }, env: { SPOOL_MCP_HOME: dir } },
    dir,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

const collector = () => {
  const seen = [];
  return { seen, sink: { name: 'collect', describe: () => 'collect', deliver: async (e) => void seen.push(e) } };
};

test('a first start follows from the head, not from the beginning of the history', async () => {
  const s = await stub([{ events: [], cursor: 'head' }, { events: [], cursor: 'head' }]);
  const { ctx, cleanup } = await ctxFor(s.host);
  try {
    await watch(ctx, { once: true, sinks: [], write: () => {} });
    assert.equal(s.calls[0].tail, '1', 'anchor first — a wake per row of history is not a wake');
    assert.equal(s.calls[1].cursor, 'head');
    assert.equal((await readState(ctx.cfg, ctx.env)).anchored, true);
  } finally {
    await cleanup();
    await s.close();
  }
});

test('only the event types that need the agent wake it; the rest are logged and skipped', async () => {
  const wake = event('plan_question_created', 'c2');
  const s = await stub([
    { events: [], cursor: 'head' },
    { events: [event('plan_render_queued', 'c1'), wake], cursor: 'c2', hasMore: false },
  ]);
  const { ctx, cleanup } = await ctxFor(s.host);
  const { seen, sink } = collector();
  const lines = [];
  try {
    const out = await watch(ctx, { once: true, sinks: [sink], write: (l) => lines.push(l) });
    assert.deepEqual(seen.map((e) => e.type), ['plan_question_created']);
    assert.deepEqual(out.delivered.map((e) => e.id), ['c2']);
    assert.ok(lines.some((l) => l.includes('skipped plan_render_queued')), 'a skipped event is still reported');
    assert.deepEqual(WAKE_TYPES, ['plan_decision_submitted', 'plan_question_created', 'plan_question_replied', 'plan_reply_created']);
  } finally {
    await cleanup();
    await s.close();
  }
});

test('an unfiltered watch delivers every type, because the event vocabulary is open', async () => {
  const s = await stub([{ events: [], cursor: 'head' }, { events: [event('plan_something_new', 'c1')], cursor: 'c1' }]);
  const { ctx, cleanup } = await ctxFor(s.host);
  const { seen, sink } = collector();
  try {
    await watch(ctx, { once: true, all: true, sinks: [sink], write: () => {} });
    assert.deepEqual(seen.map((e) => e.type), ['plan_something_new']);
  } finally {
    await cleanup();
    await s.close();
  }
});

test('the cursor moves only after every sink accepted, so a failed wake is retried', async () => {
  const s = await stub([{ events: [], cursor: 'head' }, { events: [event('plan_decision_submitted', 'c1')], cursor: 'c1' }]);
  const { ctx, cleanup } = await ctxFor(s.host);
  const angry = { name: 'angry', describe: () => 'angry', deliver: async () => { throw new Error('the harness was not listening'); } };
  try {
    await assert.rejects(() => watch(ctx, { once: true, sinks: [angry], write: () => {} }), /not listening/);
    assert.equal((await readState(ctx.cfg, ctx.env)).committed, 'head', 'the event is still ahead of the cursor');
  } finally {
    await cleanup();
    await s.close();
  }
});

test('a delivered batch advances the cursor outright, so the next poll asks for what is after it', async () => {
  const s = await stub([{ events: [], cursor: 'head' }, { events: [event('plan_decision_submitted', 'c1')], cursor: 'c1' }]);
  const { ctx, cleanup } = await ctxFor(s.host);
  const { sink } = collector();
  try {
    const out = await watch(ctx, { once: true, sinks: [sink], write: () => {} });
    assert.equal(out.cursor, 'c1');
    const state = await readState(ctx.cfg, ctx.env);
    assert.equal(state.committed, 'c1');
    assert.equal(state.pending, 'c1');
  } finally {
    await cleanup();
    await s.close();
  }
});

test('the command sink hands the event over three ways, and a non-zero exit is a failed delivery', async () => {
  const out = await mkdtemp(join(tmpdir(), 'spool-mcp-sink-'));
  try {
    const file = join(out, 'woke.txt');
    const sink = commandSink(`{ cat; echo "env=$SPOOL_EVENT_TYPE/$SPOOL_PLAN_ID/$SPOOL_PLAN_URL"; } > ${file}`);
    await sink.deliver(event('plan_question_created', 'c1'), { host: 'https://spoolkit.dev' });
    const written = await readFile(file, 'utf8');
    assert.match(written, /"type":"plan_question_created"/, 'the whole event arrives on stdin');
    assert.match(written, /env=plan_question_created\/PLAN\/https:\/\/spoolkit\.dev\/l\/PLAN/);

    await assert.rejects(() => commandSink('exit 3').deliver(event('plan_question_created', 'c1'), {}), /exited 3/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});

test('the notification sink is a no-op off macOS rather than a crash', async () => {
  const sink = notifySink({ platform: 'linux' });
  assert.match(sink.describe(), /not macOS/);
  assert.equal((await sink.deliver(event('plan_question_created', 'c1'))).skipped, 'not macOS');
});

test('a wake says, in one line, what happened and whether it blocks', () => {
  assert.match(eventHeadline(event('plan_question_created', 'c1')), /commented — it blocks until you acknowledge it/);
  assert.match(eventHeadline({ type: 'plan_decision_submitted', actor: { kind: 'owner' }, payload: { type: 'approve' } }), /the owner decided: approve/);
  assert.equal(eventHeadline({ type: 'plan_something_new' }), 'plan_something_new', 'an unknown type is reported, not swallowed');
});

test('the log sink is always wired, so a watch is never silent about its own work', () => {
  const lines = [];
  const sinks = sinksFrom({}, { write: (l) => lines.push(l), env: {} });
  assert.deepEqual(sinks.map((s) => s.name), ['log']);
  assert.deepEqual(sinksFrom({ on: 'true', notify: true }, { write: () => {}, env: {} }).map((s) => s.name), ['log', 'command', 'notify']);
  assert.deepEqual(sinksFrom({}, { write: () => {}, env: { SPOOL_MCP_WAKE_CMD: 'true', SPOOL_MCP_NOTIFY: '1' } }).map((s) => s.name), ['log', 'command', 'notify']);
});

test('the log sink writes the plan, the type and what it means', async () => {
  const lines = [];
  await logSink((l) => lines.push(l)).deliver(event('plan_question_created', 'c1'));
  assert.match(lines[0], /plan_question_created plan=PLAN/);
});

test('a wake command that never reads stdin still counts as delivered', async () => {
  // The event is offered on stdin as a convenience, and most wake commands ignore it —
  // `echo`, `curl`, a shell one-liner. Such a command can exit before the write lands, and
  // an unhandled EPIPE would throw out of `deliver`; the watch loop reads a throwing sink
  // as a failed delivery and REPLAYS the batch, so one event would wake the agent forever.
  // The exit code is what says whether the command worked.
  const sink = commandSink('exit 0', { log: () => {} });
  for (let i = 0; i < 20; i++) {
    const result = await sink.deliver({ type: 'plan_question_created', planSpoolId: 'P', at: '2026-08-21T00:00:00Z' }, { host: 'https://spoolkit.dev' });
    assert.equal(result.delivered, true, `delivery ${i} was reported as failed`);
    assert.equal(result.exitCode, 0, `delivery ${i} read the wrong exit code`);
  }
});
