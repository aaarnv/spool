import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_COMMITS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_TOTAL_BYTES,
  capFiles,
  fetchPullRequest,
  renderDiff,
} from '../src/recap/pr.mjs';

const file = (path, patch, extra = {}) => ({ filename: path, status: 'modified', additions: 1, deletions: 0, patch, ...extra });
const hunk = (lines) => Array.from({ length: lines }, (_, i) => `+line ${i}`).join('\n');

test('capFiles keeps a small change whole', () => {
  const { files, truncation } = capFiles([file('a.ts', '@@ -1 +1 @@\n+one'), file('b.ts', '@@ -1 +1 @@\n+two')]);
  assert.equal(files.length, 2);
  assert.equal(files[0].patch, '@@ -1 +1 @@\n+one');
  assert.deepEqual(truncation, []);
});

test('capFiles cuts one long patch on a line boundary and says so', () => {
  const long = hunk(2000);
  const { files, truncation } = capFiles([file('big.ts', long)]);
  const kept = Buffer.from(files[0].patch, 'utf8').length;
  assert.ok(kept <= MAX_FILE_BYTES, `kept ${kept} bytes`);
  assert.ok(files[0].patch.endsWith('9') || /line \d+$/.test(files[0].patch), 'ends on a whole line');
  assert.ok(!files[0].patch.endsWith('\n'), 'no dangling newline');
  assert.ok(files[0].patchTruncated > 0);
  assert.deepEqual(truncation, ['1 file diff(s) were shortened to fit']);
});

test('capFiles drops files past the file cap and counts them', () => {
  const many = Array.from({ length: MAX_FILES + 7 }, (_, i) => file(`f${i}.ts`, '@@\n+x'));
  const { files, truncation } = capFiles(many);
  assert.equal(files.length, MAX_FILES);
  assert.ok(truncation.includes('7 more changed file(s) are not shown'));
});

test('capFiles spends the total budget in diff order, not on the first file', () => {
  // Three files that each want the per-file cap; the total cap must stop the third,
  // and the first two must still arrive whole rather than one file taking everything.
  const wide = Array.from({ length: 12 }, (_, i) => file(`f${i}.ts`, hunk(2000)));
  const { files } = capFiles(wide);
  const total = files.reduce((n, f) => n + Buffer.from(f.patch, 'utf8').length, 0);
  assert.ok(total <= MAX_TOTAL_BYTES, `total ${total}`);
  assert.equal(files.length, 12, 'every file is still listed, with its counts');
  assert.ok(files[0].patch.length > 0, 'the first file has a diff');
  assert.ok(files.at(-1).patchOmitted, 'the last file is listed with no diff');
  assert.deepEqual(files.map((f) => f.path), wide.map((f) => f.filename), 'order is preserved');
});

test('capFiles keeps a file with no patch (a rename, a binary)', () => {
  const { files } = capFiles([{ filename: 'logo.png', status: 'added', additions: 0, deletions: 0 }]);
  assert.deepEqual(files, [{ path: 'logo.png', status: 'added', additions: 0, deletions: 0, patch: '' }]);
});

test('capFiles ignores an entry with no filename', () => {
  assert.equal(capFiles([{ patch: '@@\n+x' }, file('a.ts', '@@\n+y')]).files.length, 1);
});

// ---------------------------------------------------------------------------

function githubDouble({ pr, files = [], commits = [], fail = [] }) {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    const path = url.replace('https://api.github.com', '');
    if (fail.some((f) => path.includes(f))) return { ok: false, status: 500 };
    if (path.endsWith('/files?per_page=100')) return { ok: true, json: async () => files };
    if (path.endsWith('/commits?per_page=100')) return { ok: true, json: async () => commits };
    return { ok: true, json: async () => pr };
  };
  return { fetchImpl, seen };
}

const PR = {
  title: 'Cap the recap diff',
  body: 'The worker used to send the whole diff.',
  user: { login: 'octocat' },
  html_url: 'https://github.com/spoolkit/spool/pull/12',
  base: { ref: 'main' },
  merge_commit_sha: 'deadbeef',
  merged_at: '2026-08-24T00:00:00Z',
  additions: 40,
  deletions: 3,
  changed_files: 2,
};

test('fetchPullRequest reduces three reads to one recap input', async () => {
  const { fetchImpl, seen } = githubDouble({
    pr: PR,
    files: [file('src/recap/pr.mjs', '@@\n+cap'), file('worker/index.mjs', '@@\n+call')],
    commits: [{ commit: { message: 'cap the diff\n\nlong body' } }, { commit: { message: 'wire the worker' } }],
  });
  const out = await fetchPullRequest({ owner: 'spoolkit', repo: 'spool', number: 12, token: 't', fetchImpl });

  assert.equal(out.repo, 'spoolkit/spool');
  assert.equal(out.number, 12);
  assert.equal(out.title, 'Cap the recap diff');
  assert.equal(out.author, 'octocat');
  assert.equal(out.baseRef, 'main');
  assert.equal(out.additions, 40);
  assert.deepEqual(out.commits, ['cap the diff', 'wire the worker'], 'subject lines only');
  assert.equal(out.files.length, 2);
  assert.deepEqual(out.truncation, []);
  assert.equal(seen.length, 3);
});

test('fetchPullRequest still returns a recap when files and commits fail', async () => {
  const { fetchImpl } = githubDouble({ pr: PR, fail: ['/files', '/commits'] });
  const out = await fetchPullRequest({ owner: 'spoolkit', repo: 'spool', number: 12, token: 't', fetchImpl });
  assert.deepEqual(out.files, []);
  assert.deepEqual(out.commits, []);
  assert.equal(out.title, 'Cap the recap diff');
});

test('fetchPullRequest throws when the pull request itself cannot be read', async () => {
  const { fetchImpl } = githubDouble({ pr: PR, fail: ['/pulls/12'] });
  await assert.rejects(
    () => fetchPullRequest({ owner: 'spoolkit', repo: 'spool', number: 12, token: 't', fetchImpl }),
    /failed: 500/
  );
});

test('fetchPullRequest caps the commit list and says how many it dropped', async () => {
  const commits = Array.from({ length: MAX_COMMITS + 4 }, (_, i) => ({ commit: { message: `commit ${i}` } }));
  const { fetchImpl } = githubDouble({ pr: PR, commits });
  const out = await fetchPullRequest({ owner: 'spoolkit', repo: 'spool', number: 12, token: 't', fetchImpl });
  assert.equal(out.commits.length, MAX_COMMITS);
  assert.ok(out.truncation.includes('4 more commit(s) are not shown'));
});

test('fetchPullRequest sends the installation token and the pinned api version', async () => {
  let headers;
  const fetchImpl = async (_url, init) => {
    headers ??= init.headers;
    return { ok: true, json: async () => PR };
  };
  await fetchPullRequest({ owner: 'spoolkit', repo: 'spool', number: 12, token: 'ghs_secret', fetchImpl });
  assert.equal(headers.authorization, 'Bearer ghs_secret');
  assert.equal(headers['x-github-api-version'], '2022-11-28');
});

test('renderDiff puts the truncation notice where the model reads it', () => {
  const text = renderDiff({
    repo: 'spoolkit/spool',
    number: 12,
    title: 'Cap the recap diff',
    body: 'why',
    author: 'octocat',
    baseRef: 'main',
    additions: 40,
    deletions: 3,
    changedFiles: 2,
    commits: ['cap the diff'],
    files: [{ path: 'a.ts', status: 'modified', additions: 1, deletions: 0, patch: '@@\n+x', patchTruncated: 90 }],
    truncation: ['3 more changed file(s) are not shown'],
  });
  assert.match(text, /PULL REQUEST spoolkit\/spool#12: Cap the recap diff/);
  assert.match(text, /--- a\.ts \(modified, \+1 -0\)/);
  assert.match(text, /… 90 more bytes of this diff are not shown/);
  assert.match(text, /WHAT YOU ARE NOT SEEING:\n- 3 more changed file\(s\) are not shown/);
});
