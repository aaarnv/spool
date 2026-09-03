// Who comments on the pull request (roadmap B3). The GitHub App is the default writer
// and `gh` is the fallback, so what matters here is that the CLI can always tell which
// one is going to write — including against a host that has never heard of the route.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

import { announceViaApp } from '../src/publish/publish.mjs';

const withFetch = async (impl, run) => {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await run();
  } finally {
    globalThis.fetch = real;
  }
};

const json = (status, data) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

test('the App comment comes back as what it did, so the CLI knows not to post again', async () => {
  const calls = [];
  const comment = await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), method: init?.method, auth: init?.headers?.authorization });
      return json(200, { id: 's1', comment: { posted: true, action: 'created', url: 'https://github.com/o/r/pull/12#issuecomment-1' } });
    },
    () => announceViaApp({ host: 'https://spool.test', token: 'tok', id: 's1' })
  );

  assert.deepEqual(calls, [
    { url: 'https://spool.test/api/publish/s1/announce', method: 'POST', auth: 'Bearer tok' },
  ]);
  assert.equal(comment.posted, true);
  assert.equal(comment.action, 'created');
});

test('a re-publish reports the edit, which is still the App writing', async () => {
  const comment = await withFetch(
    async () => json(200, { id: 's1', comment: { posted: true, action: 'updated', url: null } }),
    () => announceViaApp({ host: 'https://spool.test', token: 'tok', id: 's1' })
  );
  assert.equal(comment.action, 'updated');
});

test('an App that cannot write says why, and the reason is the CLI cue to use gh', async () => {
  const comment = await withFetch(
    async () => json(200, { id: 's1', comment: { posted: false, action: 'none', reason: 'no_installation' } }),
    () => announceViaApp({ host: 'https://spool.test', token: 'tok', id: 's1' })
  );
  assert.equal(comment.posted, false);
  assert.equal(comment.reason, 'no_installation');
});

test('a host without the route, or no host at all, falls back rather than failing the publish', async () => {
  const old = await withFetch(
    async () => json(404, { error: 'not found' }),
    () => announceViaApp({ host: 'https://spool.test', token: 'tok', id: 's1' })
  );
  assert.equal(old, null);

  const down = await withFetch(
    async () => {
      throw new Error('ECONNREFUSED');
    },
    () => announceViaApp({ host: 'https://spool.test', token: 'tok', id: 's1' })
  );
  assert.equal(down, null);
});
