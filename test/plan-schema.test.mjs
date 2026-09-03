// Contract tests for plan.json / evidence.json (CONTRACTS.md "Plan Spools").
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAPTER_IDS,
  PLAN_VERSION,
  validateEvidence,
  validatePacket,
  validatePlan,
} from '../src/plan/schema.mjs';
import { buildSharePlan } from '../src/plan/plan.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plan');
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));

const codes = (res) => res.errors.map((e) => e.code);
const paths = (res) => res.errors.map((e) => e.path);

test('a minimal plan validates', () => {
  const res = validatePlan(fixture('valid-minimal.json'));
  assert.equal(res.ok, true, JSON.stringify(res.errors, null, 2));
});

test('a full plan with alternatives, chapters and evidence refs validates', () => {
  const res = validatePlan(fixture('valid-full.json'));
  assert.equal(res.ok, true, JSON.stringify(res.errors, null, 2));
});

test('the workdir template validates', () => {
  const template = JSON.parse(readFileSync(join(fixtures, '..', '..', '..', 'templates', 'plan.json'), 'utf8'));
  const res = validatePlan(template);
  assert.equal(res.ok, true, JSON.stringify(res.errors, null, 2));
});

test('every required field is named when missing', () => {
  const res = validatePlan(fixture('invalid-missing-required.json'));
  assert.equal(res.ok, false);
  for (const field of ['outcome', 'risks', 'links']) {
    assert.ok(paths(res).includes(field), `expected an error on ${field}, got ${paths(res).join(', ')}`);
  }
});

test('a newer major version is rejected loudly and nothing else is guessed', () => {
  const res = validatePlan(fixture('invalid-future-version.json'));
  assert.equal(res.ok, false);
  assert.deepEqual(codes(res), ['unsupported-version']);
  assert.match(res.errors[0].message, /version 2/);
  assert.match(res.errors[0].message, new RegExp(`plan version ${PLAN_VERSION}`));
});

test('a non-integer version is rejected before any field check', () => {
  const res = validatePlan({ ...fixture('valid-minimal.json'), version: '1' });
  assert.deepEqual(codes(res), ['required']);
  assert.deepEqual(paths(res), ['version']);
});

test('absent alternatives must be stated, not implied', () => {
  const res = validatePlan(fixture('invalid-silent-alternatives.json'));
  assert.equal(res.ok, false);
  assert.ok(paths(res).includes('noAlternativesReason'));
  // The same plan validates once the absence is declared.
  const declared = { ...fixture('invalid-silent-alternatives.json'), noAlternativesReason: 'No credible alternative considered: anchors already exist.' };
  assert.equal(validatePlan(declared).ok, true);
});

test('noAlternativesReason cannot coexist with real alternatives', () => {
  const plan = { ...fixture('valid-full.json'), noAlternativesReason: 'There were none.' };
  const res = validatePlan(plan);
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('conflict'));
});

test('decision options must be actionable and resolvable', () => {
  const res = validatePlan(fixture('invalid-decision.json'));
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('invalid-value'), codes(res).join(','));
  assert.ok(codes(res).includes('unknown-alternative'), codes(res).join(','));
  assert.ok(codes(res).includes('missing-approve'), codes(res).join(','));
});

test('a selection decision must offer an alternative', () => {
  const plan = fixture('valid-full.json');
  plan.decision.options = ['approve', 'redirect'];
  const res = validatePlan(plan);
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('missing-alternative'));
});

test('approach ids are stable anchors: kebab-case and unique', () => {
  const res = validatePlan(fixture('invalid-approach.json'));
  assert.equal(res.ok, false);
  assert.ok(paths(res).includes('approach[0].id'));
  assert.ok(paths(res).includes('approach[2].id'));
  assert.ok(paths(res).includes('approach[2].chapterId'));
});

test('an empty approach is rejected', () => {
  const plan = { ...fixture('valid-minimal.json'), approach: [] };
  assert.ok(codes(validatePlan(plan)).includes('too-few'));
});

test('chapters use the canonical ids and always include a decision', () => {
  const plan = fixture('valid-full.json');
  plan.chapters = [{ id: 'context' }, { id: 'nope' }];
  const res = validatePlan(plan);
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('unknown-chapter'));
  assert.ok(codes(res).includes('missing-decision-chapter'));
  assert.deepEqual(CHAPTER_IDS, ['context', 'outcome', 'approach', 'risks', 'decision']);
});

test('unknown top-level fields warn but do not fail', () => {
  const plan = { ...fixture('valid-minimal.json'), telemetryHint: 'from a newer authoring tool' };
  const res = validatePlan(plan);
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.code === 'unknown-field' && w.path === 'telemetryHint'));
});

// --- evidence.json ---------------------------------------------------------

test('an evidence bundle validates', () => {
  const res = validateEvidence(fixture('valid-full.evidence.json'));
  assert.equal(res.ok, true, JSON.stringify(res.errors, null, 2));
});

test('the evidence template validates', () => {
  const template = JSON.parse(readFileSync(join(fixtures, '..', '..', '..', 'templates', 'evidence.json'), 'utf8'));
  assert.equal(validateEvidence(template).ok, true);
});

test('evidence descriptors need an id, a known kind, a label and a ref', () => {
  const res = validateEvidence({
    version: 1,
    kind: 'evidence',
    items: [{ id: 'Ev 1', kind: 'screenshot', ref: '' }],
  });
  assert.equal(res.ok, false);
  assert.ok(paths(res).includes('items[0].id'));
  assert.ok(paths(res).includes('items[0].kind'));
  assert.ok(paths(res).includes('items[0].label'));
  assert.ok(paths(res).includes('items[0].ref'));
});

test('an evidence bundle from a newer major version is rejected loudly', () => {
  const res = validateEvidence({ version: 99, kind: 'evidence', items: [] });
  assert.deepEqual(codes(res), ['unsupported-version']);
});

// --- packet cross-references ------------------------------------------------

test('a packet with matching evidence validates', () => {
  const res = validatePacket({ plan: fixture('valid-full.json'), evidence: fixture('valid-full.evidence.json') });
  assert.equal(res.ok, true, JSON.stringify(res.errors, null, 2));
});

test('a plan claiming evidence that does not exist fails', () => {
  const evidence = fixture('valid-full.evidence.json');
  evidence.items = evidence.items.filter((i) => i.id !== 'ev-schema');
  const res = validatePacket({ plan: fixture('valid-full.json'), evidence });
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('unknown-evidence'));
  assert.ok(paths(res).some((p) => p.startsWith('plan.json:approach[0].evidence')));
});

test('a plan claiming evidence with no evidence.json at all fails', () => {
  const res = validatePacket({ plan: fixture('valid-full.json'), evidence: null });
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('missing-evidence-file'));
});

test('a plan with no evidence refs needs no evidence.json', () => {
  assert.equal(validatePacket({ plan: fixture('valid-minimal.json'), evidence: null }).ok, true);
});

test('unreferenced evidence warns but does not fail', () => {
  const evidence = fixture('valid-full.evidence.json');
  evidence.items.push({ id: 'ev-orphan', kind: 'url', label: 'Unused', ref: 'https://example.com' });
  const res = validatePacket({ plan: fixture('valid-full.json'), evidence });
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.code === 'unused-evidence'));
});

test('packet diagnostics say which file the problem is in', () => {
  const res = validatePacket({ plan: fixture('invalid-silent-alternatives.json'), evidence: null });
  assert.ok(res.errors.every((e) => e.path.startsWith('plan.json:')));
});

// --- published copy ---------------------------------------------------------

test('the published copy embeds evidence and pins GitHub refs to the commit', () => {
  const share = buildSharePlan({ plan: fixture('valid-full.json'), evidence: fixture('valid-full.evidence.json') });
  assert.equal(share.version, PLAN_VERSION);
  assert.equal(share.kind, 'plan');
  assert.equal(share.evidence.length, 2);
  // Path segments are percent-encoded: a ref is authored text, so it must not be
  // able to add a query, a fragment or a path of its own to the built URL.
  assert.equal(
    share.evidence[0].url,
    'https://github.com/aaarnv/spool/blob/0123456789abcdef0123456789abcdef01234567/web/app/l/%5Bid%5D/AskPanel.tsx'
  );
  assert.equal(share.evidence[0].revision, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(share.evidence[0].status, 'available');
});

test('the published copy is deterministic and fills in default chapters', () => {
  const packet = { plan: fixture('valid-minimal.json'), evidence: null };
  const a = buildSharePlan(packet);
  const b = buildSharePlan(packet);
  assert.deepEqual(a, b);
  assert.deepEqual(a.chapters.map((c) => c.id), CHAPTER_IDS);
  assert.equal(a.noAlternativesReason, fixture('valid-minimal.json').noAlternativesReason);
});

test('an unpinnable evidence ref keeps a null url rather than an unstable one', () => {
  const plan = fixture('valid-full.json');
  plan.links = { ...plan.links, commit: null };
  const share = buildSharePlan({ plan, evidence: fixture('valid-full.evidence.json') });
  assert.equal(share.evidence[0].url, null);
  assert.equal(share.evidence[0].status, 'unpinned');
  assert.match(share.evidence[0].reason, /pin/);
});
