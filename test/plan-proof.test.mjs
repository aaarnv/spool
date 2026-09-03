// The proof block — what a proof spool claims (roadmap R5.1, CONTRACTS.md "Proof
// linkage").
//
// Three properties are asserted here, because they are the three the task names:
//
//   1. A proof ENUMERATES. Every approach step of the parent revision gets a verdict;
//      a step left out is refused rather than read as "it passed".
//   2. A deviation is STRUCTURAL. Any verdict that is not `verified` must be named by
//      a deviation field, so nothing important can hide in the narration.
//   3. The state rule has ONE escape hatch, and it is explicit. A proof of a plan
//      nobody approved is refused unless the proof says so and says why.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  DEVIATION_SOURCES,
  PROOF_MODES,
  PROOF_STATUSES,
  buildProof,
  proofAllowedIn,
  proofDigest,
  proofFromOptions,
  proofOverride,
  validateProof,
} from '../src/plan/proof.mjs';
import { buildShareReply, replyDigest, validateReply } from '../src/plan/reply.mjs';

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
  approach: [
    { id: 'data', summary: 'Add the tables.' },
    { id: 'api', summary: 'Expose the endpoints.' },
  ],
  evidence: [],
  questionIds: [],
  ...over,
});

const proof = (over = {}) => ({
  mode: 'video',
  outcome: { status: 'verified' },
  approach: [
    { id: 'data', status: 'verified' },
    { id: 'api', status: 'verified' },
  ],
  deviations: [],
  ...over,
});

const proofReply = (over = {}) => ({
  version: 1,
  kind: 'reply',
  replyKind: 'proof',
  parent: { spoolId: PLAN_ID, revisionId: REVISION, revision: 1, watch: `http://localhost/l/${PLAN_ID}` },
  anchors: [],
  summary: 'The endpoints answer and the migration ran.',
  proof: proof(),
  ...over,
});

async function run(args, cwd = repo) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** The two reads `spool reply` makes, with the parent in whatever state a test needs. */
async function host(plan = {}) {
  const payload = {
    spoolId: PLAN_ID,
    kind: 'plan',
    revision: 1,
    revisionId: REVISION,
    status: 'approved',
    goal: 'Add timestamped questions.',
    approach: [
      { id: 'data', summary: 'Add the tables.' },
      { id: 'api', summary: 'Expose the endpoints.' },
    ],
    evidence: [],
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

// --- 1. a proof enumerates ---------------------------------------------------

test('a complete proof validates against the revision it proves', () => {
  const report = validateProof(proof(), parentFacts());
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.warnings.length, 0);
});

test('a step left out of the enumeration is refused, not read as verified', () => {
  const report = validateProof(proof({ approach: [{ id: 'data', status: 'verified' }] }), parentFacts());
  assert.equal(report.ok, false);
  const missing = report.errors.find((e) => e.code === 'incomplete');
  assert.ok(missing, JSON.stringify(report.errors));
  assert.match(missing.message, /api/);
});

test('a proof cannot claim a step the plan does not have, or claim one twice', () => {
  const unknown = validateProof(proof({ approach: [...proof().approach, { id: 'ghost', status: 'verified' }] }), parentFacts());
  assert.ok(unknown.errors.some((e) => e.code === 'unknown-step'));

  const twice = validateProof(proof({ approach: [...proof().approach, { id: 'api', status: 'unmet' }] }), parentFacts());
  assert.ok(twice.errors.some((e) => e.code === 'duplicate'));
});

test('the outcome needs a verdict of its own', () => {
  const report = validateProof(proof({ outcome: undefined }), parentFacts());
  assert.ok(report.errors.some((e) => e.path === 'proof.outcome' && e.code === 'required'));
});

test('a proof that verifies nothing is a status spool wearing the wrong kind', () => {
  const report = validateProof(
    proof({
      outcome: { status: 'unmet' },
      approach: [
        { id: 'data', status: 'unmet' },
        { id: 'api', status: 'unmet' },
      ],
      deviations: [
        { from: 'outcome', summary: 'The feature is not reachable yet.' },
        { from: 'approach', id: 'data', summary: 'The migration is written but not run.' },
        { from: 'approach', id: 'api', summary: 'Not started.' },
      ],
    }),
    parentFacts()
  );
  assert.ok(report.errors.some((e) => e.code === 'nothing-verified'), JSON.stringify(report.errors));
});

// --- 2. deviations are structural -------------------------------------------

test('a verdict that is not verified must be named by a deviation', () => {
  const report = validateProof(
    proof({ approach: [{ id: 'data', status: 'verified' }, { id: 'api', status: 'partial' }] }),
    parentFacts()
  );
  assert.equal(report.ok, false);
  const unstated = report.errors.find((e) => e.code === 'unstated-deviation');
  assert.ok(unstated, JSON.stringify(report.errors));
  assert.match(unstated.message, /"api"/);

  const stated = validateProof(
    proof({
      approach: [{ id: 'data', status: 'verified' }, { id: 'api', status: 'partial' }],
      deviations: [{ from: 'approach', id: 'api', summary: 'Only the read endpoint shipped.' }],
    }),
    parentFacts()
  );
  assert.equal(stated.ok, true, JSON.stringify(stated.errors));
});

test('an unmet outcome must be stated too', () => {
  const report = validateProof(proof({ outcome: { status: 'partial' } }), parentFacts());
  assert.ok(report.errors.some((e) => e.code === 'unstated-deviation' && /outcome/.test(e.message)));
});

test('a deviation must name a real source, a claimed step, and what differs', () => {
  const source = validateProof(proof({ deviations: [{ from: 'vibes', summary: 'x' }] }), parentFacts());
  assert.ok(source.errors.some((e) => e.code === 'invalid-source'));

  const ghost = validateProof(proof({ deviations: [{ from: 'approach', id: 'ghost', summary: 'x' }] }), parentFacts());
  assert.ok(ghost.errors.some((e) => e.code === 'unknown-step'));

  const empty = validateProof(proof({ deviations: [{ from: 'plan', summary: '  ' }] }), parentFacts());
  assert.ok(empty.errors.some((e) => e.path === 'proof.deviations[0].summary'));
});

// --- 3. the escape hatch is explicit ----------------------------------------

test('a proof of a plan nobody approved is refused', () => {
  assert.equal(proofAllowedIn('awaiting_decision', proof()), false);
  assert.equal(proofAllowedIn('approved', proof()), true);
  assert.equal(proofAllowedIn('implementing', proof()), true);
  // An offline read has no status; the server checks again at publish.
  assert.equal(proofAllowedIn(undefined, proof()), true);

  const report = validateReply(proofReply(), parentFacts({ status: 'redirected' }));
  assert.equal(report.ok, false);
  const state = report.errors.find((e) => e.code === 'wrong-state');
  assert.ok(state);
  assert.match(state.message, /--override unapproved/);
});

test('the override lets it through, and only with a reason', () => {
  const overridden = proof({ override: { unapproved: true, reason: 'The gate is advisory on this repo.' } });
  assert.equal(proofAllowedIn('awaiting_decision', overridden), true);
  assert.equal(validateReply(proofReply({ proof: overridden }), parentFacts({ status: 'redirected' })).ok, true);

  const silent = proof({ override: { unapproved: true } });
  const report = validateProof(silent, parentFacts({ status: 'redirected' }));
  assert.ok(report.errors.some((e) => e.path === 'proof.override.reason' && e.code === 'required'));
});

test('an override nobody needed warns rather than passes unnoticed', () => {
  const report = validateProof(proof({ override: { unapproved: true, reason: 'belt and braces' } }), parentFacts());
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.code === 'needless-override'));
});

test('proofOverride reads absent, empty and all-false the same way', () => {
  for (const p of [proof(), proof({ override: {} }), proof({ override: { unapproved: false, superseded: false } })]) {
    assert.deepEqual(proofOverride(p), { unapproved: false, superseded: false, reason: null });
  }
});

// --- the block only belongs to a proof --------------------------------------

test('a proof reply must carry the block, and no other kind may', () => {
  const bare = validateReply(proofReply({ proof: undefined }), parentFacts());
  assert.ok(bare.errors.some((e) => e.path === 'proof' && e.code === 'required'));

  const wrong = validateReply(
    { ...proofReply(), replyKind: 'status', anchors: [] },
    parentFacts({ status: 'implementing' })
  );
  assert.ok(wrong.errors.some((e) => e.code === 'wrong-kind'));
});

// --- the published copy ------------------------------------------------------

test('the published copy is normalized and carries no empty override', () => {
  const built = buildShareReply(proofReply({ proof: proof({ outcome: { status: 'verified', note: '  ran twice  ' } }) }));
  assert.deepEqual(built.proof.outcome, { status: 'verified', note: 'ran twice' });
  assert.equal('override' in built.proof, false);
  assert.equal(built.proof.mode, 'video');

  const over = buildProof(proof({ override: { superseded: true, reason: 'The work was done against revision 1.' } }));
  assert.deepEqual(over.override, { unapproved: false, superseded: true, reason: 'The work was done against revision 1.' });
});

test('an answer never carries a proof block, even if one was authored', () => {
  const built = buildShareReply({ ...proofReply(), replyKind: 'answer' });
  assert.equal('proof' in built, false);
});

test('the digest prints every verdict, the deviations and the override', () => {
  const built = buildShareReply(
    proofReply({
      proof: proof({
        approach: [{ id: 'data', status: 'verified' }, { id: 'api', status: 'partial' }],
        deviations: [{ from: 'approach', id: 'api', summary: 'Only the read endpoint shipped.' }],
        override: { superseded: true, reason: 'Built against revision 1.' },
      }),
    })
  );
  const digest = replyDigest(built);
  assert.match(digest, /outcome ✓ verified/);
  assert.match(digest, /api ~ partial/);
  assert.match(digest, /deviation: approach api — Only the read endpoint shipped\./);
  assert.match(digest, /override: superseded — Built against revision 1\./);
  assert.match(proofDigest(buildProof(proof({ mode: 'evidence' }))), /evidence-only/);
});

// --- the flag grammar --------------------------------------------------------

test('--verifies all covers the outcome and every planned step', () => {
  const built = proofFromOptions(['all'], [], {}, parentFacts());
  assert.deepEqual(built.outcome, { status: 'verified', note: null });
  assert.deepEqual(built.approach, [
    { id: 'data', status: 'verified', note: null },
    { id: 'api', status: 'verified', note: null },
  ]);
});

test('--verifies reads a comma list, a per-step status, and a note', () => {
  const built = proofFromOptions(['outcome,data', 'api:partial=only the read endpoint'], [], {}, parentFacts());
  assert.equal(built.outcome.status, 'verified');
  assert.deepEqual(built.approach, [
    { id: 'data', status: 'verified', note: null },
    { id: 'api', status: 'partial', note: 'only the read endpoint' },
  ]);
});

test('the enumeration comes out in the plan order, whatever order the flags came in', () => {
  const built = proofFromOptions(['api', 'outcome', 'data'], [], {}, parentFacts());
  assert.deepEqual(built.approach.map((s) => s.id), ['data', 'api']);
});

test('a proof with no --verifies is refused rather than defaulted to "it all passed"', () => {
  assert.throws(() => proofFromOptions([], [], {}, parentFacts()), /must say what it verifies/);
});

test('a typo in a flag is refused rather than silently claimed', () => {
  assert.throws(() => proofFromOptions(['api:probably'], [], {}, parentFacts()), /status must be one of/);
  assert.throws(() => proofFromOptions(['all'], ['api=x'], {}, parentFacts()), /deviation source must be one of/);
  assert.throws(() => proofFromOptions(['all'], ['approach=x'], {}, parentFacts()), /must name the approach step/);
  assert.throws(() => proofFromOptions(['all'], ['plan'], {}, parentFacts()), /--deviation must be/);
  assert.throws(
    () => proofFromOptions(['all'], [], { override: ['whenever'], overrideReason: 'x' }, parentFacts()),
    /--override must be/
  );
});

test('a note containing a comma stays one spec', () => {
  const built = proofFromOptions(['api:partial=read works, write does not'], [], {}, parentFacts());
  assert.equal(built.approach[0].note, 'read works, write does not');
});

// --- end to end through the CLI ---------------------------------------------

test('spool reply --kind proof writes the enumeration it was given', async () => {
  const server = await host({ status: 'implementing' });
  const cwd = await mkdtemp(join(tmpdir(), 'spool-proofcwd-'));
  const res = await run(
    [
      'reply', PLAN_ID,
      '--host', server.url,
      '--kind', 'proof',
      '--verifies', 'all',
      '--verifies', 'api:partial=only the read endpoint shipped',
      '--deviation', 'approach:api=the write endpoint moved to a follow-up',
      '--summary', 'The tables are live and reads answer.',
      '--dir', 'spool/proof-it',
    ],
    cwd
  );
  assert.equal(res.code, 0, res.stderr);
  const written = JSON.parse(await readFile(join(cwd, 'spool', 'proof-it', 'reply.json'), 'utf8'));
  assert.equal(written.replyKind, 'proof');
  assert.equal(written.parent.revisionId, REVISION);
  assert.deepEqual(written.proof.approach, [
    { id: 'data', status: 'verified', note: null },
    { id: 'api', status: 'partial', note: 'only the read endpoint shipped' },
  ]);
  assert.deepEqual(written.proof.deviations, [
    { from: 'approach', id: 'api', summary: 'the write endpoint moved to a follow-up' },
  ]);
  assert.match(res.stdout, /Differs: approach api/);
  await server.close();
  await rm(cwd, { recursive: true, force: true });
});

test('spool reply refuses a proof whose deviation was never stated', async () => {
  const server = await host({ status: 'approved' });
  const cwd = await mkdtemp(join(tmpdir(), 'spool-proofcwd-'));
  const res = await run(
    ['reply', PLAN_ID, '--host', server.url, '--kind', 'proof', '--verifies', 'all', '--verifies', 'api:unmet'],
    cwd
  );
  assert.equal(res.code, 1);
  assert.match(res.stderr, /a deviation must state what differs/);
  await server.close();
  await rm(cwd, { recursive: true, force: true });
});

test('spool reply refuses proof flags on a reply that is not a proof', async () => {
  const server = await host();
  const cwd = await mkdtemp(join(tmpdir(), 'spool-proofcwd-'));
  const res = await run(['reply', PLAN_ID, '--host', server.url, '--verifies', 'all'], cwd);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /describe a proof/);
  await server.close();
  await rm(cwd, { recursive: true, force: true });
});

// --- the vocabulary is closed ------------------------------------------------

test('every vocabulary this module publishes is closed and small', () => {
  assert.deepEqual([...PROOF_STATUSES], ['verified', 'partial', 'unmet']);
  assert.deepEqual([...PROOF_MODES], ['video', 'evidence']);
  assert.deepEqual([...DEVIATION_SOURCES], ['outcome', 'approach', 'plan']);
});
