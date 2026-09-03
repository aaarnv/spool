// What a Plan Spool publish request carries (CONTRACTS.md "Publish"). The share
// bundle is built by writeSharePlan, so these tests run the real thing end to end:
// author a workdir, write the bundle, then read the payload the CLI would send.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeSharePlan } from '../src/plan/plan.mjs';
import { buildPlanBundle } from '../src/publish/publish.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures', 'plan');
const fixture = (name) => readFileSync(join(fixtures, name), 'utf8');

// A workdir plus its share/ bundle, the two directories publish reads from.
async function bundle(files) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-publish-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  const shareDir = join(dir, 'share');
  await mkdir(shareDir, { recursive: true });
  const plan = await writeSharePlan(dir, shareDir);
  return { dir, shareDir, plan };
}

test('an ordinary walkthrough sends no plan metadata', async () => {
  const { dir, shareDir } = await bundle({});
  assert.equal(await buildPlanBundle(shareDir, { kind: 'spool' }), null);
  await rm(dir, { recursive: true, force: true });
});

test('a plan spool ships the packet and the resolved evidence', async () => {
  const { dir, shareDir, plan } = await bundle({
    'plan.json': fixture('valid-full.json'),
    'evidence.json': fixture('valid-full.evidence.json'),
  });
  assert.equal(plan.evidenceFile, 'evidence.json');

  const payload = await buildPlanBundle(shareDir, { kind: 'plan' });
  // The packet is the published copy, not the authored file: risks are claims.
  assert.equal(payload.plan.kind, 'plan');
  assert.ok(payload.plan.risks.every((r) => typeof r.claim === 'string'));
  // Evidence travels as the resolved document, so the server stores what the
  // watch page renders — every item carries a status a renderer can switch on.
  assert.equal(payload.evidence.kind, 'evidence');
  assert.equal(payload.evidence.items.length, 2);
  for (const item of payload.evidence.items) {
    assert.ok(['available', 'unpinned', 'missing', 'private'].includes(item.status), item.status);
  }
  await rm(dir, { recursive: true, force: true });
});

test('a plan that cites nothing ships the packet alone', async () => {
  const { dir, shareDir } = await bundle({ 'plan.json': fixture('valid-minimal.json') });
  const payload = await buildPlanBundle(shareDir, { kind: 'plan' });
  assert.equal(payload.plan.kind, 'plan');
  assert.equal('evidence' in payload, false);
  await rm(dir, { recursive: true, force: true });
});

test('the packet only ships when the bundle says the spool is a plan', async () => {
  const { dir, shareDir } = await bundle({ 'plan.json': fixture('valid-minimal.json') });
  // spool.json is what the server trusts for `kind`, so a bundle that does not
  // declare a plan must not smuggle a packet into the request.
  assert.equal(await buildPlanBundle(shareDir, { kind: 'spool' }), null);
  await rm(dir, { recursive: true, force: true });
});
