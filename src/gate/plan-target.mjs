// Which plan is the gate asking about, and what does it say?
//
// The gate needs one plan and one status. Finding them is the only I/O in the check,
// so it lives here: the evaluator in gate.mjs stays pure and the CLI stays thin.

import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadPlan } from '../plan/plan.mjs';
import { readPlan } from '../plan/read.mjs';

/** Environment override for the active plan, mirroring `--plan`. */
export const PLAN_ENV = 'SPOOL_PLAN';

/**
 * Locate the active plan for a project.
 *
 * A named plan (`--plan`, `SPOOL_PLAN`, `plan` in spool.config.json) is always the
 * answer. With nothing named, exactly one plan workdir under `spool/` is the answer
 * and several are ambiguous — the gate refuses to guess which proposal governs the
 * work, because guessing wrong approves work nobody approved.
 */
export async function resolveActivePlan({ cwd = process.cwd(), explicit = null, env = null, config = {} } = {}) {
  // A named target is the caller's own string: a workdir relative to where they ran
  // the command, a watch URL, or a spool id. An auto-detected one is resolved against
  // the repository root, so the answer does not depend on which directory an agent
  // happened to be in. `label` is the short form the explanation prints.
  const named = explicit || env || config.plan || null;
  if (named) return { target: String(named), label: String(named), named: true, ambiguous: false, candidates: [] };

  const dir = join(resolve(cwd), 'spool');
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { target: null, label: null, named: false, ambiguous: false, candidates: [] };
  }
  const found = entries
    .filter((e) => e.isDirectory() && existsSync(join(dir, e.name, 'plan.json')))
    .map((e) => ({ path: join(dir, e.name), label: `spool/${e.name}` }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const candidates = found.map((f) => f.label);

  if (found.length === 1) return { target: found[0].path, label: found[0].label, named: false, ambiguous: false, candidates };
  return { target: null, label: null, named: false, ambiguous: found.length > 1, candidates };
}

/** The watch link a published workdir already knows, for when the host is unreachable. */
async function publishedUrl(target) {
  const file = join(resolve(target), 'share', 'published.json');
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf8')).url || null;
  } catch {
    return null;
  }
}

/**
 * Read the plan the gate will judge and flatten it to the facts the gate uses.
 *
 * `offline` skips the status fetch and reports the local packet only. The `off`
 * policy uses it: a policy that decides nothing must not cost a network round trip.
 *
 * A plan the CLI cannot read at all is reported as `found: false` with the error, so
 * the gate fails closed instead of treating an unreadable plan as an approved one.
 */
export async function planFacts(target, { host = null, offline = false, label = null } = {}) {
  const shown = label || target;
  if (!target) return { found: false, ambiguous: false, target: null, status: null };

  const isDir = existsSync(resolve(target));
  const watchFallback = isDir ? await publishedUrl(target) : null;

  if (offline) {
    const local = isDir ? await loadPlan(target) : null;
    if (!local) return { found: false, ambiguous: false, target: shown, status: null, watch: watchFallback };
    return factsFrom({ status: 'draft', links: local.plan.links || {} }, shown, watchFallback);
  }

  let payload;
  try {
    payload = await readPlan(target, { host });
  } catch (e) {
    return { found: false, ambiguous: false, target: shown, status: null, watch: watchFallback, error: e.message };
  }
  return factsFrom(payload, shown, watchFallback);
}

function factsFrom(payload, target, watchFallback) {
  const links = payload.links || {};
  return {
    found: true,
    ambiguous: false,
    target,
    spoolId: payload.spoolId ?? null,
    status: payload.status ?? null,
    revision: payload.revision ?? null,
    revisionId: payload.revisionId ?? null,
    decisionType: payload.decision?.type ?? null,
    notes: payload.decision?.notes ?? null,
    goal: payload.goal ?? null,
    watch: links.watch || watchFallback || null,
    task: links.task || null,
    error: payload.error ?? null,
  };
}
