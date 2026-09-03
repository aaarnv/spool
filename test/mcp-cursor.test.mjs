// The events cursor on disk (mcp/src/cursor.mjs).
//
// The cursor is the whole of the resume story: `GET /api/events` returns every event
// exactly once for a given position, and a cursor the server did not write is a 400
// rather than a silent replay from the beginning. So what is asserted here is the two
// properties an agent's correctness rests on — a restarted server resumes where it left
// off, and a server that died mid-turn replays the last page rather than skipping it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ownerHash } from '../mcp/src/config.mjs';
import { advance, anchor, commit, cursorPath, readState, reset, stage } from '../mcp/src/cursor.mjs';

const cfg = { host: 'https://example.test', token: 'spk_secret_value', ownerHash: ownerHash('https://example.test', 'spk_secret_value') };

async function sandbox() {
  const dir = await mkdtemp(join(tmpdir(), 'spool-mcp-cursor-'));
  return { env: { SPOOL_MCP_HOME: dir }, dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test('a machine that has never read the stream reports exactly that', async () => {
  const s = await sandbox();
  try {
    const state = await readState(cfg, s.env);
    assert.equal(state.committed, null);
    assert.equal(state.pending, null);
    assert.equal(state.anchored, false, 'never anchored, so the first read replays the whole history');
  } finally {
    await s.cleanup();
  }
});

test('a page handed over is staged, and the NEXT call is what commits it', async () => {
  const s = await sandbox();
  try {
    await stage(cfg, 'cursor-a', s.env);
    // The crash window: the page went out, nothing has confirmed it was acted on.
    assert.equal((await readState(cfg, s.env)).committed, null, 'a restart here replays the page');

    assert.equal(await commit(cfg, s.env), 'cursor-a');
    assert.equal((await readState(cfg, s.env)).committed, 'cursor-a');

    await stage(cfg, 'cursor-b', s.env);
    assert.equal((await readState(cfg, s.env)).committed, 'cursor-a', 'still the last confirmed position');
    assert.equal(await commit(cfg, s.env), 'cursor-b');
  } finally {
    await s.cleanup();
  }
});

test('committing twice with nothing new writes nothing and returns the same position', async () => {
  const s = await sandbox();
  try {
    await stage(cfg, 'cursor-a', s.env);
    assert.equal(await commit(cfg, s.env), 'cursor-a');
    const first = await readState(cfg, s.env);
    assert.equal(await commit(cfg, s.env), 'cursor-a');
    assert.deepEqual(await readState(cfg, s.env), first);
  } finally {
    await s.cleanup();
  }
});

test('advance commits outright — the watch daemon calls it AFTER its sink accepted', async () => {
  const s = await sandbox();
  try {
    await advance(cfg, 'cursor-z', s.env);
    const state = await readState(cfg, s.env);
    assert.equal(state.committed, 'cursor-z');
    assert.equal(state.pending, 'cursor-z');
    assert.equal(state.anchored, true);
  } finally {
    await s.cleanup();
  }
});

test('anchoring records a head position with nothing delivered', async () => {
  const s = await sandbox();
  try {
    await anchor(cfg, 'head', s.env);
    const state = await readState(cfg, s.env);
    assert.equal(state.committed, 'head');
    assert.equal(state.anchored, true, 'a second start must not replay the history it skipped');
  } finally {
    await s.cleanup();
  }
});

test('reset forgets everything, so the next read replays from the beginning', async () => {
  const s = await sandbox();
  try {
    await advance(cfg, 'cursor-a', s.env);
    await reset(cfg, s.env);
    const state = await readState(cfg, s.env);
    assert.equal(state.committed, null);
    assert.equal(state.anchored, false);
  } finally {
    await s.cleanup();
  }
});

test('a corrupt cursor file is treated as absent rather than trusted', async () => {
  const s = await sandbox();
  try {
    await advance(cfg, 'cursor-a', s.env);
    await writeFile(cursorPath(cfg, s.env), '{ not json');
    assert.equal((await readState(cfg, s.env)).committed, null);
  } finally {
    await s.cleanup();
  }
});

test('the file is per (host, token), private, and never contains the token', async () => {
  const s = await sandbox();
  try {
    await advance(cfg, 'cursor-a', s.env);
    const path = cursorPath(cfg, s.env);
    assert.equal(path, join(s.dir, `cursor-${cfg.ownerHash}`));

    const raw = await readFile(path, 'utf8');
    assert.ok(!raw.includes(cfg.token), 'a state file is the wrong place for a credential');
    assert.ok(raw.includes(cfg.host));

    const info = await stat(path);
    assert.equal(info.mode & 0o077, 0, 'the cursor is readable by its owner only');

    const other = { ...cfg, token: 'spk_a_different_token' };
    other.ownerHash = ownerHash(other.host, other.token);
    assert.notEqual(cursorPath(other, s.env), path, 'two tokens are two followers');
    assert.equal((await readState(other, s.env)).committed, null);
  } finally {
    await s.cleanup();
  }
});
