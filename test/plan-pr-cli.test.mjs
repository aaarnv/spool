// `spool plan pr` and `spool plan stale` end to end (roadmap R5.2).
//
// GitHub is mocked with a fake `gh` on PATH: the CLI shells out to `gh` exactly as it
// does in a real checkout, so what these tests assert is the whole path — the opt-in,
// the comment upsert, the write-back into the packet, and what happens when GitHub
// refuses. No network, no credentials, no repository of ours is touched.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'spool.mjs');

/**
 * A `gh` that answers from state.json and records every call. Failure is scripted by
 * `failApi`: a number of `gh api` calls to refuse before answering, persisted across
 * processes so a retry meets the same refusal.
 */
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.FAKE_GH_DIR;
const args = process.argv.slice(2);
const file = path.join(dir, 'state.json');
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const save = () => fs.writeFileSync(file, JSON.stringify(state, null, 2));
fs.appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const fail = (msg) => { process.stderr.write(msg + '\\n'); process.exit(1); };

if (args[0] === '--version') out('gh version 2.0.0 (fake)\\n');
if (args[0] === 'repo' && args[1] === 'view') out({ owner: { login: state.owner }, name: state.name });
if (args[0] === 'pr' && args[1] === 'view') {
  // A number resolves whatever the current branch is; without one, gh needs a pull
  // request for the branch it is on.
  const wanted = /^\\d+$/.test(args[2] || '') ? Number(args[2]) : null;
  if (wanted != null) {
    out({ number: wanted, url: 'https://github.com/' + state.owner + '/' + state.name + '/pull/' + wanted,
          state: 'OPEN', isDraft: false, headRefName: 'work', baseRefName: 'main', headRefOid: 'deadbeef' });
  }
  if (!state.pr) fail('no pull requests found for branch "work"');
  out(state.pr);
}
if (args[0] === 'api') {
  if (state.failApi > 0) { state.failApi--; save(); fail('gh: HTTP 403: API rate limit exceeded for user'); }
  const i = args.indexOf('-X');
  const method = i === -1 ? 'GET' : args[i + 1];
  const target = args.find((a, n) => n > 0 && !a.startsWith('-') && (i === -1 || n !== i + 1));
  const f = args[args.indexOf('-f') + 1] || '';
  const body = f.startsWith('body=') ? f.slice(5) : '';
  if (target === 'rate_limit') out({ resources: { core: { reset: Math.floor(Date.now() / 1000) + 999999 } } });
  if (method === 'GET') out(state.comments || []);
  if (method === 'POST') {
    const c = { id: 100 + (state.comments || []).length, body, html_url: 'https://github.test/c/' + (100 + (state.comments || []).length) };
    state.comments = [...(state.comments || []), c];
    save();
    out(c);
  }
  if (method === 'PATCH') {
    const id = Number(target.split('/').pop());
    state.comments = (state.comments || []).map((c) => (c.id === id ? { ...c, body } : c));
    save();
    out(state.comments.find((c) => c.id === id));
  }
}
fail('fake gh: unhandled ' + args.join(' '));
`;

const PR = {
  number: 57,
  url: 'https://github.com/acme/coach/pull/57',
  state: 'OPEN',
  isDraft: false,
  headRefName: 'work',
  baseRefName: 'main',
  headRefOid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
};

/** A checkout with one commit, one plan workdir, and a fake `gh` on PATH. */
async function project({ config = null, links = {}, state = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-planpr-'));
  const git = (...args) => exec('git', ['-C', dir, ...args]);
  await git('init', '-q', '-b', 'work');
  await git('config', 'user.email', 'test@example.test');
  await git('config', 'user.name', 'Test');
  await writeFile(join(dir, 'a.txt'), 'one\n');
  await git('add', '-A');
  await git('commit', '-qm', 'first');
  const commit = (await git('rev-parse', 'HEAD')).stdout.trim();

  const workdir = join(dir, 'spool', 'add-questions');
  await mkdir(workdir, { recursive: true });
  await writeFile(
    join(workdir, 'plan.json'),
    JSON.stringify(
      {
        version: 1,
        kind: 'plan',
        goal: 'Add timestamped questions.',
        outcome: 'A reviewer can ask a question against a moment.',
        approach: [{ id: 'data', summary: 'Add the records.' }],
        noAlternativesReason: 'the schema is fixed by the existing contract',
        risks: ['Anchors may drift.'],
        decision: { type: 'approval', prompt: 'Approve the anchored-comment approach.', options: ['approve', 'redirect'] },
        links: { repo: 'acme/coach', branch: 'work', commit, ...links },
      },
      null,
      2
    ) + '\n'
  );
  if (config) await writeFile(join(dir, 'spool.config.json'), JSON.stringify(config, null, 2));

  const bin = join(dir, 'bin');
  const ghDir = join(dir, 'ghstate');
  await mkdir(bin, { recursive: true });
  await mkdir(ghDir, { recursive: true });
  await writeFile(join(bin, 'gh'), FAKE_GH);
  await chmod(join(bin, 'gh'), 0o755);
  await writeFile(join(ghDir, 'state.json'), JSON.stringify({ owner: 'acme', name: 'coach', pr: PR, comments: [], failApi: 0, ...state }, null, 2));

  return { dir, workdir, commit, git, ghDir, bin };
}

async function run(p, args, env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd: p.dir,
      env: {
        ...process.env,
        PATH: `${p.bin}:${process.env.PATH}`,
        HOME: p.dir,
        FAKE_GH_DIR: p.ghDir,
        SPOOL_HOST: '',
        SPOOL_PUBLISH_TOKEN: '',
        SPOOL_PLAN: '',
      },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const ghState = async (p) => JSON.parse(await readFile(join(p.ghDir, 'state.json'), 'utf8'));
const calls = async (p) => {
  const log = join(p.ghDir, 'calls.log');
  if (!existsSync(log)) return [];
  return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};
const planLinks = async (p) => JSON.parse(await readFile(join(p.workdir, 'plan.json'), 'utf8')).links;

// --- opt-in -----------------------------------------------------------------

test('an unconfigured repository renders the comment and posts nothing', async () => {
  const p = await project();
  const out = await run(p, ['plan', 'pr']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /Plan spool — draft/);
  assert.match(out.stdout, /Approve the anchored-comment approach/);
  assert.match(out.stdout, /has not opted in/);
  assert.deepEqual((await ghState(p)).comments, [], 'nothing may be written before a repository opts in');
  assert.equal((await calls(p)).some((c) => c.includes('POST')), false);
});

test('--dry-run posts nothing even when the repository opted in', async () => {
  const p = await project({ config: { github: { comment: true } } });
  const out = await run(p, ['plan', 'pr', '--dry-run']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /dry run/);
  assert.deepEqual((await ghState(p)).comments, []);
});

// --- the comment ------------------------------------------------------------

test('an opted-in repository gets one comment, refreshed in place', async () => {
  const p = await project({ config: { github: { comment: true } } });

  const first = await run(p, ['plan', 'pr']);
  assert.equal(first.code, 0, first.stderr);
  assert.match(first.stdout, /created the plan comment on acme\/coach#57/);
  const after = await ghState(p);
  assert.equal(after.comments.length, 1);
  assert.match(after.comments[0].body, /<!-- spool-plan:add-questions -->/);
  assert.match(after.comments[0].body, /`work` @ `/, 'the comment names the source revision');

  // Nothing changed, so nothing is written and nobody is notified again.
  const second = await run(p, ['plan', 'pr', '--json']);
  assert.equal(JSON.parse(second.stdout).comment.action, 'unchanged');
  assert.equal((await ghState(p)).comments.length, 1);

  // The plan changed, so the same comment is updated rather than a second posted.
  const path = join(p.workdir, 'plan.json');
  const plan = JSON.parse(await readFile(path, 'utf8'));
  plan.goal = 'Add timestamped questions, anchored to the video.';
  await writeFile(path, JSON.stringify(plan, null, 2));
  const third = await run(p, ['plan', 'pr', '--json']);
  assert.equal(JSON.parse(third.stdout).comment.action, 'updated');
  const end = await ghState(p);
  assert.equal(end.comments.length, 1, 'a pull request carries one comment per plan');
  assert.match(end.comments[0].body, /anchored to the video/);
});

test('the first comment records the pull request in the packet', async () => {
  const p = await project({ config: { github: { comment: true } } });
  assert.equal((await planLinks(p)).pr, undefined);

  await run(p, ['plan', 'pr']);
  assert.equal((await planLinks(p)).pr, 'https://github.com/acme/coach/pull/57');

  // Written once: a packet that already names its pull request is left alone.
  const p2 = await project({ config: { github: { comment: true } }, links: { pr: 'acme/coach#57' } });
  await run(p2, ['plan', 'pr']);
  assert.equal((await planLinks(p2)).pr, 'acme/coach#57');
});

test('--dry-run touches neither the pull request nor the packet', async () => {
  const p = await project({ config: { github: { comment: true } } });
  await run(p, ['plan', 'pr', '--dry-run']);
  assert.equal((await planLinks(p)).pr, undefined);
  assert.equal((await ghState(p)).comments.length, 0);
});

test('links.pr names the pull request when the branch has none checked out', async () => {
  const p = await project({ config: { github: { comment: true } }, links: { pr: 'acme/coach#42' }, state: { pr: null } });
  const out = await run(p, ['plan', 'pr', '--json']);
  assert.equal(out.code, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).pr.number, 42);
});

test('with no pull request anywhere, the command says exactly what to do', async () => {
  const p = await project({ config: { github: { comment: true } }, state: { pr: null } });
  const out = await run(p, ['plan', 'pr']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /no pull request for this branch/);
  assert.match(out.stderr, /--pr <number>/);
});

test('a GitHub failure is reported, and never fails the caller', async () => {
  // Every `gh api` call refuses, including the retries.
  const p = await project({ config: { github: { comment: true } }, state: { failApi: 99 } });
  const out = await run(p, ['plan', 'pr']);
  assert.equal(out.code, 0, 'a comment that could not be posted must not fail a pipeline');
  assert.match(out.stderr, /GitHub could not be written to/);
  assert.match(out.stderr, /The plan is unaffected/);
  assert.deepEqual((await ghState(p)).comments, []);
});

test('a workdir that is not a plan spool is refused, not guessed at', async () => {
  const p = await project();
  const out = await run(p, ['plan', 'pr', 'a.txt']);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /no plan\.json/);
});

// --- the detector -----------------------------------------------------------

test('spool plan stale exits 0 while the branch is where the plan left it', async () => {
  const p = await project();
  const out = await run(p, ['plan', 'stale', '--offline']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /plan is current/);
});

test('spool plan stale exits 1 once the branch moves past the tolerance', async () => {
  const p = await project({ config: { github: { stale: { commits: 1 } } } });
  for (const text of ['two', 'three']) {
    await writeFile(join(p.dir, 'a.txt'), `${text}\n`);
    await p.git('commit', '-qam', text);
  }
  const out = await run(p, ['plan', 'stale', '--offline', '--json']);
  assert.equal(out.code, 1);
  const verdict = JSON.parse(out.stdout);
  assert.equal(verdict.status, 'stale');
  assert.equal(verdict.source.moved, 2);
  assert.deepEqual(verdict.why.map((w) => w.code), ['branch-moved']);
});

test('a plan with no pinned commit exits 2: unknown is not current', async () => {
  const p = await project({ links: { commit: null } });
  const out = await run(p, ['plan', 'stale', '--offline']);
  assert.equal(out.code, 2);
  assert.match(out.stdout, /unknown/);
});

test('the PR comment carries the staleness a reviewer would otherwise have to work out', async () => {
  const p = await project({ config: { github: { comment: true, stale: { commits: 0 } } } });
  await writeFile(join(p.dir, 'a.txt'), 'two\n');
  await p.git('commit', '-qam', 'move on');
  await run(p, ['plan', 'pr']);
  const [comment] = (await ghState(p)).comments;
  assert.match(comment.body, /\*\*Stale:\*\* work is 1 commit\(s\) past/);
});
