// Backward compatibility: a v1 spool (no plan.json) must behave exactly as it did
// before Plan Spools existed. The checked-in demo workdir is the reference.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintSpool } from '../src/lint/lint.mjs';
import { readSpool } from '../src/share/share.mjs';
import { readPlanPacket } from '../src/plan/plan.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const demo = join(repo, 'spool-demo', 'meta-tour');

test('the v1 demo spool carries no plan packet', async () => {
  const packet = await readPlanPacket(demo);
  assert.equal(packet.present, false);
  assert.equal(packet.ok, true);
});

test('the v1 demo spool lints clean and gains no plan results', async () => {
  const report = await lintSpool(demo);
  assert.equal(report.errors, 0, JSON.stringify(report.results.filter((r) => r.level === 'error'), null, 2));
  assert.equal(report.results.filter((r) => r.check === 'plan').length, 0);
});

test('the v1 share bundle stays plan-free and readable', async () => {
  const spool = JSON.parse(await readFile(join(demo, 'share', 'spool.json'), 'utf8'));
  assert.equal(spool.version, 1);
  assert.equal(spool.kind, 'spool');
  assert.equal(spool.plan, undefined);

  const digest = await readSpool(demo);
  assert.doesNotMatch(digest, /^plan:/m);
  assert.match(digest, /steps:/);
});
