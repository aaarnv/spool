// Workdir behaviour for Plan Spool packets: the pre-record gate, the share
// bundle copy, and the CLI exit codes an agent sees.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readPlanPacket, writeSharePlan } from '../src/plan/plan.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'bin', 'spool.mjs');
const fixtures = join(here, 'fixtures', 'plan');
const fixture = (name) => readFileSync(join(fixtures, name), 'utf8');

async function workdir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-plan-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  }
  return dir;
}

// Run the CLI and return { code, stdout, stderr } without throwing on failure.
async function runCli(args) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { cwd: repo });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('a workdir with no plan.json is not a Plan Spool', async () => {
  const dir = await workdir({});
  const packet = await readPlanPacket(dir);
  assert.equal(packet.present, false);
  assert.equal(packet.ok, true);
  assert.equal(await writeSharePlan(dir, dir), null);
  await rm(dir, { recursive: true, force: true });
});

test('a valid packet reads back with its evidence', async () => {
  const dir = await workdir({
    'plan.json': fixture('valid-full.json'),
    'evidence.json': fixture('valid-full.evidence.json'),
  });
  const packet = await readPlanPacket(dir);
  assert.equal(packet.present, true);
  assert.equal(packet.ok, true, JSON.stringify(packet.errors, null, 2));
  assert.equal(packet.evidence.items.length, 2);
  await rm(dir, { recursive: true, force: true });
});

test('unparseable plan.json reports the file, not a stack trace', async () => {
  const dir = await workdir({ 'plan.json': '{ "version": 1, ' });
  const packet = await readPlanPacket(dir);
  assert.equal(packet.ok, false);
  assert.equal(packet.errors[0].code, 'invalid-json');
  await rm(dir, { recursive: true, force: true });
});

test('share writes the published copy beside the media', async () => {
  const dir = await workdir({
    'plan.json': fixture('valid-full.json'),
    'evidence.json': fixture('valid-full.evidence.json'),
  });
  const shareDir = join(dir, 'share');
  await mkdir(shareDir, { recursive: true });
  const summary = await writeSharePlan(dir, shareDir);
  assert.equal(summary.file, 'plan.json');
  assert.equal(summary.evidenceFile, 'evidence.json');
  assert.ok(existsSync(join(shareDir, 'plan.json')));
  assert.ok(existsSync(join(shareDir, 'evidence.json')));
  const published = JSON.parse(await readFile(join(shareDir, 'plan.json'), 'utf8'));
  assert.equal(published.kind, 'plan');
  // The summary repeats the static proposal so the watch page renders a plan in
  // one fetch; `evidence` is the descriptor list, not the file name.
  assert.equal(summary.goal, published.goal);
  assert.ok(Array.isArray(summary.evidence));
  assert.ok(published.evidence[0].url.includes('/blob/'));
  await rm(dir, { recursive: true, force: true });
});

test('share refuses to publish an invalid packet', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-silent-alternatives.json') });
  const shareDir = join(dir, 'share');
  await mkdir(shareDir, { recursive: true });
  await assert.rejects(() => writeSharePlan(dir, shareDir), /noAlternativesReason/);
  assert.equal(existsSync(join(shareDir, 'plan.json')), false);
  await rm(dir, { recursive: true, force: true });
});

// --- CLI gate ---------------------------------------------------------------

test('an invalid plan fails `spool record` before the browser starts', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-missing-required.json') });
  const res = await runCli(['record', dir]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /plan\.json is invalid/);
  assert.match(res.stderr, /outcome/);
  assert.match(res.stderr, /risks/);
  assert.match(res.stderr, /links/);
  // The gate runs before the steps.mjs lookup, so the plan error is the only one.
  assert.doesNotMatch(res.stderr, /No steps\.mjs/);
  await rm(dir, { recursive: true, force: true });
});

test('an invalid plan fails `spool vo` before any voiceover is generated', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-decision.json') });
  const res = await runCli(['vo', dir]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /decision\.options/);
  await rm(dir, { recursive: true, force: true });
});

test('a plan from a newer CLI is rejected by name and version', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-future-version.json') });
  const res = await runCli(['record', dir]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /version 2/);
  await rm(dir, { recursive: true, force: true });
});

test('`spool lint` reports a valid packet and exits 0', async () => {
  const dir = await workdir({ 'plan.json': fixture('valid-minimal.json') });
  const res = await runCli(['lint', dir]);
  assert.equal(res.code, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /\[plan\] plan version 1 valid/);
  await rm(dir, { recursive: true, force: true });
});

test('`spool lint` blocks a publish when the packet is invalid', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-approach.json') });
  const res = await runCli(['lint', dir, '--json']);
  assert.equal(res.code, 1);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.ok(report.results.some((r) => r.check === 'plan' && r.where.includes('approach[0].id')));
  await rm(dir, { recursive: true, force: true });
});
