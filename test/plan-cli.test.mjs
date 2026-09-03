// `spool plan init | validate | build` — the CLI surface an agent scripts against.
// Exit codes and --json diagnostics are contracts (CONTRACTS.md "spool plan"), so
// they are asserted here rather than left to the shape of the day.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { readPlanPacket } from '../src/plan/plan.mjs';
import { PLAN_EXIT, planExitCode, planReportJson } from '../src/plan/report.mjs';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'bin', 'spool.mjs');
const fixtures = join(here, 'fixtures', 'plan');
const fixture = (name) => readFileSync(join(fixtures, name), 'utf8');

// A throwaway project directory. `git: true` makes it a real checkout with a
// remote and a commit, so the link auto-detection has something to find.
async function project({ git = false } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-plancli-'));
  if (git) {
    await exec('git', ['init', '-q', '.'], { cwd: dir });
    await exec('git', ['remote', 'add', 'origin', 'git@github.com:acme/widgets.git'], { cwd: dir });
    await exec('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: dir });
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

const readPlan = async (dir, slug = 'ask-anchors') => JSON.parse(await readFile(join(dir, 'spool', slug, 'plan.json'), 'utf8'));

// --- spool plan init --------------------------------------------------------

// The R1.3 acceptance test: a fresh project creates and validates a plan packet
// with no web app, no account and no network.
test('a fresh project creates and validates a plan packet', async () => {
  const dir = await project();
  const init = await run(['plan', 'init', 'ask-anchors', '--goal', 'Add timestamped questions.'], dir);
  assert.equal(init.code, 0, init.stderr);
  assert.ok(existsSync(join(dir, 'spool', 'ask-anchors', 'plan.json')));
  assert.ok(existsSync(join(dir, 'spool', 'ask-anchors', 'evidence.json')));

  const check = await run(['plan', 'validate', 'spool/ask-anchors'], dir);
  assert.equal(check.code, PLAN_EXIT.ok, check.stdout + check.stderr);
  assert.match(check.stdout, /valid — 0 error\(s\)/);
  await rm(dir, { recursive: true, force: true });
});

test('init wires --goal and --task into the packet', async () => {
  const dir = await project();
  await run(['plan', 'init', 'ask-anchors', '--goal', 'Add timestamped questions.', '--task', 'https://linear.app/x/SPL-14', '--outcome', 'Reviewers can ask at a moment.'], dir);
  const plan = await readPlan(dir);
  assert.equal(plan.goal, 'Add timestamped questions.');
  assert.equal(plan.outcome, 'Reviewers can ask at a moment.');
  assert.equal(plan.links.task, 'https://linear.app/x/SPL-14');
  await rm(dir, { recursive: true, force: true });
});

// links.commit is what evidence permalinks pin to, so it has to be picked up
// from the checkout: no agent fills it in by hand.
test('init picks up repo, branch and commit from the checkout', async () => {
  const dir = await project({ git: true });
  await run(['plan', 'init', 'ask-anchors', '--goal', 'Add timestamped questions.'], dir);
  const plan = await readPlan(dir);
  assert.equal(plan.links.repo, 'acme/widgets');
  assert.match(plan.links.commit, /^[0-9a-f]{40}$/);
  assert.ok(plan.links.branch);
  await rm(dir, { recursive: true, force: true });
});

test('init outside a checkout still writes a valid packet', async () => {
  const dir = await project();
  await run(['plan', 'init', 'ask-anchors', '--goal', 'Add timestamped questions.'], dir);
  const plan = await readPlan(dir);
  assert.equal(plan.links.repo, null);
  assert.equal(plan.links.commit, null);
  assert.equal((await run(['plan', 'validate', 'spool/ask-anchors'], dir)).code, PLAN_EXIT.ok);
  await rm(dir, { recursive: true, force: true });
});

test('init names the missing flag when --goal is absent', async () => {
  const dir = await project();
  const res = await run(['plan', 'init', 'ask-anchors'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /--goal is required/);
  assert.equal(existsSync(join(dir, 'spool', 'ask-anchors', 'plan.json')), false);
  await rm(dir, { recursive: true, force: true });
});

test('init rejects a slug that is not kebab-case', async () => {
  const dir = await project();
  const res = await run(['plan', 'init', 'Ask Anchors', '--goal', 'g'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /kebab-case/);
  await rm(dir, { recursive: true, force: true });
});

test('init never overwrites an authored packet without --force', async () => {
  const dir = await project();
  await run(['plan', 'init', 'ask-anchors', '--goal', 'First goal.'], dir);
  const res = await run(['plan', 'init', 'ask-anchors', '--goal', 'Second goal.'], dir);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /already exists/);
  assert.equal((await readPlan(dir)).goal, 'First goal.');

  const forced = await run(['plan', 'init', 'ask-anchors', '--goal', 'Second goal.', '--force'], dir);
  assert.equal(forced.code, 0, forced.stderr);
  assert.equal((await readPlan(dir)).goal, 'Second goal.');
  await rm(dir, { recursive: true, force: true });
});

test('--dir writes the packet outside the spool/<slug> convention', async () => {
  const dir = await project();
  const res = await run(['plan', 'init', 'ask-anchors', '--goal', 'g', '--dir', 'packets/one'], dir);
  assert.equal(res.code, 0, res.stderr);
  assert.ok(existsSync(join(dir, 'packets', 'one', 'plan.json')));
  await rm(dir, { recursive: true, force: true });
});

// --- template placeholders --------------------------------------------------

// The scaffold validates, but every unwritten field says so. Structure alone
// cannot catch "the exact action the reviewer must take": it is well-formed and
// worthless, and it would otherwise reach a reviewer.
test('a scaffolded packet warns once per unwritten field', async () => {
  const dir = await project();
  await run(['plan', 'init', 'ask-anchors', '--goal', 'Add timestamped questions.'], dir);
  const packet = await readPlanPacket(join(dir, 'spool', 'ask-anchors'));
  assert.equal(packet.ok, true);
  const unedited = packet.warnings.filter((w) => w.code === 'unedited-template').map((w) => w.path);
  assert.ok(unedited.includes('plan.json:outcome'), JSON.stringify(unedited));
  assert.ok(unedited.includes('plan.json:decision.prompt'));
  assert.ok(unedited.includes('plan.json:risks[0]'));
  assert.ok(unedited.includes('evidence.json:items[0].ref'));
  // --goal was supplied, so it is written, not a placeholder.
  assert.ok(!unedited.includes('plan.json:goal'));
  await rm(dir, { recursive: true, force: true });
});

test('--strict fails a packet that is still the template', async () => {
  const dir = await project();
  await run(['plan', 'init', 'ask-anchors', '--goal', 'Add timestamped questions.'], dir);
  const res = await run(['plan', 'validate', 'spool/ask-anchors', '--strict'], dir);
  assert.equal(res.code, PLAN_EXIT.invalid);
  assert.match(res.stdout, /invalid —/);
  await rm(dir, { recursive: true, force: true });
});

// --- spool plan validate ----------------------------------------------------

async function workdir(files) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-planval-'));
  for (const [name, body] of Object.entries(files)) await writeFile(join(dir, name), body);
  return dir;
}

test('validate exits 1 and names every broken field', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-missing-required.json') });
  const res = await run(['plan', 'validate', dir]);
  assert.equal(res.code, PLAN_EXIT.invalid);
  assert.match(res.stdout, /error\s+plan\.json:outcome/);
  assert.match(res.stdout, /error\s+plan\.json:risks/);
  assert.match(res.stdout, /invalid — 3 error\(s\)/);
  await rm(dir, { recursive: true, force: true });
});

test('validate exits 2 when the workdir is not a Plan Spool', async () => {
  const dir = await workdir({});
  const res = await run(['plan', 'validate', dir]);
  assert.equal(res.code, PLAN_EXIT.absent);
  assert.match(res.stdout, /not a Plan Spool/);
  assert.match(res.stdout, /spool plan init/);
  await rm(dir, { recursive: true, force: true });
});

test('validate defaults to the current directory', async () => {
  const dir = await workdir({ 'plan.json': fixture('valid-minimal.json') });
  const res = await run(['plan', 'validate'], dir);
  assert.equal(res.code, PLAN_EXIT.ok, res.stdout);
  await rm(dir, { recursive: true, force: true });
});

test('--json emits the documented diagnostics document', async () => {
  const dir = await workdir({
    'plan.json': fixture('valid-full.json'),
    'evidence.json': fixture('valid-full.evidence.json'),
  });
  const res = await run(['plan', 'validate', dir, '--json']);
  assert.equal(res.code, PLAN_EXIT.ok, res.stdout);
  const report = JSON.parse(res.stdout);
  assert.deepEqual(Object.keys(report).sort(), ['dir', 'errors', 'exit', 'ok', 'present', 'summary', 'warnings']);
  assert.equal(report.ok, true);
  assert.equal(report.present, true);
  assert.equal(report.exit, PLAN_EXIT.ok);
  assert.equal(report.summary.version, 1);
  assert.equal(report.summary.decision.type, 'selection');
  assert.equal(report.summary.evidence, 2);
  assert.ok(Array.isArray(report.summary.approach));
  await rm(dir, { recursive: true, force: true });
});

test('--json on an invalid packet keeps the exit code and carries the paths', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-approach.json') });
  const res = await run(['plan', 'validate', dir, '--json']);
  assert.equal(res.code, PLAN_EXIT.invalid);
  const report = JSON.parse(res.stdout);
  assert.equal(report.ok, false);
  assert.equal(report.exit, PLAN_EXIT.invalid);
  assert.ok(report.errors.every((e) => e.path && e.code && e.message));
  assert.ok(report.errors.some((e) => e.path === 'plan.json:approach[0].id'));
  await rm(dir, { recursive: true, force: true });
});

test('--json stays parseable when plan.json is not JSON at all', async () => {
  const dir = await workdir({ 'plan.json': '{ "version": 1, ' });
  const res = await run(['plan', 'validate', dir, '--json']);
  assert.equal(res.code, PLAN_EXIT.invalid);
  const report = JSON.parse(res.stdout);
  assert.equal(report.summary, null);
  assert.equal(report.errors[0].code, 'invalid-json');
  await rm(dir, { recursive: true, force: true });
});

// Validation runs on every build, so it may never be the slow part. The budget
// is one second including node startup; the check itself is pure and much faster.
test('validation is fast enough to run on every build', async () => {
  const dir = await workdir({
    'plan.json': fixture('valid-full.json'),
    'evidence.json': fixture('valid-full.evidence.json'),
  });
  const t0 = Date.now();
  await readPlanPacket(dir);
  assert.ok(Date.now() - t0 < 100, `packet validation took ${Date.now() - t0}ms`);

  const t1 = Date.now();
  await run(['plan', 'validate', dir]);
  assert.ok(Date.now() - t1 < 1000, `spool plan validate took ${Date.now() - t1}ms`);
  await rm(dir, { recursive: true, force: true });
});

// --- spool plan build -------------------------------------------------------

test('build refuses an invalid packet before it records or narrates', async () => {
  const dir = await workdir({ 'plan.json': fixture('invalid-decision.json') });
  const res = await run(['plan', 'build', dir]);
  assert.equal(res.code, PLAN_EXIT.invalid);
  assert.match(res.stdout, /decision\.options/);
  assert.match(res.stderr, /nothing was recorded/);
  assert.equal(existsSync(join(dir, 'video.webm')), false);
  await rm(dir, { recursive: true, force: true });
});

test('build refuses a workdir with no plan at all', async () => {
  const dir = await workdir({});
  const res = await run(['plan', 'build', dir]);
  assert.equal(res.code, PLAN_EXIT.absent);
  assert.match(res.stdout, /not a Plan Spool/);
  await rm(dir, { recursive: true, force: true });
});

// A valid packet hands off to the ordinary pipeline. Recording needs a browser,
// so the reachable proof is that it gets past the gate and asks for the steps.
test('build hands a valid packet to the existing pipeline', async () => {
  const dir = await workdir({ 'plan.json': fixture('valid-minimal.json') });
  const res = await run(['plan', 'build', dir]);
  assert.match(res.stdout, /valid — 0 error\(s\)/);
  assert.match(res.stderr, /No steps\.mjs/);
  assert.doesNotMatch(res.stderr, /nothing was recorded/);
  await rm(dir, { recursive: true, force: true });
});

// --- exit-code helper -------------------------------------------------------

test('the exit code and the report agree on every outcome', async () => {
  const absent = { present: false, ok: true, plan: null, evidence: null, errors: [], warnings: [] };
  const warned = { present: true, ok: true, plan: {}, evidence: null, errors: [], warnings: [{ path: 'p', code: 'c', message: 'm' }] };
  const broken = { present: true, ok: false, plan: {}, evidence: null, errors: [{ path: 'p', code: 'c', message: 'm' }], warnings: [] };
  assert.equal(planExitCode(absent), PLAN_EXIT.absent);
  assert.equal(planExitCode(warned), PLAN_EXIT.ok);
  assert.equal(planExitCode(warned, { strict: true }), PLAN_EXIT.invalid);
  assert.equal(planExitCode(broken), PLAN_EXIT.invalid);
  assert.equal(planReportJson(warned, { dir: '/x' }).ok, true);
  assert.equal(planReportJson(warned, { dir: '/x', strict: true }).ok, false);
});
