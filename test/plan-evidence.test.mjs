// Evidence descriptors: what a share bundle is allowed to say about a source.
//
// Three promises are tested here, because breaking any of them publishes a lie:
//   * a descriptor references, never copies (excerpts are bounded and redacted)
//   * missing and private evidence degrade to a readable state, never an error
//   * a built URL is pinned, and a ref cannot inject anything into it
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';

import {
  EXCERPT_MAX_CHARS,
  EXCERPT_MAX_LINES,
  boundExcerpt,
  checkRef,
  evidenceUrl,
  isPrivateHost,
  redact,
  resolveEvidenceItem,
} from '../src/plan/evidence.mjs';
import { planEvidenceRefs, validateEvidence, validatePacket, validatePlan } from '../src/plan/schema.mjs';
import { buildSharePlan, writeSharePlan } from '../src/plan/plan.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plan');
const fixture = (name) => JSON.parse(readFileSync(join(fixtures, name), 'utf8'));
const codes = (res) => res.errors.map((e) => e.code);
const LINKS = { repo: 'aaarnv/spool', commit: '0123456789abcdef0123456789abcdef01234567' };

const descriptor = (over = {}) => ({
  id: 'ev-1',
  kind: 'file',
  label: 'A file',
  ref: 'src/plan/evidence.mjs',
  chapterIds: ['approach'],
  ...over,
});

const bundle = (items) => ({ version: 1, kind: 'evidence', items });

// --- redaction --------------------------------------------------------------

test('secret-shaped text is masked wherever it is published', () => {
  const cases = [
    'https://user:s3cr3t@example.com/x',
    'curl -H "authorization: Bearer abcdef123456"',
    'GITHUB_TOKEN=ghp_0123456789abcdefghijklmnopqrstuvwxyz',
    'https://example.com/api?api_key=abcdef123456789',
    '/Users/someone/Projects/spool/notes.md',
  ];
  for (const value of cases) {
    const out = redact(value);
    assert.equal(out.redacted, true, `expected a redaction in: ${value}`);
    assert.match(out.text, /\[redacted\]/);
  }
  assert.equal(redact('web/db/schema.ts').redacted, false);
});

test('an excerpt is bounded and redacted, so a packet cannot become a copy', () => {
  const long = Array.from({ length: EXCERPT_MAX_LINES + 10 }, (_, i) => `line ${i}`).join('\n');
  const bounded = boundExcerpt(long);
  assert.equal(bounded.text.split('\n').length, EXCERPT_MAX_LINES);
  assert.equal(bounded.truncated, true);

  const wide = boundExcerpt('x'.repeat(EXCERPT_MAX_CHARS + 50));
  assert.equal(wide.text.length, EXCERPT_MAX_CHARS);
  assert.equal(wide.truncated, true);

  const secret = boundExcerpt('const token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";');
  assert.match(secret.text, /\[redacted\]/);
  assert.equal(secret.redacted, true);
  assert.equal(boundExcerpt('   '), null);
});

// --- ref rules --------------------------------------------------------------

test('a ref is checked against the rules for its kind', () => {
  assert.equal(checkRef('file', 'web/db/schema.ts'), null);
  assert.equal(checkRef('url', 'https://example.com/docs'), null);
  assert.equal(checkRef('commit', '0123456789abcdef'), null);
  assert.equal(checkRef('test', 'npm test -- plan'), null);

  assert.equal(checkRef('file', '/etc/passwd').code, 'private-ref');
  assert.equal(checkRef('file', '../../.env').code, 'invalid-ref');
  assert.equal(checkRef('file', 'https://example.com/a.ts').code, 'invalid-ref');
  assert.equal(checkRef('url', 'javascript:alert(1)').code, 'invalid-ref');
  assert.equal(checkRef('url', 'https://user:pw@example.com').code, 'invalid-ref');
  assert.equal(checkRef('url', 'http://localhost:3000/admin').code, 'private-ref');
  assert.equal(checkRef('commit', 'main').code, 'invalid-ref');
  assert.equal(checkRef('console', 'npm run dev\nrm -rf /').code, 'invalid-ref');
});

test('a private host is one only the author can reach', () => {
  for (const host of ['localhost', '127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', 'ci.internal', 'buildbox']) {
    assert.equal(isPrivateHost(host), true, `${host} should read as private`);
  }
  for (const host of ['example.com', 'github.com', 'spoolkit.dev']) {
    assert.equal(isPrivateHost(host), false, `${host} should read as public`);
  }
});

test('an unsafe ref fails validation, and a declared-private one does not', () => {
  const unsafe = validateEvidence(bundle([descriptor({ kind: 'url', ref: 'http://localhost:3000/admin' })]));
  assert.equal(unsafe.ok, false);
  assert.deepEqual(codes(unsafe), ['private-ref']);

  const declared = validateEvidence(bundle([descriptor({ kind: 'url', ref: 'http://localhost:3000/admin', visibility: 'private' })]));
  assert.equal(declared.ok, true, JSON.stringify(declared.errors, null, 2));
});

test('a private descriptor cannot carry an excerpt', () => {
  const res = validateEvidence(bundle([descriptor({ visibility: 'private', excerpt: 'const secret = 1;' })]));
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('private-excerpt'));
});

test('an over-long excerpt warns rather than failing: it is published truncated', () => {
  const res = validateEvidence(bundle([descriptor({ excerpt: 'x\n'.repeat(EXCERPT_MAX_LINES + 5) })]));
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.code === 'too-long'));
});

// --- URL construction -------------------------------------------------------

test('a built URL is pinned to a commit and encodes every path segment', () => {
  assert.equal(
    evidenceUrl(descriptor({ ref: 'web/app/l/[id]/AskPanel.tsx' }), LINKS),
    `https://github.com/aaarnv/spool/blob/${LINKS.commit}/web/app/l/%5Bid%5D/AskPanel.tsx`
  );
  // A ref cannot add a query, a fragment or a path of its own.
  assert.equal(
    evidenceUrl(descriptor({ ref: 'src/a.ts?token=abc#L1' }), LINKS),
    `https://github.com/aaarnv/spool/blob/${LINKS.commit}/src/a.ts%3Ftoken%3Dabc%23L1`
  );
  assert.equal(evidenceUrl(descriptor({ lines: [12, 20] }), LINKS).endsWith('#L12-L20'), true);
  assert.equal(evidenceUrl(descriptor({ lines: [12] }), LINKS).endsWith('#L12'), true);
  assert.equal(evidenceUrl(descriptor({ kind: 'commit', ref: '0123456789abcdef' }), LINKS), 'https://github.com/aaarnv/spool/commit/0123456789abcdef');
});

test('a URL that cannot be pinned or trusted is not built', () => {
  assert.equal(evidenceUrl(descriptor(), { repo: 'aaarnv/spool' }), null, 'no commit to pin to');
  assert.equal(evidenceUrl(descriptor(), { commit: LINKS.commit }), null, 'no repo to build from');
  assert.equal(evidenceUrl(descriptor({ ref: '../../.ssh/id_rsa' }), LINKS), null);
  assert.equal(evidenceUrl(descriptor({ kind: 'url', ref: 'javascript:alert(1)' }), LINKS), null);
  assert.equal(evidenceUrl(descriptor({ kind: 'url', ref: 'http://localhost:3000/x' }), LINKS), null);
  assert.equal(evidenceUrl(descriptor({ kind: 'test', ref: 'npm test' }), LINKS), null);
});

test('a published url ref keeps its shape but loses its secrets', () => {
  const url = evidenceUrl(descriptor({ kind: 'url', ref: 'https://example.com/run?token=abcdef123456&page=2' }), LINKS);
  assert.ok(!url.includes('abcdef123456'), url);
  assert.match(url, /page=2/);
});

// --- degraded states --------------------------------------------------------

test('a private descriptor publishes its label and withholds everything else', () => {
  const item = resolveEvidenceItem(descriptor({ visibility: 'private', ref: 'internal/pricing.ts' }), { links: LINKS });
  assert.equal(item.status, 'private');
  assert.equal(item.ref, null);
  assert.equal(item.url, null);
  assert.equal(item.excerpt, null);
  assert.equal(item.label, 'A file');
  assert.match(item.reason, /private/);
});

test('a ref that did not resolve degrades to missing, not to a broken link', () => {
  const item = resolveEvidenceItem(descriptor(), { links: LINKS, exists: false });
  assert.equal(item.status, 'missing');
  assert.equal(item.url, null);
  assert.equal(item.ref, 'src/plan/evidence.mjs');
  assert.match(item.reason, /did not resolve/);
});

test('an unknown resolution never reads as missing', () => {
  const item = resolveEvidenceItem(descriptor(), { links: LINKS, exists: null });
  assert.equal(item.status, 'available');
});

test('a descriptor with no URL but an excerpt is still available', () => {
  const item = resolveEvidenceItem(descriptor({ kind: 'test', ref: 'npm test', excerpt: '88 pass, 0 fail' }), { links: LINKS });
  assert.equal(item.status, 'available');
  assert.equal(item.url, null);
  assert.equal(item.excerpt.text, '88 pass, 0 fail');
});

test('resolution never throws, whatever the descriptor holds', () => {
  for (const value of [null, {}, { id: 'ev-1' }, { kind: 'file' }, { kind: 'url', ref: 7 }]) {
    const item = resolveEvidenceItem(value, { links: LINKS });
    assert.ok(['available', 'unpinned', 'missing', 'private'].includes(item.status));
    assert.ok(item.reason === null || typeof item.reason === 'string');
  }
});

// --- claims and serialization ----------------------------------------------

test('risks, alternatives and the decision can each cite evidence', () => {
  const plan = {
    ...fixture('valid-full.json'),
    risks: [{ claim: 'The schema may drift.', evidence: ['ev-schema'], chapterId: 'risks' }],
    decision: { ...fixture('valid-full.json').decision, evidence: ['ev-askpanel'] },
  };
  plan.alternatives = plan.alternatives.map((a) => ({ ...a, evidence: ['ev-schema'] }));
  assert.equal(validatePlan(plan).ok, true, JSON.stringify(validatePlan(plan).errors, null, 2));

  const refs = planEvidenceRefs(plan).map((r) => r.path);
  assert.ok(refs.includes('risks[0].evidence[0]'), refs.join(', '));
  assert.ok(refs.includes('alternatives[0].evidence[0]'), refs.join(', '));
  assert.ok(refs.includes('decision.evidence[0]'), refs.join(', '));

  // A dangling reference from any of them is still an authoring error.
  const dangling = { ...plan, risks: [{ claim: 'x', evidence: ['ev-nope'] }] };
  const res = validatePacket({ plan: dangling, evidence: fixture('valid-full.evidence.json') });
  assert.equal(res.ok, false);
  assert.ok(codes(res).includes('unknown-evidence'));
});

test('a string risk still validates and publishes as a claim', () => {
  const share = buildSharePlan({ plan: fixture('valid-minimal.json'), evidence: null });
  assert.deepEqual(share.risks, fixture('valid-minimal.json').risks.map((claim) => ({ claim, evidence: [], chapterId: null })));
});

test('an unpinned file descriptor warns at packet level', () => {
  const plan = { ...fixture('valid-full.json'), links: { ...fixture('valid-full.json').links, commit: null } };
  const res = validatePacket({ plan, evidence: fixture('valid-full.evidence.json') });
  assert.equal(res.ok, true);
  assert.ok(res.warnings.some((w) => w.code === 'unpinned-evidence'), JSON.stringify(res.warnings, null, 2));
});

test('the published bundle carries resolved descriptors, never the authored file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-evidence-'));
  const plan = fixture('valid-full.json');
  plan.currentState = [{ claim: 'A private service prices this.', evidence: ['ev-private'], chapterId: 'context' }];
  plan.approach = [{ id: 'data', summary: 'Read the schema.', evidence: ['ev-schema'], chapterId: 'approach' }];
  plan.decision = { ...plan.decision, evidence: ['ev-token'] };
  const evidence = bundle([
    descriptor({ id: 'ev-private', kind: 'url', ref: 'http://pricing.internal/admin', label: 'Pricing service', visibility: 'private', chapterIds: ['context'] }),
    descriptor({ id: 'ev-schema', ref: 'web/db/schema.ts', label: 'Schema', chapterIds: ['approach'] }),
    descriptor({ id: 'ev-token', kind: 'console', ref: 'curl -H "authorization: Bearer abcdef123456" https://example.com', label: 'The call we make', chapterIds: ['decision'] }),
  ]);
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(join(dir, 'evidence.json'), JSON.stringify(evidence, null, 2));
  const shareDir = join(dir, 'share');
  await mkdir(shareDir, { recursive: true });

  await writeSharePlan(dir, shareDir);
  const published = JSON.parse(await readFile(join(shareDir, 'evidence.json'), 'utf8'));
  const byId = Object.fromEntries(published.items.map((i) => [i.id, i]));

  assert.equal(published.kind, 'evidence');
  assert.equal(byId['ev-private'].status, 'private');
  assert.equal(byId['ev-private'].ref, null);
  assert.equal(byId['ev-schema'].status, 'available');
  assert.match(byId['ev-token'].ref, /\[redacted\]/);

  // The raw file must not survive anywhere in the bundle.
  const raw = await readFile(join(shareDir, 'evidence.json'), 'utf8');
  const planCopy = await readFile(join(shareDir, 'plan.json'), 'utf8');
  for (const body of [raw, planCopy]) {
    assert.ok(!body.includes('pricing.internal'), 'a private host reached the share bundle');
    assert.ok(!body.includes('abcdef123456'), 'a bearer token reached the share bundle');
  }
  await rm(dir, { recursive: true, force: true });
});

test('a ref that is not in the checkout publishes as missing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spool-evidence-'));
  await mkdir(join(dir, '.git'), { recursive: true }); // the workdir is its own checkout
  const plan = {
    ...fixture('valid-minimal.json'),
    approach: [{ id: 'step', summary: 'Read the file.', evidence: ['ev-gone'] }],
  };
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(join(dir, 'evidence.json'), JSON.stringify(bundle([descriptor({ id: 'ev-gone', ref: 'src/not-here.ts' })]), null, 2));
  const shareDir = join(dir, 'share');
  await mkdir(shareDir, { recursive: true });

  await writeSharePlan(dir, shareDir);
  const published = JSON.parse(await readFile(join(shareDir, 'plan.json'), 'utf8'));
  assert.equal(published.evidence[0].status, 'missing');
  assert.equal(published.evidence[0].url, null);
  await rm(dir, { recursive: true, force: true });
});
