// `spool status` and the status report — where the approved work is (roadmap R5.4,
// CONTRACTS.md "Implementation status").
//
// The acceptance criterion is a speed one: a reviewer must tell on-plan from changed
// from blocked quickly. Everything asserted here serves that — the verdict is required,
// a report that contradicts itself is refused before a video exists, the narration
// opens with the verdict, and the noise the roadmap names (a status per commit) cannot
// be recorded at all.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  MAX_COMPLETED,
  MAX_STATUS_TEXT,
  STATUS_REASONS,
  STATUS_VERDICTS,
  buildShareStatus,
  buildStatusReport,
  checkStatusReport,
  statusDigest,
  statusHeadline,
} from '../src/plan/status.mjs';
import { buildShareReply, replyDigest, validateReply, writeShareReply } from '../src/plan/reply.mjs';
import { statusSteps, statusStepsFile, verdictNarration } from '../src/plan/status-template.mjs';
import { completedFromOptions, gitHookEnv, normalizeVerdict, reportFromOptions } from '../src/plan/status-cmd.mjs';
import { planDigest } from '../src/plan/read.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'bin', 'spool.mjs');

const PLAN_ID = 'aaaabbbbccccddddeeee11';
const REVISION = '11111111-2222-3333-4444-555555555555';

const parentFacts = (over = {}) => ({
  spoolId: PLAN_ID,
  revisionId: REVISION,
  status: 'approved',
  goal: 'Add implementation status spools.',
  approach: [
    { id: 'data', summary: 'Add the column.' },
    { id: 'ui', summary: 'Render the verdict.' },
  ],
  evidence: [{ id: 'ev-schema' }],
  ...over,
});

const report = (over = {}) => ({
  verdict: 'on_plan',
  planValid: true,
  reason: 'milestone',
  completed: ['data'],
  changed: null,
  blocked: null,
  next: 'Render the verdict.',
  ...over,
});

const descriptor = (over = {}) => ({
  version: 1,
  kind: 'reply',
  replyKind: 'status',
  parent: { spoolId: PLAN_ID, revisionId: REVISION, revision: 1, watch: `http://localhost/l/${PLAN_ID}` },
  anchors: [],
  summary: 'One of two steps done.',
  status: report(),
  ...over,
});

async function run(args, cwd = repo, env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { cwd, env: { ...process.env, ...env } });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A host that answers the read `spool status` makes before it writes anything. */
async function host(plan = {}) {
  const payload = {
    spoolId: PLAN_ID,
    kind: 'plan',
    revision: 1,
    revisionId: REVISION,
    status: 'approved',
    goal: 'Add implementation status spools.',
    approach: [
      { id: 'data', summary: 'Add the column.' },
      { id: 'ui', summary: 'Render the verdict.' },
    ],
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
      res.end(JSON.stringify({ questions: [] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// --- the report contract -----------------------------------------------------

test('the vocabulary is the three verdicts a reviewer tells apart, and the three cadences', () => {
  assert.deepEqual(STATUS_VERDICTS, ['on_plan', 'changed', 'blocked']);
  assert.deepEqual(STATUS_REASONS, ['milestone', 'blocker', 'decision']);
});

test('a well-formed report passes, and says whether the approved plan still holds', () => {
  const res = checkStatusReport(report(), parentFacts());
  assert.equal(res.errors.length, 0, JSON.stringify(res.errors));
  assert.match(statusHeadline(report()), /^on plan · the approved plan still holds$/);
  assert.match(statusHeadline(report({ verdict: 'changed', planValid: false })), /no longer holds/);
});

test('a report with no verdict, no cadence, or no plan-valid answer is refused', () => {
  const codes = (r, parent) => checkStatusReport(r, parent).errors.map((e) => `${e.path}:${e.code}`);
  assert.deepEqual(checkStatusReport(null).errors.map((e) => e.code), ['required']);
  assert.ok(codes(report({ verdict: 'done' })).includes('status.verdict:invalid-verdict'));
  assert.ok(codes(report({ planValid: 'yes' })).includes('status.planValid:required'));
  assert.ok(codes(report({ reason: 'commit' })).includes('status.reason:invalid-reason'));
});

test('a report cannot contradict itself', () => {
  const codes = (r) => checkStatusReport(r, parentFacts()).errors.map((e) => `${e.path}:${e.code}`);
  // On plan while the plan no longer holds is the contradiction a reviewer would act on.
  assert.ok(codes(report({ planValid: false })).includes('status.verdict:contradiction'));
  // A change nobody described is a claim that cannot be checked.
  assert.ok(codes(report({ verdict: 'changed', changed: null })).includes('status.changed:required'));
  assert.ok(codes(report({ verdict: 'changed', planValid: false, changed: null })).includes('status.changed:required'));
  // Blocked by what?
  assert.ok(codes(report({ verdict: 'blocked', reason: 'blocker', blocked: null })).includes('status.blocked:required'));
  // Blocked work is not a milestone — the cadence has to match the verdict.
  assert.ok(codes(report({ verdict: 'blocked', blocked: 'the API key is missing' })).includes('status.reason:invalid-reason'));
});

test('a milestone names the steps it finished — an empty one is the noise R5.4 refuses', () => {
  const empty = checkStatusReport(report({ completed: [] }), parentFacts());
  assert.ok(empty.errors.some((e) => e.code === 'empty-milestone'));
  // A blocker or a decision request is legal with nothing finished: that is the point.
  const blocked = checkStatusReport(
    report({ verdict: 'blocked', reason: 'blocker', completed: [], blocked: 'the staging database is down', next: 'ask ops' }),
    parentFacts()
  );
  assert.equal(blocked.errors.length, 0, JSON.stringify(blocked.errors));
});

test('a completed step must be a step of THIS plan, when the plan is in hand', () => {
  const wrong = checkStatusReport(report({ completed: ['someone-elses-step'] }), parentFacts());
  assert.ok(wrong.errors.some((e) => e.code === 'unknown-step'));
  // Offline, an unknown approach is not an empty one: the server checks again.
  assert.equal(checkStatusReport(report({ completed: ['someone-elses-step'] })).errors.length, 0);
});

test('every user-visible line is bounded, so a status stays skimmable', () => {
  const long = checkStatusReport(report({ changed: 'x'.repeat(MAX_STATUS_TEXT + 1), verdict: 'changed' }), parentFacts());
  assert.ok(long.errors.some((e) => e.code === 'too-long'));
  const many = checkStatusReport(report({ completed: Array(MAX_COMPLETED + 1).fill('data') }), parentFacts());
  assert.ok(many.errors.some((e) => e.code === 'too-many'));
});

test('a blocked status with no way out is a warning, never a refusal', () => {
  const res = checkStatusReport(report({ verdict: 'blocked', reason: 'blocker', blocked: 'the key is missing', next: null }), parentFacts());
  assert.equal(res.errors.length, 0);
  assert.ok(res.warnings.some((w) => w.code === 'no-next'));
});

test('a report is normalized: duplicates dropped, blank text is null', () => {
  const built = buildStatusReport({ verdict: 'on_plan', planValid: true, reason: 'milestone', completed: ['data', 'data', ' ui '], changed: '   ' });
  assert.deepEqual(built.completed, ['data', 'ui']);
  assert.equal(built.changed, null);
});

// --- the report inside a reply -----------------------------------------------

test('a status reply must carry a report, and no other kind may', () => {
  assert.equal(validateReply(descriptor(), parentFacts()).ok, true);

  const bare = validateReply(descriptor({ status: undefined }), parentFacts());
  assert.equal(bare.ok, false);
  assert.ok(bare.errors.some((e) => e.path === 'status' && e.code === 'required'));

  const answer = validateReply(
    { ...descriptor(), replyKind: 'answer', anchors: [] },
    parentFacts({ status: 'approved' })
  );
  assert.ok(answer.errors.some((e) => e.path === 'status' && e.code === 'unexpected'));
});

test('a status needs a plan that was approved: there is no progress on a proposal', () => {
  const early = validateReply(descriptor(), parentFacts({ status: 'awaiting_decision' }));
  assert.equal(early.ok, false);
  assert.ok(early.errors.some((e) => e.code === 'wrong-state'));
  assert.equal(validateReply(descriptor(), parentFacts({ status: 'implementing' })).ok, true);
});

test('the published copy carries the report, and the digest leads with the verdict', () => {
  const shared = buildShareReply(descriptor());
  assert.deepEqual(shared.status, buildShareStatus(report()));
  const digest = replyDigest(shared);
  const verdictLine = digest.split('\n').find((l) => l.includes('on plan'));
  assert.ok(verdictLine, digest);
  // Before the revision id, before the anchors, before the summary.
  assert.ok(digest.indexOf('on plan') < digest.indexOf('revision:'), digest);
  assert.match(statusDigest(report()), /^on plan · the approved plan still holds \(milestone\)/);
});

test('the bundle carries the report, and a report-less status never becomes one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-status-share-'));
  try {
    const share = join(dir, 'share');
    await mkdir(share, { recursive: true });
    await writeFile(join(dir, 'reply.json'), JSON.stringify(descriptor(), null, 2));
    const summary = await writeShareReply(dir, share);
    assert.equal(summary.replyKind, 'status');
    assert.equal(summary.status.verdict, 'on_plan');
    assert.deepEqual(JSON.parse(await readFile(join(share, 'reply.json'), 'utf8')).status, buildShareStatus(report()));

    // A descriptor somebody hand-edited into a verdict-less status is an orphan of a
    // different kind: a progress video nobody can skim. `spool share` refuses it.
    await writeFile(join(dir, 'reply.json'), JSON.stringify(descriptor({ status: undefined }), null, 2));
    await assert.rejects(() => writeShareReply(dir, share), /status report/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// --- the creation template ---------------------------------------------------

test('the scaffolded narration opens with the verdict and reads the report in order', () => {
  const steps = statusSteps(report({ verdict: 'changed', changed: 'the column is jsonb, not a table', blocked: null }), parentFacts());
  assert.deepEqual(steps.map((s) => s.name), ['verdict', 'done', 'changed', 'next']);
  assert.match(steps[0].narration, /^Status on Add implementation status spools: the work has changed/);
  assert.match(verdictNarration(report(), parentFacts()), /still on plan\. 1 of 2 steps done\./);

  const file = statusStepsFile(report(), parentFacts(), { url: 'http://localhost:3000' });
  assert.match(file, /export const steps = \[/);
  assert.ok(file.indexOf('"verdict"') < file.indexOf('"done"'), file);
});

// --- the command -------------------------------------------------------------

test('flags become a report: the cadence defaults from the verdict', () => {
  assert.equal(normalizeVerdict('on plan'), 'on_plan');
  assert.equal(normalizeVerdict('On-Plan'), 'on_plan');
  assert.deepEqual(completedFromOptions({ done: ['data,ui', ' api '] }), ['data', 'ui', 'api']);
  assert.equal(reportFromOptions({ verdict: 'blocked' }).reason, 'blocker');
  assert.equal(reportFromOptions({ verdict: 'changed' }).reason, 'milestone');
  assert.equal(reportFromOptions({ verdict: 'on_plan' }).planValid, true);
  assert.equal(reportFromOptions({ verdict: 'changed', planHolds: false }).planValid, false);
});

test('a status is an explicit action: a git hook cannot record one', async () => {
  assert.equal(gitHookEnv({ GIT_INDEX_FILE: '/repo/.git/index' }), true);
  assert.equal(gitHookEnv({ GIT_AUTHOR_DATE: '@1 +0000', GIT_DIR: '/repo/.git' }), true);
  assert.equal(gitHookEnv({}), false);

  const res = await run(['status', PLAN_ID, '--verdict', 'on_plan'], repo, { GIT_INDEX_FILE: '/repo/.git/index' });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /explicit action/);
  // It refuses before it reads the parent, so no network call is even attempted.
  assert.doesNotMatch(res.stderr, /unreachable/);
});

test('`spool reply --kind status` points at the command that carries a verdict', async () => {
  const res = await run(['reply', PLAN_ID, '--kind', 'status']);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /spool status <parent>/);
});

test('`spool status` writes the descriptor and the narration skeleton', async () => {
  const server = await host();
  const cwd = await mkdtemp(join(tmpdir(), 'spool-status-'));
  try {
    const res = await run(
      ['status', `${server.url}/l/${PLAN_ID}`, '--verdict', 'on plan', '--done', 'data', '--next', 'Render the verdict.', '--json'],
      cwd
    );
    assert.equal(res.code, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.reply.replyKind, 'status');
    assert.deepEqual(out.reply.status.completed, ['data']);
    assert.equal(out.reply.status.reason, 'milestone');
    // The timeline row reads even when nobody wrote a summary.
    assert.match(out.reply.summary, /^on plan · /);

    const written = JSON.parse(await readFile(out.file, 'utf8'));
    assert.equal(written.parent.spoolId, PLAN_ID);
    assert.equal(written.parent.revisionId, REVISION);
    const steps = await readFile(out.steps, 'utf8');
    assert.match(steps, /still on plan/);
    // A second run must never overwrite a recording an agent already authored.
    const again = await run(['status', `${server.url}/l/${PLAN_ID}`, '--verdict', 'on_plan', '--done', 'ui', '--force', '--json'], cwd);
    assert.equal(again.code, 0, again.stderr);
    assert.equal(JSON.parse(again.stdout).workdir, out.workdir);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await server.close();
  }
});

test('`spool status` refuses a report the plan cannot take, before anything is recorded', async () => {
  const server = await host({ status: 'awaiting_decision' });
  const cwd = await mkdtemp(join(tmpdir(), 'spool-status-'));
  try {
    const early = await run(['status', `${server.url}/l/${PLAN_ID}`, '--verdict', 'on_plan', '--done', 'data'], cwd);
    assert.equal(early.code, 1);
    assert.match(early.stderr, /approved/);
    assert.equal(existsSync(join(cwd, 'spool')), false);

    const noVerdict = await run(['status', `${server.url}/l/${PLAN_ID}`], cwd);
    assert.equal(noVerdict.code, 1);
    assert.match(noVerdict.stderr, /--verdict must be one of/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await server.close();
  }
});

test('`spool status` refuses a blocked report with nothing blocking it', async () => {
  const server = await host();
  const cwd = await mkdtemp(join(tmpdir(), 'spool-status-'));
  try {
    const res = await run(['status', `${server.url}/l/${PLAN_ID}`, '--verdict', 'blocked'], cwd);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /what stops the work/);
    // And a completed step that is not this plan's is caught against the packet.
    const wrong = await run(['status', `${server.url}/l/${PLAN_ID}`, '--verdict', 'on_plan', '--done', 'nope'], cwd);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /no approach step "nope"/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await server.close();
  }
});

// --- `spool read --plan` -----------------------------------------------------

test('the plan digest leads with where the work is, not with the plan content', () => {
  const digest = planDigest({
    status: 'implementing',
    revision: 2,
    goal: 'Add implementation status spools.',
    outcome: 'A reviewer tells on-plan from blocked in seconds.',
    nextAction: { action: 'none', endpoint: null, reason: 'The work is running.' },
    implementation: {
      ...report({ verdict: 'blocked', reason: 'blocker', blocked: 'the staging database is down', next: 'ask ops' }),
      watch: 'http://localhost/l/status-1',
      at: '2026-08-14T09:00:00.000Z',
      current: true,
    },
  });
  assert.match(digest, /work: blocked · the approved plan still holds \(blocker\)/);
  assert.ok(digest.indexOf('work:') < digest.indexOf('goal:'), digest);
  assert.match(digest, /blocked:  the staging database is down/);
  assert.match(digest, /watch:    http:\/\/localhost\/l\/status-1/);
});
