// Policy resolution and the high-risk definition (roadmap R4.3, FR-17).
//
// The gate's promise is that anyone can reproduce its verdict from the repository, so
// these are the tests that hold the resolution rules still: what the default is, which
// source wins, and what counts as high risk when the CLI cannot tell.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_FILE,
  DEFAULT_HIGH_RISK_PATHS,
  DEFAULT_POLICY,
  POLICIES,
  POLICY_RANK,
  classifyRisk,
  findGateConfig,
  globToRegExp,
  highRiskDefinition,
  loadGateConfig,
  matchesGlob,
  resolveGatePolicy,
} from '../src/gate/policy.mjs';

const project = async () => mkdtemp(join(tmpdir(), 'spool-gate-'));

// --- the vocabulary ---------------------------------------------------------

test('the four policies are ordered by how much they block', () => {
  assert.deepEqual(POLICIES, ['off', 'advisory', 'high_risk_required', 'required']);
  assert.ok(POLICY_RANK.off < POLICY_RANK.advisory);
  assert.ok(POLICY_RANK.advisory < POLICY_RANK.high_risk_required);
  assert.ok(POLICY_RANK.high_risk_required < POLICY_RANK.required);
});

// --- FR-17 ------------------------------------------------------------------

test('an unconfigured project resolves to advisory', () => {
  const resolved = resolveGatePolicy({});
  assert.equal(resolved.policy, DEFAULT_POLICY);
  assert.equal(resolved.policy, 'advisory');
  assert.equal(resolved.via, 'default');
  assert.deepEqual(resolved.sources, []);
});

test('the project config overrides the built-in default', () => {
  const resolved = resolveGatePolicy({ repo: 'required' });
  assert.equal(resolved.policy, 'required');
  assert.equal(resolved.via, 'repo');
});

test('a flag or the environment can raise the policy but never lower it', () => {
  // Raising is allowed: a developer may hold themselves to more than the team asks.
  assert.equal(resolveGatePolicy({ flag: 'required', repo: 'advisory' }).policy, 'required');
  assert.equal(resolveGatePolicy({ env: 'high_risk_required', repo: 'advisory' }).policy, 'high_risk_required');
  // Lowering is not: a gate a local flag can switch off is not a gate. `--bypass`
  // (audited) is the one way past a policy.
  assert.equal(resolveGatePolicy({ flag: 'off', repo: 'required' }).policy, 'required');
  assert.equal(resolveGatePolicy({ env: 'advisory', repo: 'required' }).policy, 'required');
  assert.equal(resolveGatePolicy({ flag: 'off', prefs: 'advisory' }).policy, 'advisory');
});

test('resolution reports every configured source, strongest first winner', () => {
  const resolved = resolveGatePolicy({ flag: 'advisory', env: 'off', repo: 'required', prefs: 'advisory' });
  assert.equal(resolved.policy, 'required');
  assert.equal(resolved.via, 'repo');
  assert.deepEqual(
    resolved.sources.map((s) => `${s.source}=${s.value}`),
    ['flag=advisory', 'env=off', 'repo=required', 'prefs=advisory']
  );
});

test('an unknown policy value is an error, never a silent default', () => {
  assert.throws(() => resolveGatePolicy({ repo: 'strict' }), /policy must be one of/);
});

test('empty and absent sources are ignored', () => {
  assert.equal(resolveGatePolicy({ flag: '', env: null, repo: undefined }).via, 'default');
});

// --- the config file --------------------------------------------------------

test('the config is found at or above the working directory, never above the repo root', async () => {
  const dir = await project();
  await mkdir(join(dir, '.git'), { recursive: true });
  await mkdir(join(dir, 'src', 'deep'), { recursive: true });
  assert.equal(findGateConfig(join(dir, 'src', 'deep')), null);

  await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ policy: 'required' }));
  assert.equal(findGateConfig(join(dir, 'src', 'deep')), join(dir, CONFIG_FILE));

  const { config, path } = await loadGateConfig(join(dir, 'src'));
  assert.equal(path, join(dir, CONFIG_FILE));
  assert.equal(config.policy, 'required');
});

test('a malformed or invalid config fails loudly', async () => {
  const dir = await project();
  await writeFile(join(dir, CONFIG_FILE), '{ not json');
  await assert.rejects(loadGateConfig(dir), /not valid JSON/);

  await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ policy: 'strict' }));
  await assert.rejects(loadGateConfig(dir), /policy must be one of/);
});

// --- globs ------------------------------------------------------------------

test('** crosses directories and * does not', () => {
  assert.ok(globToRegExp('**/auth/**').test('web/lib/auth/session.ts'));
  assert.ok(globToRegExp('**/auth/**').test('auth/session.ts'));
  assert.ok(!globToRegExp('**/auth/**').test('web/lib/authz/session.ts'));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/nested/a.ts'));
  assert.ok(globToRegExp('**/*.sql').test('db/0001_init.sql'));
  assert.ok(globToRegExp('**/.env*').test('web/.env.local'));
  assert.ok(matchesGlob('.github/workflows/test.yml', DEFAULT_HIGH_RISK_PATHS));
});

// --- high risk --------------------------------------------------------------

test('the built-in high-risk definition applies until a team writes its own', () => {
  assert.equal(highRiskDefinition({}).configured, false);
  assert.deepEqual(highRiskDefinition({}).paths, DEFAULT_HIGH_RISK_PATHS);
  const own = highRiskDefinition({ highRisk: { paths: ['services/pay/**'], labels: ['Risky'] } });
  assert.equal(own.configured, true);
  assert.deepEqual(own.paths, ['services/pay/**']);
  assert.deepEqual(own.labels, ['risky']);
});

test('paths, labels and categories each make a change high risk', () => {
  const config = { highRisk: { paths: ['services/pay/**'], labels: ['security'], categories: ['migration'] } };
  assert.equal(classifyRisk({ config, paths: ['README.md'] }).highRisk, false);
  assert.deepEqual(classifyRisk({ config, paths: ['services/pay/charge.ts'] }).why, ['path:services/pay/charge.ts']);
  assert.deepEqual(classifyRisk({ config, paths: [], labels: ['Security'] }).why, ['label:Security']);
  assert.deepEqual(classifyRisk({ config, paths: [], categories: ['migration'] }).why, ['category:migration']);
});

test('a change the CLI cannot classify is high risk, not safe', () => {
  // Fail closed: no evidence about what the work touches is not evidence that the work
  // is harmless. An agent declares its files with --paths.
  const unknown = classifyRisk({ config: {}, paths: [], pathsKnown: false });
  assert.equal(unknown.highRisk, true);
  assert.equal(unknown.unknown, true);
  assert.deepEqual(unknown.why, ['paths_unknown']);
  // Labels the caller did supply are evidence, so a team whose definition is
  // label-based still gets a real answer when the file list is empty.
  const labelled = classifyRisk({ config: { highRisk: { labels: ['x'] } }, paths: [], labels: ['y'], pathsKnown: false });
  assert.equal(labelled.highRisk, false);
  assert.equal(labelled.unknown, false);
});
