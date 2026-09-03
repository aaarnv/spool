// The events cursor, kept on disk so a restarted server resumes instead of replaying.
//
// `GET /api/events` returns every event exactly once for a given cursor, and a cursor
// this server did not write is a 400 rather than "start from the beginning" — so the
// cursor is the whole of the resume story and losing it costs either the entire history
// or the part the agent was away for. It is stored under a hash of (host, token), never
// beside the token itself, because a state file is the wrong place for a credential.
//
// **Delivery is at-least-once, on purpose.** Two positions are kept: `committed` is the
// last page the caller is known to have been handed, `pending` is the page just handed
// over. A call commits the pending position and then polls from it, so a normal loop
// never sees a duplicate — and a crash between two calls resumes from `committed` and
// replays exactly the last page, which is the failure an agent can recover from. The
// alternative (commit before handing over) loses events on the same crash, and a lost
// steer is the one thing this stream exists to prevent.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { stateDir } from './config.mjs';

const VERSION = 1;

/** One file per (host, token) pair. The hash keeps the token out of the filename. */
export function cursorPath(cfg, env = process.env) {
  return join(stateDir(env), `cursor-${cfg.ownerHash}`);
}

const EMPTY = { version: VERSION, committed: null, pending: null, anchored: false, updatedAt: null };

/** Read the stored positions. A missing or unreadable file reads as "never started". */
export async function readState(cfg, env = process.env) {
  let raw;
  try {
    raw = await readFile(cursorPath(cfg, env), 'utf8');
  } catch {
    return { ...EMPTY };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      version: VERSION,
      committed: typeof parsed.committed === 'string' ? parsed.committed : null,
      pending: typeof parsed.pending === 'string' ? parsed.pending : null,
      anchored: !!parsed.anchored,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    };
  } catch {
    // A corrupt file is worse than no file only if it is trusted; treat it as absent.
    return { ...EMPTY };
  }
}

async function write(cfg, state, env = process.env) {
  const path = cursorPath(cfg, env);
  await mkdir(stateDir(env), { recursive: true, mode: 0o700 });
  const next = { ...state, version: VERSION, host: cfg.host, updatedAt: new Date().toISOString() };
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
  return next;
}

/**
 * The position to poll from, and the record that the caller has now taken delivery of
 * whatever was pending. Returns null when nothing has been read yet — the caller then
 * decides between replaying the history and anchoring at the head.
 */
export async function commit(cfg, env = process.env) {
  const state = await readState(cfg, env);
  if (!state.pending || state.pending === state.committed) return state.committed;
  await write(cfg, { ...state, committed: state.pending }, env);
  return state.pending;
}

/** Record a page as handed over, without committing it yet. */
export async function stage(cfg, cursor, env = process.env) {
  const state = await readState(cfg, env);
  if (!cursor || cursor === state.pending) return state;
  return write(cfg, { ...state, pending: cursor, anchored: true }, env);
}

/**
 * Commit a position outright.
 *
 * The watch daemon calls this AFTER its sink has accepted the event, so the sink is the
 * thing that decides an event was delivered. A crash before it replays the batch.
 */
export async function advance(cfg, cursor, env = process.env) {
  const state = await readState(cfg, env);
  if (!cursor || cursor === state.committed) return state;
  return write(cfg, { ...state, committed: cursor, pending: cursor, anchored: true }, env);
}

/** Record where a `tail=1` anchor put us, with no events delivered. */
export async function anchor(cfg, cursor, env = process.env) {
  const state = await readState(cfg, env);
  return write(cfg, { ...state, committed: cursor || null, pending: cursor || null, anchored: true }, env);
}

/** Forget everything, so the next read starts from the beginning of the history. */
export async function reset(cfg, env = process.env) {
  return write(cfg, { ...EMPTY }, env);
}
