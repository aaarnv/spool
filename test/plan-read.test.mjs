// `spool read --plan` — the agent handoff (roadmap R4.1).
//
// The acceptance criterion is that ONE call tells a fresh agent the plan's status and
// the next action it is allowed to take. These tests pin the payload shape an agent
// branches on (CONTRACTS.md "Agent read payload"), the hosted read's auth, and the
// offline read, because all three are contracts rather than conveniences.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// A read journals its outcome (roadmap R6.3), and a read against a stub host is not a
// fact about this machine: without this, running the suite would move a developer's own
// `spool reliability` numbers.
process.env.SPOOL_RELIABILITY = 'off';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'bin', 'spool.mjs');

const PACKET = {
  version: 1,
  kind: 'plan',
  goal: 'Add an agent read command.',
  outcome: 'A second agent resumes from the decision without watching the video.',
  approach: [
    { id: 'payload', summary: 'Return the canonical payload.', chapterId: 'approach' },
    { id: 'cli', summary: 'Print a digest by default.', chapterId: 'approach' },
  ],
  alternatives: [{ id: 'events-only', summary: 'Read the event log instead.', tradeoffs: ['Cheaper', 'No plan content'] }],
  assumptions: ['The reading agent holds the publish token.'],
  risks: ['An agent could treat an undecided plan as approved.'],
  decision: { type: 'approval', prompt: 'Approve the read payload?', options: ['approve', 'redirect'] },
  links: { task: 'SPL-26', branch: 'spl/spl-26' },
};

const EVIDENCE = {
  version: 1,
  kind: 'evidence',
  items: [{ id: 'ev-policy', kind: 'file', label: 'the permission matrix', ref: 'web/lib/planPolicy.ts', status: 'available' }],
};

/**
 * A plan workdir. `published` writes the publish receipt, which is what turns a local
 * read into a hosted one; `bundle` writes the share/ side an agent receives on its own.
 */
async function workdir(t, { published = null, bundle = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-planread-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'plan.json'), JSON.stringify(PACKET, null, 2));
  if (bundle) {
    const share = join(dir, 'share');
    await mkdir(share, { recursive: true });
    await writeFile(join(share, 'plan.json'), JSON.stringify(PACKET, null, 2));
    await writeFile(join(share, 'evidence.json'), JSON.stringify(EVIDENCE, null, 2));
    await writeFile(join(share, 'transcript.txt'), '[00:00] Here is what exists today.\n[00:08] Here is the approach.\n');
    if (published) await writeFile(join(share, 'published.json'), JSON.stringify(published, null, 2));
  }
  return dir;
}

async function run(args, env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { cwd: repo, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const readJson = async (args, env) => {
  const res = await run(args, env);
  assert.equal(res.code, 0, res.stderr);
  return JSON.parse(res.stdout);
};

/**
 * A stand-in host. Records every request so the test can assert what the CLI sent.
 * Closed through `t.after`, so a failed assertion cannot leave the runner listening.
 */
async function host(t, handler) {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push({ url: req.url, auth: req.headers.authorization ?? null });
    handler(req, res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const close = async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => server.close(r));
  };
  t.after(close);
  return { origin: `http://127.0.0.1:${server.address().port}`, requests, close };
}

const json = (res, body, status = 200) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

// The payload an agent branches on. Additive-stable: fields may be added, so this
// asserts every contract field is PRESENT rather than that no others are.
const PAYLOAD_KEYS = [
  'payloadVersion',
  'spoolId',
  'kind',
  'revision',
  'revisionId',
  'status',
  'decision',
  'actor',
  'nextAction',
  'may',
  'goal',
  'outcome',
  'approach',
  'risks',
  'assumptions',
  'alternatives',
  'evidence',
  'openQuestions',
  'links',
];

const assertPayloadShape = (payload) => {
  for (const key of PAYLOAD_KEYS) assert.ok(key in payload, `payload is missing ${key}`);
  assert.equal(payload.kind, 'plan');
  assert.equal(payload.payloadVersion, 1);
  assert.ok(typeof payload.nextAction.action === 'string' && payload.nextAction.action.length > 0);
  assert.ok(typeof payload.nextAction.reason === 'string' && payload.nextAction.reason.length > 0);
  assert.ok('endpoint' in payload.nextAction);
  assert.ok('watch' in payload.links && 'transcript' in payload.links && 'proof' in payload.links);
};

// --- the offline read -------------------------------------------------------

test('an unpublished packet reads as a draft that refuses implementation', async (t) => {
  const dir = await workdir(t, { bundle: false });
  const payload = await readJson(['read', dir, '--plan', '--json']);

  assertPayloadShape(payload);
  assert.equal(payload.status, 'draft');
  assert.equal(payload.revision, null);
  assert.equal(payload.spoolId, null);
  // The one mistake this command must never enable.
  assert.notEqual(payload.nextAction.action, 'start_implementation');
  assert.equal(payload.nextAction.action, 'publish_plan');
  assert.equal(payload.goal, PACKET.goal);
  assert.equal(payload.approach.length, 2);
});

test('an offline bundle reads on its own, from the share/ directory', async (t) => {
  const dir = await workdir(t, { published: { id: 'aaaaaaaaaaaaaaaaaaaa', url: 'https://example.invalid/l/aaaaaaaaaaaaaaaaaaaa' } });
  // The share/ dir is what an agent gets when a plan travels without its workdir.
  const payload = await readJson(['read', join(dir, 'share'), '--plan', '--json', '--offline']);

  assertPayloadShape(payload);
  assert.equal(payload.spoolId, 'aaaaaaaaaaaaaaaaaaaa');
  // Offline never guesses a status, and never lets the plan read as approved.
  assert.equal(payload.status, 'unknown');
  assert.equal(payload.nextAction.action, 'none');
  assert.match(payload.error, /offline/);
  // The resolved descriptors beside the packet, not the packet's own copy.
  assert.equal(payload.evidence.length, 1);
  assert.equal(payload.evidence[0].id, 'ev-policy');
  assert.match(payload.links.transcript, /share\/transcript\.txt$/);
});

test('--offline contacts no host, even when the packet was published', async (t) => {
  const served = await host(t, (_req, res) => json(res, { status: 'approved' }));
  const dir = await workdir(t, { published: { id: 'bbbbbbbbbbbbbbbbbbbb', url: `${served.origin}/l/bbbbbbbbbbbbbbbbbbbb` } });

  const payload = await readJson(['read', dir, '--plan', '--json', '--offline']);
  assert.equal(served.requests.length, 0);
  assert.equal(payload.status, 'unknown');
});

// --- the hosted read --------------------------------------------------------

test('a hosted read sends the agent token and returns the host payload', async (t) => {
  const hosted = {
    payloadVersion: 1,
    spoolId: 'cccccccccccccccccccc',
    kind: 'plan',
    revision: 2,
    revisionId: 'rev-2',
    status: 'approved',
    decision: { action: 'approve', type: 'approved_with_notes', optionId: null, notes: 'Keep the packet small.', at: '2026-08-14T00:00:00.000Z' },
    actor: 'agent',
    nextAction: {
      action: 'start_implementation',
      endpoint: { id: 'startImplementation', method: 'POST', path: '/api/plans/:spoolId/implementation/start' },
      reason: 'The plan is approved: start implementation against the approved approach.',
    },
    may: ['plan.read', 'plan.start_implementation'],
    goal: PACKET.goal,
    outcome: PACKET.outcome,
    approach: PACKET.approach,
    risks: [],
    assumptions: [],
    alternatives: [],
    evidence: [],
    openQuestions: [],
    links: { task: 'SPL-26', watch: 'https://spoolkit.dev/l/cccccccccccccccccccc', transcript: null, proof: null },
  };
  const served = await host(t, (_req, res) => json(res, hosted));
  const dir = await workdir(t, { published: { id: 'cccccccccccccccccccc', url: `${served.origin}/l/cccccccccccccccccccc` } });

  const payload = await readJson(['read', dir, '--plan', '--json'], { SPOOL_PUBLISH_TOKEN: 'spk_test', SPOOL_HOST: served.origin });

  assertPayloadShape(payload);
  assert.equal(served.requests.length, 1);
  assert.equal(served.requests[0].url, '/api/plans/cccccccccccccccccccc');
  // Without the token the host answers as it would to a link holder: no open questions,
  // so an agent would silently miss the work blocking its own plan.
  assert.equal(served.requests[0].auth, 'Bearer spk_test');
  assert.equal(payload.status, 'approved');
  assert.equal(payload.nextAction.action, 'start_implementation');
});

test('a link to another host does not collect the token', async (t) => {
  const served = await host(t, (_req, res) => json(res, { payloadVersion: 1, kind: 'plan', status: 'awaiting_decision', goal: 'g', outcome: 'o', links: {} }));
  const env = { SPOOL_PUBLISH_TOKEN: 'spk_secret', SPOOL_HOST: 'https://spoolkit.dev' };

  // A pasted watch URL names its own origin. An agent reads links it was handed, so the
  // credential must not travel to whichever host the link points at.
  await readJson(['read', `${served.origin}/l/gggggggggggggggggggg`, '--plan', '--json'], env);
  assert.equal(served.requests[0].auth, null);

  // Naming the host on purpose is the caller's decision, and does send it.
  await readJson(['read', `${served.origin}/l/gggggggggggggggggggg`, '--plan', '--json', '--token', 'spk_explicit'], env);
  assert.equal(served.requests[1].auth, 'Bearer spk_explicit');
});

test('a watch URL reads without a workdir', async (t) => {
  const served = await host(t, (_req, res) =>
    json(res, { payloadVersion: 1, spoolId: 'dddddddddddddddddddd', kind: 'plan', status: 'awaiting_decision', nextAction: { action: 'await_decision', endpoint: null, reason: 'Wait.' }, goal: 'g', outcome: 'o', links: {} })
  );
  const payload = await readJson(['read', `${served.origin}/l/dddddddddddddddddddd`, '--plan', '--json']);
  assert.equal(payload.status, 'awaiting_decision');
  assert.equal(served.requests[0].url, '/api/plans/dddddddddddddddddddd');
});

test('an unreachable host leaves the status unknown instead of guessing', async (t) => {
  const served = await host(t, (_req, res) => json(res, {}));
  const origin = served.origin;
  await served.close(); // nothing is listening now

  const dir = await workdir(t, { published: { id: 'eeeeeeeeeeeeeeeeeeee', url: `${origin}/l/eeeeeeeeeeeeeeeeeeee` } });
  const payload = await readJson(['read', dir, '--plan', '--json']);

  assert.equal(payload.status, 'unknown');
  assert.equal(payload.nextAction.action, 'none');
  assert.match(payload.nextAction.reason, /must not be treated as approved/);
  // The plan itself still reads: an offline agent learns the proposal, not its status.
  assert.equal(payload.goal, PACKET.goal);
  assert.match(payload.error, /unreachable/);
});

test('a spool that is not a plan on this host is reported, not invented', async (t) => {
  const served = await host(t, (_req, res) => json(res, { error: 'not found' }, 404));
  const dir = await workdir(t, { published: { id: 'ffffffffffffffffffff', url: `${served.origin}/l/ffffffffffffffffffff` } });
  const payload = await readJson(['read', dir, '--plan', '--json']);
  assert.equal(payload.status, 'unknown');
  assert.match(payload.error, /not a plan spool/);
});

// --- narration verbosity ----------------------------------------------------

test('narration is a reference by default and text only when asked for', async (t) => {
  const dir = await workdir(t);
  const digest = await run(['read', dir, '--plan']);
  assert.equal(digest.code, 0, digest.stderr);
  assert.doesNotMatch(digest.stdout, /Here is what exists today/);
  assert.match(digest.stdout, /transcript: .*share\/transcript\.txt/);

  const full = await run(['read', dir, '--plan', '--transcript']);
  assert.match(full.stdout, /Here is what exists today/);

  const payload = await readJson(['read', dir, '--plan', '--json']);
  assert.ok(!('transcript' in payload), 'the default payload carries no narration');
  const withText = await readJson(['read', dir, '--plan', '--json', '--transcript']);
  assert.match(withText.transcript, /Here is the approach/);
});

// --- the digest -------------------------------------------------------------

test('the digest leads with the status and the next action', async (t) => {
  const dir = await workdir(t);
  const res = await run(['read', dir, '--plan']);
  assert.equal(res.code, 0, res.stderr);
  const lines = res.stdout.split('\n');
  assert.match(lines[0], /^plan: draft$/);
  assert.match(lines[1], /^next: publish_plan/);
  assert.match(res.stdout, /goal:    Add an agent read command\./);
  assert.match(res.stdout, /payload: Return the canonical payload\./);
  // Evidence travels by label and reference, never as an excerpt.
  assert.match(res.stdout, /ev-policy: the permission matrix/);
  assert.match(res.stdout, /web\/lib\/planPolicy\.ts/);
});

test('a target with no packet is an error, not an empty plan', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-planread-'));
  const res = await run(['read', dir, '--plan', '--json']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /no plan\.json/);
});
