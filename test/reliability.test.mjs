// The reliability baseline (roadmap R6.3): the retry policy, the local journal, the
// report, and the two chaos properties everything else rests on —
//
//   1. a retry never turns one write into two (the idempotency key is generated once);
//   2. monitoring never changes what a command does (a journal that cannot be written
//      costs a line, not a take).
//
// No network and no browser: the host is a stub, and the clock is injected.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { backoffMs, fetchWithRetry, retryAfterMs, retryableError, retryableStatus, withRetry } from '../src/reliability/retry.mjs';
import { appendJournal, journalPath, journalRecord, observe, readJournal, MAX_BYTES } from '../src/reliability/journal.mjs';
import { classify, operationHealth, RELIABILITY_OPERATIONS, RELIABILITY_OUTCOMES, RELIABILITY_TARGETS, FAILURE_REASONS, severityOf, worstVerdict } from '../src/reliability/signals.mjs';
import { exitCodeFor, formatReport, summarize } from '../src/reliability/report.mjs';
import { parseSince } from '../src/reliability/cmd.mjs';
import { sendPlanEvent } from '../src/gate/audit.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'spool.mjs');

const project = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-reliability-'));
  await mkdir(join(dir, '.git'), { recursive: true });
  return dir;
};

// A sleep that records what it was asked to wait rather than waiting: every retry
// test below runs in microseconds and still asserts the real schedule.
const fakeSleep = () => {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
};

// ---------------------------------------------------------------------------
// The retry policy
// ---------------------------------------------------------------------------

test('backoff grows, stays under the cap, and jitters', () => {
  assert.equal(backoffMs(1, { baseMs: 100, draw: 1 }), 100);
  assert.equal(backoffMs(2, { baseMs: 100, draw: 1 }), 200);
  assert.equal(backoffMs(3, { baseMs: 100, draw: 1 }), 400);
  // Full jitter: the same attempt can wait half as long, so retriers de-synchronise.
  assert.equal(backoffMs(3, { baseMs: 100, draw: 0 }), 200);
  assert.ok(backoffMs(20, { baseMs: 100, draw: 1 }) <= 4000, 'the cap holds however many attempts have failed');
});

test('only a failure a retry could fix is retryable', () => {
  assert.ok(retryableStatus(500) && retryableStatus(503) && retryableStatus(429) && retryableStatus(408));
  assert.ok(!retryableStatus(400) && !retryableStatus(401) && !retryableStatus(403) && !retryableStatus(404) && !retryableStatus(409));
  assert.ok(retryableError(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })));
  assert.ok(retryableError(Object.assign(new Error('timed out'), { name: 'TimeoutError' })));
  assert.ok(!retryableError(new RangeError('bad argument')));
});

test('Retry-After is honoured as seconds or as a date, and capped', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('120'), 4000, 'a long Retry-After is capped, not obeyed');
  assert.equal(retryAfterMs(null), null);
  assert.equal(retryAfterMs('not-a-delay'), null);
});

test('withRetry survives a blip and reports how many attempts it cost', async () => {
  const { waits, sleep } = fakeSleep();
  let calls = 0;
  const { value, attempts, retried } = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
      return 'ok';
    },
    { attempts: 3, baseMs: 10, sleep, random: () => 1 }
  );
  assert.equal(value, 'ok');
  assert.equal(attempts, 3);
  assert.equal(retried, true, 'a survived blip is not a plain success');
  assert.deepEqual(waits, [10, 20]);
});

test('withRetry gives up after the bound and never retries a non-retryable error', async () => {
  const { sleep } = fakeSleep();
  let calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw Object.assign(new Error('down'), { code: 'ECONNRESET' });
      },
      { attempts: 3, baseMs: 1, sleep }
    ),
    (e) => e.attempts === 3
  );
  assert.equal(calls, 3, 'bounded: three attempts, not "eventually"');

  calls = 0;
  await assert.rejects(
    withRetry(
      async () => {
        calls += 1;
        throw new RangeError('a bug is not a blip');
      },
      { attempts: 3, baseMs: 1, sleep }
    ),
    RangeError
  );
  assert.equal(calls, 1);
});

test('fetchWithRetry retries a 500, obeys Retry-After on a 429, and accepts a 400 as an answer', async () => {
  const stub = (statuses) => {
    const seen = [];
    const fetchImpl = async () => {
      const status = statuses[seen.length] ?? statuses[statuses.length - 1];
      seen.push(status);
      return {
        ok: status < 400,
        status,
        headers: { get: (h) => (h === 'retry-after' && status === 429 ? '1' : null) },
      };
    };
    return { seen, fetchImpl };
  };

  const original = globalThis.fetch;
  try {
    let { seen, fetchImpl } = stub([500, 500, 200]);
    globalThis.fetch = fetchImpl;
    let { sleep, waits } = fakeSleep();
    let res = await fetchWithRetry('http://host/x', {}, { attempts: 3, baseMs: 5, sleep, random: () => 1 });
    assert.equal(res.value.status, 200);
    assert.equal(res.attempts, 3);
    assert.deepEqual(seen, [500, 500, 200]);

    ({ seen, fetchImpl } = stub([429, 200]));
    globalThis.fetch = fetchImpl;
    ({ sleep, waits } = fakeSleep());
    res = await fetchWithRetry('http://host/x', {}, { attempts: 3, baseMs: 5, sleep });
    assert.deepEqual(waits, [1000], 'the server said one second, so we wait one second');

    ({ seen, fetchImpl } = stub([400]));
    globalThis.fetch = fetchImpl;
    ({ sleep } = fakeSleep());
    res = await fetchWithRetry('http://host/x', {}, { attempts: 3, baseMs: 5, sleep });
    assert.equal(res.attempts, 1, 'a 400 is a decision, not a hiccup');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// Idempotency under retry — the property that makes retrying safe at all
// ---------------------------------------------------------------------------

test('a retried implementation event carries ONE idempotency key, so it records one start', async () => {
  const bodies = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return bodies.length === 1
      ? { ok: false, status: 503, statusText: 'busy', headers: { get: () => null }, text: async () => '' }
      : { ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, text: async () => '' };
  };
  try {
    const record = {
      plan: { spoolId: 'abcdefghijklmnopqrstuv', revisionId: 'rev-1', watch: 'http://host/l/abcdefghijklmnopqrstuv' },
      policy: 'required',
      bypassed: false,
      reasons: [],
      highRisk: false,
      reason: null,
    };
    const out = await sendPlanEvent(record, { host: 'http://host', token: 'spk_test' });
    assert.equal(out.sent, true);
    assert.equal(out.attempts, 2);
    assert.equal(bodies.length, 2);
    assert.equal(bodies[0].idempotencyKey, bodies[1].idempotencyKey, 'a regenerated key would write the event twice');
  } finally {
    globalThis.fetch = original;
  }
});

// ---------------------------------------------------------------------------
// The journal — measurement that cannot change the measurement
// ---------------------------------------------------------------------------

test('observe records the outcome and passes the value and the error straight through', async () => {
  const dir = await project();
  const value = await observe('render', async () => 'final.mp4', { root: dir, target: join(dir, 'spool', 'demo') });
  assert.equal(value, 'final.mp4');

  await assert.rejects(
    observe('record', async () => {
      throw new Error('browserType.launch: Executable does not exist');
    }, { root: dir, target: 'demo' }),
    /Executable does not exist/
  );

  const rows = await readJournal(dir);
  assert.deepEqual(rows.map((r) => [r.operation, r.outcome]), [['render', 'ok'], ['record', 'failed']]);
  assert.equal(rows[0].target, 'demo', 'the workdir slug is recorded, never its path');
  assert.ok(FAILURE_REASONS.record.includes(rows[1].reason), 'a failure is classified into the closed vocabulary');
  assert.ok(rows[1].ms >= 0);
});

test('observe reports a survived retry as `retried`', async () => {
  const dir = await project();
  await observe('publish', async (ctx) => {
    ctx.attempts = 2;
    return 'https://host/l/x';
  }, { root: dir });
  const [row] = await readJournal(dir);
  assert.equal(row.outcome, 'retried');
  assert.equal(row.attempts, 2);
});

test('a journal that cannot be written costs a line, not the command', async () => {
  const dir = await project();
  const blocked = join(dir, 'read-only');
  await mkdir(blocked);
  await chmod(blocked, 0o500);
  try {
    // The append must resolve to null rather than throw...
    assert.equal(await appendJournal(blocked, journalRecord({ at: new Date().toISOString(), operation: 'record', outcome: 'ok' })), null);
    // ...and an operation wrapped in it must still return its value.
    assert.equal(await observe('render', async () => 'still rendered', { root: blocked }), 'still rendered');
  } finally {
    await chmod(blocked, 0o700);
  }
});

test('SPOOL_RELIABILITY=off writes nothing at all', async () => {
  const dir = await project();
  process.env.SPOOL_RELIABILITY = 'off';
  try {
    await observe('render', async () => 'ok', { root: dir });
    assert.equal(existsSync(journalPath(dir)), false);
  } finally {
    delete process.env.SPOOL_RELIABILITY;
  }
});

test('the journal skips a torn line, filters by --since, and rotates when it is big', async () => {
  const dir = await project();
  const path = journalPath(dir);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      JSON.stringify({ at: '2020-01-01T00:00:00.000Z', operation: 'render', outcome: 'ok' }),
      '{"operation":"render", TORN',
      JSON.stringify({ at: '2026-01-01T00:00:00.000Z', operation: 'render', outcome: 'failed', reason: 'render_failed' }),
      JSON.stringify({ at: '2026-01-01T00:00:00.000Z', operation: 'not_an_operation', outcome: 'ok' }),
    ].join('\n') + '\n'
  );
  assert.equal((await readJournal(dir)).length, 2, 'a torn line and an unknown operation are skipped, not fatal');
  assert.equal((await readJournal(dir, { since: '2025-01-01T00:00:00.000Z' })).length, 1);

  await writeFile(path, 'x'.repeat(MAX_BYTES + 1));
  await appendJournal(dir, journalRecord({ at: new Date().toISOString(), operation: 'render', outcome: 'ok' }));
  assert.ok(existsSync(`${path}.1`), 'the journal rotates rather than growing forever');
  assert.equal((await readJournal(dir)).length, 1);
});

test('classify never puts an error message in the reason', () => {
  const message = 'ENOENT: no such file or directory, open /Users/someone/secret/plan.json';
  const reason = classify('render', new Error(message));
  assert.ok(FAILURE_REASONS.render.includes(reason));
  assert.ok(!reason.includes('/Users'));
  assert.equal(classify('publish', Object.assign(new Error('nope'), { status: 402 })), 'quota');
  assert.equal(classify('publish', Object.assign(new Error('nope'), { status: 503 })), 'http_5xx');
  assert.equal(classify('agent_read', Object.assign(new Error('aborted'), { name: 'TimeoutError' })), 'timeout');
});

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

test('health reads the targets, and a retry counts as a success', () => {
  const publish = RELIABILITY_TARGETS.publish;
  assert.equal(operationHealth('publish', { ok: 2 }).verdict, 'unknown', 'too few attempts to judge');
  assert.equal(operationHealth('publish', { ok: 99, retried: 1 }).verdict, 'met');
  assert.equal(operationHealth('publish', { ok: 98, failed: 2 }).verdict, 'at_risk');
  assert.equal(operationHealth('publish', { ok: 90, failed: 10 }).verdict, 'breached');
  assert.equal(operationHealth('publish', { ok: 99, retried: 1 }).rate, 1);
  assert.ok(publish.objective > 0 && publish.objective <= 1);
  assert.equal(worstVerdict([{ verdict: 'met' }, { verdict: 'unknown' }, { verdict: 'breached' }]), 'breached');
  assert.equal(worstVerdict([{ verdict: 'met' }, { verdict: 'unknown' }]), 'unknown');
});

test('severity is a property of the contract, not of the call site', () => {
  assert.equal(severityOf('authorization', 'unauthenticated'), 'info', 'a refused anonymous request is the product working');
  assert.equal(severityOf('authorization', 'unknown_endpoint'), 'page');
  assert.equal(severityOf('decision', 'key_reused'), 'page');
  assert.equal(severityOf('publish', 'network'), 'page');
  assert.equal(severityOf('record', 'timeout'), 'ticket');
});

test('the report names every operation, the failure reasons, and the runbook that recovers it', () => {
  const rows = [
    ...Array.from({ length: 9 }, () => ({ operation: 'publish', outcome: 'ok', ms: 100 })),
    { operation: 'publish', outcome: 'failed', reason: 'network', ms: 900, at: '2026-08-01T00:00:00.000Z', detail: 'fetch failed' },
  ];
  const report = summarize(rows);
  assert.equal(report.operations.length, RELIABILITY_OPERATIONS.length, 'an unmeasured operation is a finding, not a blank');
  const publish = report.operations.find((o) => o.operation === 'publish');
  assert.equal(publish.attempts, 10);
  assert.equal(publish.verdict, 'breached');
  assert.deepEqual(publish.reasons, [{ reason: 'network', count: 1 }]);
  assert.equal(publish.p95Ms, 900);
  assert.equal(report.verdict, 'breached');
  assert.equal(exitCodeFor(report), 1);
  assert.equal(exitCodeFor(summarize([])), 2);

  const text = formatReport(report, { path: '/tmp/.spool/reliability.jsonl' });
  assert.match(text, /RB-publish/);
  assert.match(text, /fetch failed/);
  assert.match(text, /BREACHED/);
});

test('--since accepts a window or a date', () => {
  const now = Date.parse('2026-08-17T00:00:00.000Z');
  assert.equal(parseSince('24h', now), '2026-08-16T00:00:00.000Z');
  assert.equal(parseSince('7d', now), '2026-08-10T00:00:00.000Z');
  assert.equal(parseSince('2w', now), '2026-08-03T00:00:00.000Z');
  assert.equal(parseSince('2026-08-01', now), '2026-08-01T00:00:00.000Z');
  assert.equal(parseSince(null, now), null);
  assert.equal(parseSince('nonsense', now), null);
});

// ---------------------------------------------------------------------------
// The command, and the contract twin
// ---------------------------------------------------------------------------

test('`spool reliability` reports the journal and exits on the verdict', async () => {
  const dir = await project();
  const run = async (args) => {
    try {
      const { stdout } = await exec(process.execPath, [cli, ...args], { cwd: dir, env: { ...process.env, HOME: dir } });
      return { code: 0, stdout };
    } catch (e) {
      return { code: e.code ?? 1, stdout: e.stdout ?? '' };
    }
  };

  let out = await run(['reliability']);
  assert.equal(out.code, 2, 'nothing measured yet is not a pass');

  const path = journalPath(dir);
  await mkdir(dirname(path), { recursive: true });
  const lines = [
    ...Array.from({ length: 9 }, () => ({ at: '2026-08-16T00:00:00.000Z', operation: 'render', outcome: 'ok', ms: 10 })),
    { at: '2026-08-16T00:00:01.000Z', operation: 'render', outcome: 'failed', reason: 'render_failed', ms: 10 },
  ];
  await writeFile(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

  out = await run(['reliability']);
  assert.equal(out.code, 1);
  assert.match(out.stdout, /render/);
  assert.match(out.stdout, /RB-render/);

  out = await run(['reliability', '--json']);
  const json = JSON.parse(out.stdout);
  assert.equal(json.verdict, 'breached');
  assert.deepEqual(json.breached, ['render']);
});

test('the CLI vocabulary and the server contract are the same contract', async (t) => {
  // The server twin lives in web/, which the OSS mirror strips from the public tree.
  const twin = join(here, '..', 'web', 'lib', 'planReliability.ts');
  if (!existsSync(twin)) return t.skip('web/ is not in this tree');
  const server = await readFile(twin, 'utf8');
  for (const op of RELIABILITY_OPERATIONS) assert.match(server, new RegExp(`"${op}"`), `web/lib/planReliability.ts is missing ${op}`);
  for (const outcome of RELIABILITY_OUTCOMES) assert.match(server, new RegExp(`"${outcome}"`));
  for (const [op, reasons] of Object.entries(FAILURE_REASONS)) {
    for (const reason of reasons) assert.match(server, new RegExp(`"${reason}"`), `${op}/${reason} is missing on the server`);
  }
  for (const target of Object.values(RELIABILITY_TARGETS)) {
    assert.match(server, new RegExp(`runbook: "${target.runbook}"`), `${target.operation}'s runbook differs on the server`);
  }
  // The exact objectives are compared value-by-value in web/lib/planReliability.test.ts,
  // which can import both halves; here we only prove nothing was left out.
});

// ---------------------------------------------------------------------------
// The agent read, against a host that answers badly rather than not at all
// ---------------------------------------------------------------------------

test('a host that answers 500 on every attempt is journalled as http_5xx, not as a network failure', async () => {
  const { readPlan } = await import('../src/plan/read.mjs');
  const dir = await mkdtemp(join(tmpdir(), 'spool-read-5xx-'));
  const server = createServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end('{"error":"internal"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const id = 'zzzzzzzzzzzzzzzzzzzz';
  try {
    await writeFile(
      join(dir, 'plan.json'),
      JSON.stringify({ version: 1, kind: 'plan', goal: 'g', outcome: 'o', approach: [], links: {} })
    );
    await mkdir(join(dir, 'share'), { recursive: true });
    await writeFile(join(dir, 'share', 'published.json'), JSON.stringify({ id, url: `${origin}/l/${id}` }));

    const payload = await readPlan(dir, {});
    // The agent still gets the plan, and still must not treat it as approved...
    assert.equal(payload.status, 'unknown');
    // ...but it is told what actually happened, with the status in it.
    assert.match(payload.error, /500/);

    const [row] = await readJournal(dir);
    assert.equal(row.operation, 'agent_read');
    assert.equal(row.outcome, 'failed');
    assert.equal(row.reason, 'http_5xx', 'an exhausted retry carries its last response; the reason must come from it');
    assert.equal(row.attempts, 3);
    assert.equal(row.severity, 'page', 'a failing host wakes somebody');
  } finally {
    server.close();
  }
});

test('a read the host answered clearly does not page', () => {
  // F3: without these overrides every agent_read failure inherits `page`, so a 404
  // for a plan on the wrong host would wake somebody at 3am.
  assert.equal(severityOf('agent_read', 'not_found'), 'ticket');
  assert.equal(severityOf('agent_read', 'http_4xx'), 'ticket');
  assert.equal(severityOf('agent_read', 'unreadable'), 'ticket');
  assert.equal(severityOf('agent_read', 'network'), 'page');
  assert.equal(severityOf('agent_read', 'timeout'), 'page');
  assert.equal(severityOf('agent_read', 'http_5xx'), 'page');
});
