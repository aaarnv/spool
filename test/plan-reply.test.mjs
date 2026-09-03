// `spool reply` and reply.json — the lineage that makes a child spool an answer to
// one moment of a parent plan (roadmap R4.2, CONTRACTS.md "Replies").
//
// Two failures are asserted here because the roadmap names them: an ORPHAN reply
// (a descriptor with no parent, or a workdir that was never published) and a
// CROSS-PLAN reply (a descriptor naming a plan or a revision it was not read from).

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  REPLY_KINDS,
  REPLY_KIND_STATES,
  buildShareReply,
  checkReplyAnchor,
  kindAllowedIn,
  readReplyPacket,
  validateReply,
  writeShareReply,
} from '../src/plan/reply.mjs';
import { anchorsFromOptions } from '../src/plan/reply-cmd.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'bin', 'spool.mjs');

const PLAN_ID = 'aaaabbbbccccddddeeee11';
const REVISION = '11111111-2222-3333-4444-555555555555';
const QUESTION = '99999999-8888-7777-6666-555555555555';

const parentFacts = (over = {}) => ({
  spoolId: PLAN_ID,
  revisionId: REVISION,
  status: 'awaiting_decision',
  approach: [{ id: 'data', summary: 'Add the tables.' }],
  evidence: [{ id: 'ev-schema' }],
  questionIds: [QUESTION],
  ...over,
});

const descriptor = (over = {}) => ({
  version: 1,
  kind: 'reply',
  replyKind: 'answer',
  parent: { spoolId: PLAN_ID, revisionId: REVISION, revision: 1, watch: `http://localhost/l/${PLAN_ID}` },
  anchors: [{ type: 'question', questionId: QUESTION }],
  summary: 'The migration takes a brief lock; here it is against a copy.',
  ...over,
});

async function workdir(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-reply-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

async function run(args, cwd = repo) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/**
 * A host that answers the two reads `spool reply` makes. `plan` overrides the agent
 * read payload, so a test can put the parent in any state.
 */
async function host(plan = {}) {
  const payload = {
    spoolId: PLAN_ID,
    kind: 'plan',
    revision: 1,
    revisionId: REVISION,
    status: 'awaiting_decision',
    goal: 'Add timestamped questions.',
    approach: [{ id: 'data', summary: 'Add the tables.' }],
    evidence: [{ id: 'ev-schema', label: 'schema.ts' }],
    links: {},
    ...plan,
  };
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === `/api/plans/${PLAN_ID}`) {
      payload.links = { ...payload.links, watch: `http://127.0.0.1:${server.address().port}/l/${PLAN_ID}` };
      res.end(JSON.stringify(payload));
      return;
    }
    if (req.url === `/api/plans/${PLAN_ID}/questions`) {
      res.end(
        JSON.stringify({
          questions: [{ id: QUESTION, status: 'open', body: 'Does this lock the table?', anchor: { type: 'approach', label: 'Add the tables.' } }],
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// --- the descriptor contract -------------------------------------------------

test('a valid answer descriptor validates against its parent', () => {
  const report = validateReply(descriptor(), parentFacts());
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.warnings.length, 0);
});

test('an orphan reply is refused: no parent, no reply', () => {
  const report = validateReply(descriptor({ parent: null }));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.path === 'parent' && e.code === 'required'));
});

test('a cross-plan reply is refused by both ids', () => {
  const other = validateReply(descriptor({ parent: { spoolId: 'someone-elses-plan-00000', revisionId: REVISION } }), parentFacts());
  assert.ok(other.errors.some((e) => e.code === 'cross-plan'));

  const stale = validateReply(
    descriptor({ parent: { spoolId: PLAN_ID, revisionId: '00000000-0000-0000-0000-000000000000' } }),
    parentFacts()
  );
  assert.ok(stale.errors.some((e) => e.code === 'stale-revision'));
});

test('every reply kind is checked against the parent state', () => {
  // The rule, said once per kind: a proof needs an approved plan, a revision needs one
  // that came back, and neither is legal while the plan is only awaiting a decision.
  assert.equal(kindAllowedIn('proof', 'awaiting_decision'), false);
  assert.equal(kindAllowedIn('proof', 'approved'), true);
  assert.equal(kindAllowedIn('revision', 'awaiting_decision'), false);
  assert.equal(kindAllowedIn('revision', 'redirected'), true);
  assert.equal(kindAllowedIn('answer', 'awaiting_decision'), true);
  // A superseded revision takes no reply of any kind.
  for (const kind of REPLY_KINDS) assert.equal(kindAllowedIn(kind, 'superseded'), false);

  const report = validateReply(descriptor({ replyKind: 'proof' }), parentFacts());
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.code === 'wrong-state'));
});

test('an unknown parent state cannot refuse a reply — the server checks again', () => {
  // An offline read has no status. Refusing here would stop an agent replying to a
  // plan it can see but not reach; the publish path re-checks against the database.
  assert.equal(kindAllowedIn('proof', undefined), true);
  assert.equal(kindAllowedIn('proof', 'unknown'), true);
});

test('an anchor must name something the parent actually has', () => {
  assert.equal(checkReplyAnchor({ type: 'approach', approachId: 'data' }, parentFacts()).ok, true);
  assert.equal(checkReplyAnchor({ type: 'approach', approachId: 'nope' }, parentFacts()).ok, false);
  assert.equal(checkReplyAnchor({ type: 'evidence', evidenceId: 'ev-schema' }, parentFacts()).ok, true);
  assert.equal(checkReplyAnchor({ type: 'evidence', evidenceId: 'ghost' }, parentFacts()).ok, false);
  assert.equal(checkReplyAnchor({ type: 'chapter', chapterId: 'approach' }, parentFacts()).ok, true);
  assert.equal(checkReplyAnchor({ type: 'chapter', chapterId: 'epilogue' }, parentFacts()).ok, false);
  assert.equal(checkReplyAnchor({ type: 'question', questionId: QUESTION }, parentFacts()).ok, true);
  assert.equal(checkReplyAnchor({ type: 'question', questionId: 'gone' }, parentFacts()).ok, false);
  assert.equal(checkReplyAnchor({ type: 'range', start: 12, end: 24 }, parentFacts()).ok, true);
  assert.equal(checkReplyAnchor({ type: 'range', start: 24, end: 12 }, parentFacts()).ok, false);
});

test('a question list nobody could read never refuses an anchor', () => {
  // `plan.read_questions` is narrower than `plan.read`, so a caller may see the plan
  // and not the discussion. An unknown list is not an empty one.
  const blind = parentFacts({ questionIds: null });
  assert.equal(checkReplyAnchor({ type: 'question', questionId: QUESTION }, blind).ok, true);
});

test('an answer with no question anchor warns rather than fails', () => {
  const report = validateReply(descriptor({ anchors: [{ type: 'chapter', chapterId: 'approach' }] }), parentFacts());
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.code === 'unanchored-answer'));
});

// --- the share bundle --------------------------------------------------------

test('the published copy carries the lineage and nothing mutable', () => {
  const shared = buildShareReply(descriptor());
  assert.deepEqual(shared.parent, {
    spoolId: PLAN_ID,
    revisionId: REVISION,
    revision: 1,
    watch: `http://localhost/l/${PLAN_ID}`,
  });
  assert.equal(shared.replyKind, 'answer');
  assert.deepEqual(shared.anchors, [{ type: 'question', questionId: QUESTION }]);
  // No status, no decision: those live on the host and would rot in a blob.
  assert.equal('status' in shared, false);
});

test('share writes reply.json and refuses an invalid descriptor', async () => {
  const dir = await workdir({ 'reply.json': descriptor() });
  const summary = await writeShareReply(dir, dir);
  assert.equal(summary.file, 'reply.json');
  assert.equal(summary.replyKind, 'answer');
  assert.ok(existsSync(join(dir, 'reply.json')));

  const bad = await workdir({ 'reply.json': descriptor({ parent: null }) });
  await assert.rejects(() => writeShareReply(bad, bad), /orphan/);

  const none = await workdir({});
  assert.equal(await writeShareReply(none, none), null);
  assert.equal((await readReplyPacket(none)).present, false);

  await Promise.all([dir, bad, none].map((d) => rm(d, { recursive: true, force: true })));
});

test('a published bundle carries the lineage, so a reply works on a link', async () => {
  // What `spool share` writes, and what `spool publish` and `spool read` then consume:
  // the block in spool.json plus the full copy beside it. No local workdir needed.
  const dir = await workdir({ 'reply.json': descriptor() });
  const summary = await writeShareReply(dir, dir);
  await writeFile(
    join(dir, 'spool.json'),
    JSON.stringify({ version: 1, kind: 'spool', title: 'The lock test', duration: 30, steps: [], reply: summary }, null, 2)
  );

  const { buildReplyBundle } = await import('../src/publish/publish.mjs');
  const spool = JSON.parse(await readFile(join(dir, 'spool.json'), 'utf8'));
  const bundle = await buildReplyBundle(dir, spool);
  assert.equal(bundle.reply.parent.spoolId, PLAN_ID);
  assert.equal(bundle.reply.replyKind, 'answer');
  // The inline copy is the published one, not the authored file.
  assert.equal('file' in bundle.reply, false);

  // A receiving agent learns what this answers before it reads what it says.
  const { readSpool } = await import('../src/share/share.mjs');
  const digest = await readSpool(dir);
  assert.match(digest, new RegExp(`reply:\\s+answer to plan ${PLAN_ID}`));
  assert.match(digest, /about:\s+question/);

  // A spool that replies to nothing sends nothing.
  const plainDir = await workdir({ 'spool.json': { version: 1, kind: 'spool', steps: [] } });
  assert.equal(await buildReplyBundle(plainDir, { kind: 'spool' }), null);

  await Promise.all([dir, plainDir].map((d) => rm(d, { recursive: true, force: true })));
});

// --- the command -------------------------------------------------------------

test('--kind must be one the contract names', async () => {
  const res = await run(['reply', PLAN_ID, '--kind', 'shout']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--kind must be one of/);
});

test('a workdir that was never published has nothing to reply to', async () => {
  const dir = await workdir({});
  const res = await run(['reply', dir]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /has not been published/);
  await rm(dir, { recursive: true, force: true });
});

test('spool reply writes a descriptor anchored to the question it answers', async () => {
  const server = await host();
  const cwd = await mkdtemp(join(tmpdir(), 'spool-replycwd-'));
  const res = await run(
    ['reply', PLAN_ID, '--host', server.url, '--question', QUESTION, '--summary', 'Here is the lock test.', '--dir', 'spool/answer-lock', '--json'],
    cwd
  );
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.reply.parent.spoolId, PLAN_ID);
  assert.equal(out.reply.parent.revisionId, REVISION);
  assert.deepEqual(out.reply.anchors, [{ type: 'question', questionId: QUESTION }]);

  const written = JSON.parse(await readFile(join(cwd, 'spool', 'answer-lock', 'reply.json'), 'utf8'));
  assert.equal(written.replyKind, 'answer');
  assert.equal(written.summary, 'Here is the lock test.');

  await server.close();
  await rm(cwd, { recursive: true, force: true });
});

test('spool reply refuses a kind the parent state cannot take', async () => {
  const server = await host({ status: 'awaiting_decision' });
  const cwd = await mkdtemp(join(tmpdir(), 'spool-replycwd-'));
  // `--verifies all` so the refusal is about the STATE and not about the enumeration
  // R5.1 added: a proof of an unapproved plan is refused even when it is well formed.
  const res = await run(['reply', PLAN_ID, '--host', server.url, '--kind', 'proof', '--verifies', 'all', '--dir', 'spool/proof-it'], cwd);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /a "proof" reply is for a plan that is/);
  assert.equal(existsSync(join(cwd, 'spool', 'proof-it', 'reply.json')), false);
  await server.close();
  await rm(cwd, { recursive: true, force: true });
});

test('a plan workdir cannot also be a reply', async () => {
  const server = await host();
  const cwd = await mkdtemp(join(tmpdir(), 'spool-replycwd-'));
  const dir = join(cwd, 'mine');
  await workdir({});
  await exec(process.execPath, [cli, 'plan', 'init', 'mine', '--goal', 'Do the thing.', '--dir', dir], { cwd });
  const res = await run(['reply', PLAN_ID, '--host', server.url, '--dir', dir], cwd);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /is a plan of its own, not a reply/);
  await server.close();
  await rm(cwd, { recursive: true, force: true });
});

test('--range reads seconds and mm:ss the same way', () => {
  assert.deepEqual(anchorsFromOptions({ range: '12-24' }), [{ type: 'range', start: 12, end: 24 }]);
  assert.deepEqual(anchorsFromOptions({ range: '0:12-1:04' }), [{ type: 'range', start: 12, end: 64 }]);
  assert.throws(() => anchorsFromOptions({ range: '12' }), /--range must be/);
});

test('the kind-to-state table covers every kind exactly once', () => {
  assert.deepEqual(Object.keys(REPLY_KIND_STATES).sort(), [...REPLY_KINDS].sort());
  for (const states of Object.values(REPLY_KIND_STATES)) {
    assert.ok(states.length > 0);
    assert.equal(states.includes('superseded'), false);
  }
});
