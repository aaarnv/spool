// The local reliability journal: `.spool/reliability.jsonl` (R6.3).
//
// Record, render and publish happen on a developer's machine, and Spool's CLI does
// not phone home (docs/PLAN-SPOOLS-ANALYTICS.md, "The CLI never phones home"). So
// the success rate of the three operations that make a plan exist is kept where
// they happen: one append-only line per attempt, next to the gate's audit log,
// readable with `spool reliability` and collectable as a pilot artifact.
//
// Three rules, in order of importance:
//  1. It never changes what the command does. Every write is swallowed; a full
//     disk, a read-only checkout or a missing directory costs a line, not a take.
//  2. It never grows without bound. The file rotates at a fixed size.
//  3. It never records content: no diff, no narration line, no file text, and the
//     target is a workdir slug rather than its path. The one exception is `detail`,
//     the error message a runbook needs a person to search for, which routinely
//     names an absolute path because errors do. That is why this file is local and
//     gitignored, and why nothing here is ever sent anywhere.

import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { classify, isFailureReason, isOperation, severityOf } from './signals.mjs';

export const JOURNAL_DIR = '.spool';
export const JOURNAL_FILE = 'reliability.jsonl';
/** Rotate at 1 MB — about 6,000 attempts, far more than one project ever needs. */
export const MAX_BYTES = 1024 * 1024;

/** Local monitoring is on unless it is turned off, and it is one variable. */
export const journalEnabled = (env = process.env) => env.SPOOL_RELIABILITY !== 'off';

/** The checkout root, so every workdir under one repository journals to one file. */
export function journalRoot(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

export const journalPath = (root) => join(root, JOURNAL_DIR, JOURNAL_FILE);

const MAX_DETAIL = 200;

/**
 * The one line the journal appends.
 *
 * `detail` is the only free text in the reliability contract, and it exists
 * because a runbook is useless without the error a person has to search for. An
 * error message often names an absolute path, so `detail` may too — which is why it
 * stays here: nothing reads this file except `spool reliability`, and no signal,
 * event or alert ever carries it off this machine.
 */
export function journalRecord({ at, operation, outcome, reason = null, attempts = 1, ms = null, target = null, detail = null }) {
  return {
    at,
    operation,
    outcome,
    reason: isFailureReason(operation, reason) ? reason : null,
    // Severity describes a failure. A success has none: "ok, severity page" reads as
    // an incident to anybody scanning the file.
    severity: outcome === 'failed' ? severityOf(operation, reason) : null,
    attempts: Number.isFinite(attempts) ? attempts : 1,
    ms: Number.isFinite(ms) ? Math.round(ms) : null,
    // The workdir slug, never its path: which spool this was is useful, where the
    // checkout lives on this laptop is not.
    target: target ? basename(String(target)) : null,
    detail: detail ? String(detail).slice(0, MAX_DETAIL) : null,
  };
}

/** Rotate to `.1` once the file is over the cap. Best effort, like everything here. */
async function rotate(path) {
  try {
    const info = await stat(path);
    if (info.size > MAX_BYTES) await rename(path, `${path}.1`);
  } catch {
    /* no file yet, or a rename we cannot do: nothing to rotate */
  }
}

/**
 * Append one record. Returns the path on success and null on any failure — a
 * caller must never branch on journaling, and must never wrap this in a catch.
 */
export async function appendJournal(root, record) {
  if (!journalEnabled()) return null;
  const path = journalPath(root);
  try {
    await mkdir(dirname(path), { recursive: true });
    await rotate(path);
    await appendFile(path, JSON.stringify(record) + '\n');
    return path;
  } catch {
    return null;
  }
}

/** Read the journal back, newest last. Unparseable lines are skipped, not fatal. */
export async function readJournal(root, { since = null } = {}) {
  const path = journalPath(root);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return [];
  }
  const cutoff = since ? Date.parse(since) : null;
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!isOperation(row.operation)) continue;
      if (cutoff && Number.isFinite(cutoff) && Date.parse(row.at) < cutoff) continue;
      out.push(row);
    } catch {
      /* a torn line from a killed process: skip it */
    }
  }
  return out;
}

/**
 * Run one operation and journal what happened to it.
 *
 * The value and the exception both pass through untouched: `observe` is a
 * measurement, never a control-flow change. A failure is classified into the
 * operation's closed vocabulary (`classify`), so the report can group it.
 *
 * `fn` is handed a context it may write to. Setting `ctx.attempts` above 1 is what
 * turns a survived blip into the `retried` outcome instead of a plain success, and
 * `ctx.target` names the workdir when only the operation knows it.
 */
export async function observe(operation, fn, { root = null, target = null, now = () => Date.now() } = {}) {
  const startedAt = now();
  const dir = root || journalRoot();
  const ctx = { attempts: 1, target };
  const finish = async (outcome, extra) => {
    await appendJournal(
      dir,
      journalRecord({
        at: new Date(startedAt).toISOString(),
        operation,
        outcome,
        ms: now() - startedAt,
        target: ctx.target,
        attempts: ctx.attempts,
        ...extra,
      })
    );
  };
  try {
    const value = await fn(ctx);
    await finish(ctx.attempts > 1 ? 'retried' : 'ok');
    return value;
  } catch (e) {
    if (Number.isFinite(e?.attempts)) ctx.attempts = e.attempts;
    await finish('failed', { reason: classify(operation, e), detail: e?.message });
    throw e;
  }
}
