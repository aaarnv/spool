// The shared `gh` runner: what it retries, how long it waits, and what it refuses to
// wait for (roadmap R5.2, non-functional "rate-limit aware with backoff").
//
// The GitHub API is mocked by injecting the process runner, so these assertions are
// about the retry policy itself and cost no network and no wall-clock time.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

import { GhError, classifyFailure, createGh, httpStatus, listComments } from '../src/github/gh.mjs';

/** A `gh` that answers from a queue of scripted results, and records what it was asked. */
function fakeGh(results) {
  const calls = [];
  const queue = [...results];
  const exec = async (_cmd, args) => {
    calls.push(args);
    if (args[0] === '--version') return { stdout: 'gh version 2.0.0\n' };
    const next = queue.shift() ?? { stdout: '{}' };
    if (next.error) {
      const e = new Error(next.error.message || 'gh failed');
      Object.assign(e, next.error);
      throw e;
    }
    return { stdout: next.stdout ?? '' };
  };
  return { exec, calls };
}

/** A sleeper that records what it was asked to wait for, and waits for none of it. */
function fakeSleep() {
  const waits = [];
  return { waits, sleep: async (ms) => void waits.push(ms) };
}

const rateLimited = { error: { stderr: 'gh: HTTP 403: API rate limit exceeded for user ID 1 (https://api.github.com/...)' } };
const secondary = { error: { stderr: 'gh: HTTP 403: You have exceeded a secondary rate limit' } };
const serverError = { error: { stderr: 'gh: HTTP 502: Bad gateway' } };
const notFound = { error: { stderr: 'gh: HTTP 404: Not Found' } };

test('a failure is classified by what caused it, not by its exit code', () => {
  assert.equal(classifyFailure({ stderr: rateLimited.error.stderr }), 'rate-limit');
  assert.equal(classifyFailure({ stderr: secondary.error.stderr }), 'secondary-limit');
  assert.equal(classifyFailure({ stderr: serverError.error.stderr }), 'server');
  assert.equal(classifyFailure({ stderr: 'gh: HTTP 429: Too Many Requests' }), 'secondary-limit');
  assert.equal(classifyFailure({ message: 'read ECONNRESET' }), 'network');
  assert.equal(classifyFailure({ stderr: notFound.error.stderr }), null);
  assert.equal(httpStatus({ stderr: notFound.error.stderr }), 404);
});

test('a secondary rate limit is retried with doubling backoff, and the answer comes back', async () => {
  const { exec, calls } = fakeGh([secondary, secondary, { stdout: '{"ok":true}' }]);
  const { sleep, waits } = fakeSleep();
  const gh = createGh({ exec, sleep, backoffMs: 100 });

  assert.deepEqual(await gh.json(['api', 'repos/acme/coach']), { ok: true });
  assert.deepEqual(waits, [100, 200], 'backoff must double');
  // --version, then three attempts at the call itself.
  assert.equal(calls.length, 4);
});

test('a primary rate limit waits for the reset the API reports', async () => {
  const now = 1_000_000_000_000;
  const reset = Math.floor(now / 1000) + 20; // twenty seconds out
  const { exec } = fakeGh([
    rateLimited,
    { stdout: JSON.stringify({ resources: { core: { reset } } }) },
    { stdout: '[]' },
  ]);
  const { sleep, waits } = fakeSleep();
  const gh = createGh({ exec, sleep, backoffMs: 100, now: () => now });

  assert.equal(await gh(['api', 'repos/acme/coach/issues/1/comments']), '[]');
  assert.deepEqual(waits, [20_000], 'the wait must come from the reset, not from the backoff');
});

test('a reset further out than the cap is refused rather than slept through', async () => {
  const now = 1_000_000_000_000;
  const { exec } = fakeGh([
    rateLimited,
    { stdout: JSON.stringify({ resources: { core: { reset: Math.floor(now / 1000) + 3600 } } }) },
  ]);
  const { sleep, waits } = fakeSleep();
  const gh = createGh({ exec, sleep, now: () => now, maxWaitMs: 60_000 });

  await assert.rejects(gh(['api', 'x']), (e) => {
    assert.ok(e instanceof GhError);
    assert.match(e.message, /rate limit reached/);
    assert.match(e.message, /3600s/);
    assert.match(e.message, /Nothing was posted/);
    return true;
  });
  assert.deepEqual(waits, [], 'a build must not hang on an hour-long reset');
});

test('a failure that retrying cannot fix is reported at once', async () => {
  const { exec, calls } = fakeGh([notFound]);
  const { sleep, waits } = fakeSleep();
  const gh = createGh({ exec, sleep });

  await assert.rejects(gh(['api', 'repos/acme/coach/pulls/9999']), (e) => {
    assert.equal(e.status, 404);
    assert.match(e.message, /HTTP 404/);
    return true;
  });
  assert.deepEqual(waits, []);
  assert.equal(calls.length, 2, 'one version check, one attempt');
});

test('retries are bounded: the last failure is the one reported', async () => {
  const { exec } = fakeGh([serverError, serverError, serverError, serverError, serverError]);
  const { sleep, waits } = fakeSleep();
  const gh = createGh({ exec, sleep, retries: 2, backoffMs: 10 });

  await assert.rejects(gh(['api', 'x']), /HTTP 502/);
  assert.deepEqual(waits, [10, 20]);
});

test('a missing gh is a plain instruction, not a stack trace', async () => {
  const exec = async () => {
    throw new Error('spawn gh ENOENT');
  };
  const gh = createGh({ exec, sleep: async () => {} });
  await assert.rejects(gh(['api', 'x']), /gh CLI not found on PATH/);
});

test('a paginated comment list is flattened across pages', async () => {
  const { exec, calls } = fakeGh([{ stdout: '[{"id":1,"body":"a"}]\n[{"id":2,"body":"b"}]\n' }]);
  const gh = createGh({ exec, sleep: async () => {} });
  const comments = await listComments(gh, { owner: 'acme', name: 'coach', number: 57 });
  assert.deepEqual(comments.map((c) => c.id), [1, 2]);
  assert.ok(calls[1].includes('--paginate'));
});
