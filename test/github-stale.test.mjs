// Stale-plan detection (roadmap R5.2): the verdict is a pure function of facts read
// from a checkout, so the pure part is asserted directly and the reading part against
// a real throwaway repository.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_STALE_TOLERANCE, githubConfig } from '../src/github/config.mjs';
import { classifyStale, evidencePaths, readLocalSource, readRemoteSource, staleSummary } from '../src/github/stale.mjs';

const exec = promisify(execFile);

/** A repository with one commit, and a helper to add more. */
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-stale-'));
  const git = (...args) => exec('git', ['-C', dir, ...args]);
  await git('init', '-q', '-b', 'work');
  await git('config', 'user.email', 'test@example.test');
  await git('config', 'user.name', 'Test');
  const commit = async (file, text) => {
    await writeFile(join(dir, file), text);
    await git('add', '-A');
    await git('commit', '-qm', `touch ${file}`);
    const { stdout } = await git('rev-parse', 'HEAD');
    return stdout.trim();
  };
  const first = await commit('a.txt', 'one\n');
  return { dir, git, commit, first };
}

const source = (over = {}) => ({
  available: true,
  origin: 'local',
  commit: '0123456789abcdef',
  branch: 'work',
  ref: 'work',
  moved: 0,
  ancestor: true,
  ageDays: 1,
  changed: [],
  ...over,
});

// --- the verdict ------------------------------------------------------------

test('a branch that has not moved past the plan is current', () => {
  const verdict = classifyStale(source());
  assert.equal(verdict.status, 'fresh');
  assert.equal(verdict.stale, false);
  assert.match(staleSummary(verdict), /plan is current/);
});

test('movement inside the tolerance is not staleness; movement past it is', () => {
  assert.equal(classifyStale(source({ moved: 10 }), { commits: 10, days: null }).status, 'fresh');
  const verdict = classifyStale(source({ moved: 11 }), { commits: 10, days: null });
  assert.equal(verdict.status, 'stale');
  assert.deepEqual(verdict.why.map((w) => w.code), ['branch-moved']);
  assert.match(verdict.why[0].detail, /11 commit\(s\) past/);
});

test('a rewritten history and a changed cited file are stale at any tolerance', () => {
  const loose = { commits: 1000, days: 1000 };
  assert.deepEqual(classifyStale(source({ ancestor: false }), loose).why.map((w) => w.code), ['history-rewritten']);
  const changed = classifyStale(source({ changed: ['web/lib/plans.ts'] }), loose);
  assert.deepEqual(changed.why.map((w) => w.code), ['evidence-changed']);
  assert.match(changed.why[0].detail, /web\/lib\/plans\.ts/);
});

test('an old plan is stale even on a branch nobody touched', () => {
  const verdict = classifyStale(source({ ageDays: 30 }), { commits: 10, days: 14 });
  assert.deepEqual(verdict.why.map((w) => w.code), ['plan-aged']);
  // A team that switches the check off gets no age verdict at all.
  assert.equal(classifyStale(source({ ageDays: 30 }), { commits: 10, days: null }).status, 'fresh');
});

test('a plan that cannot be checked reads unknown, never current', () => {
  const verdict = classifyStale({ available: false, reason: 'unpinned', detail: 'links.commit is empty' });
  assert.equal(verdict.status, 'unknown');
  assert.equal(verdict.stale, false);
  assert.deepEqual(verdict.why.map((w) => w.code), ['unpinned']);
  assert.match(staleSummary(verdict), /unknown/);
});

// --- reading the facts ------------------------------------------------------

test('a plan pinned to the tip of its own branch is current', async () => {
  const { dir, first } = await repo();
  const verdict = classifyStale(await readLocalSource({ cwd: dir, links: { branch: 'work', commit: first } }));
  assert.equal(verdict.status, 'fresh', JSON.stringify(verdict.why));
  assert.equal(verdict.source.moved, 0);
  assert.equal(verdict.source.ancestor, true);
});

test('every commit past the plan is counted, and a cited file that changed is named', async () => {
  const { dir, commit, first } = await repo();
  await commit('a.txt', 'two\n');
  await commit('b.txt', 'new\n');

  const links = { branch: 'work', commit: first };
  const plain = await readLocalSource({ cwd: dir, links });
  assert.equal(plain.moved, 2);
  assert.deepEqual(plain.changed, [], 'with no cited files there is nothing to compare');

  const cited = await readLocalSource({ cwd: dir, links, evidencePaths: ['a.txt', 'never-touched.txt'] });
  assert.deepEqual(cited.changed, ['a.txt']);
  assert.equal(classifyStale(cited, { commits: 100, days: null }).status, 'stale');
});

test('a rewritten branch is detected, not silently counted as movement', async () => {
  const { dir, git, commit, first } = await repo();
  await commit('a.txt', 'two\n');
  await git('reset', '-q', '--hard', first);
  await commit('a.txt', 'different\n');

  const dropped = (await exec('git', ['-C', dir, 'rev-parse', 'HEAD@{2}'])).stdout.trim();
  const verdict = classifyStale(await readLocalSource({ cwd: dir, links: { branch: 'work', commit: dropped } }));
  assert.equal(verdict.status, 'stale');
  assert.ok(verdict.why.some((w) => w.code === 'history-rewritten'), JSON.stringify(verdict.why));
});

test('a packet with no pinned commit, and a directory with no repository, both read unknown', async () => {
  const { dir, first } = await repo();
  assert.equal((await readLocalSource({ cwd: dir, links: {} })).reason, 'unpinned');
  assert.equal((await readLocalSource({ cwd: dir, links: { commit: 'f'.repeat(40) } })).reason, 'commit-unknown');
  const outside = await mkdtemp(join(tmpdir(), 'spool-norepo-'));
  assert.equal((await readLocalSource({ cwd: outside, links: { commit: first } })).reason, 'no-repo');
});

test('a branch the checkout does not have falls back to HEAD, and says which it used', async () => {
  const { dir, first } = await repo();
  const local = await readLocalSource({ cwd: dir, links: { branch: 'someone-elses-branch', commit: first } });
  assert.equal(local.available, true);
  assert.match(local.ref, /HEAD \(someone-elses-branch is not in this checkout\)/);
});

// --- the GitHub fallback ----------------------------------------------------

test('a commit this checkout does not have is compared by GitHub instead', async () => {
  const local = { available: false, reason: 'commit-unknown', commit: 'abc1234', origin: 'local', detail: 'not here' };
  const compare = async (_gh, args) => {
    assert.deepEqual(args, { owner: 'acme', name: 'coach', base: 'abc1234', head: 'work' });
    return { status: 'ahead', ahead: 14, behind: 0 };
  };
  const source = await readRemoteSource(local, { gh: {}, links: { repo: 'acme/coach', branch: 'work' }, compare });
  assert.equal(source.origin, 'github');
  assert.equal(source.moved, 14);
  assert.equal(classifyStale(source, { commits: 10, days: null }).status, 'stale');
});

test('GitHub calling a branch diverged is a rewritten history', async () => {
  const local = { available: false, reason: 'commit-unknown', commit: 'abc1234', origin: 'local', detail: 'not here' };
  const compare = async () => ({ status: 'diverged', ahead: 2, behind: 3 });
  const source = await readRemoteSource(local, { gh: {}, links: { repo: 'acme/coach', branch: 'work' }, compare });
  assert.equal(source.ancestor, false);
  assert.equal(classifyStale(source).status, 'stale');
});

test('a GitHub failure degrades to the local answer rather than failing the check', async () => {
  const local = { available: false, reason: 'commit-unknown', commit: 'abc1234', origin: 'local', detail: 'not here' };
  const compare = async () => {
    throw new Error('HTTP 403: API rate limit exceeded');
  };
  const source = await readRemoteSource(local, { gh: {}, links: { repo: 'acme/coach', branch: 'work' }, compare });
  assert.equal(source.available, false);
  assert.equal(classifyStale(source).status, 'unknown');
  assert.match(source.detail, /rate limit/);
});

test('a checkout that answered is never asked of GitHub', async () => {
  const local = source();
  const compare = async () => assert.fail('the API must not be called when git could answer');
  assert.deepEqual(await readRemoteSource(local, { gh: {}, links: { repo: 'acme/coach' }, compare }), local);
});

// --- what a repository configures -------------------------------------------

test('commenting is off until a repository turns it on, and the tolerance has a default', () => {
  const bare = githubConfig({});
  assert.equal(bare.comment, false);
  assert.equal(bare.configured, false);
  assert.deepEqual(bare.stale, DEFAULT_STALE_TOLERANCE);

  const on = githubConfig({ github: { comment: true, stale: { commits: 3 } } });
  assert.equal(on.comment, true);
  assert.deepEqual(on.stale, { commits: 3, days: DEFAULT_STALE_TOLERANCE.days });

  assert.deepEqual(githubConfig({ github: { stale: { days: null } } }).stale.days, null);
});

test('a malformed github block is an error, not a silent default', () => {
  assert.throws(() => githubConfig({ github: { comment: 'yes' } }), /comment must be true or false/);
  assert.throws(() => githubConfig({ github: { stale: { commits: -1 } } }), /non-negative integer/);
  assert.throws(() => githubConfig({ github: [] }), /must be an object/);
});

test('only repository-relative files a packet cites are compared', () => {
  const paths = evidencePaths({
    items: [
      { id: 'a', kind: 'file', ref: 'web/lib/plans.ts' },
      { id: 'b', kind: 'image', ref: 'docs/shot.png' },
      { id: 'c', kind: 'url', ref: 'https://example.test' },
      { id: 'd', kind: 'file', ref: 'secret.ts', visibility: 'private' },
      { id: 'e', kind: 'file', ref: '../outside.ts' },
      { id: 'f', kind: 'file', ref: '--upload-pack=evil' },
      { id: 'g', kind: 'file', ref: 'web/lib/plans.ts' },
    ],
  });
  assert.deepEqual(paths, ['web/lib/plans.ts', 'docs/shot.png']);
});
