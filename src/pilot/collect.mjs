// `spool pilot collect` — build the pilot dataset out of what the product recorded.
//
// The rule this module obeys is the one R6.1's non-functional requirement asks for:
// pilot mechanics must not distort behaviour. So there is no pilot event, no pilot
// beacon and no extra command an agent has to remember. A chain is assembled from
// three reads that already exist for other reasons:
//
//   GET /api/plans/{id}            the agent read payload (R4.1)
//   GET /api/plans/{id}/events     the append-only log (R3.1)
//   GET /api/plans/{id}/revisions  the lineage (R3.4)
//
// The workdir on disk is used only to find the spool id — the packet's `links.task` is
// what joins a recording to a roster entry, and it is a field the plan already had.
//
// See CONTRACTS.md "Pilot dataset".

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { resolveConfig } from '../publish/publish.mjs';
import { readPlan } from '../plan/read.mjs';
import { CLOSE_WITHIN_DAYS, DATASET_VERSION, chainRecord, summarize } from './chain.mjs';
import { coverage, readRoster } from './scenarios.mjs';

/**
 * Every plan workdir under `roots`, keyed by the task its packet names.
 *
 * One level deep, because that is the workdir layout (`spool/<slug>/`), and a root that
 * IS a workdir is accepted too — the fleet runs each executor in its own worktree, so a
 * collect run is usually pointed at several directories that are not siblings.
 */
export async function discover(roots = []) {
  const found = [];
  for (const root of roots) {
    const dir = resolve(root);
    if (!existsSync(dir)) continue;
    const candidates = existsSync(join(dir, 'plan.json')) ? [dir] : await children(dir);
    for (const wd of candidates) {
      const packet = await readJson(join(wd, 'plan.json'));
      if (!packet || packet.kind !== 'plan') continue;
      const published = await readJson(join(wd, 'share', 'published.json'));
      found.push({
        dir: wd,
        taskKey: typeof packet.links?.task === 'string' ? packet.links.task : null,
        spoolId: published?.id ?? null,
        goal: packet.goal ?? null,
      });
    }
  }
  return found;
}

async function children(dir) {
  const out = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory() && existsSync(join(dir, e.name, 'plan.json'))) out.push(join(dir, e.name));
  }
  return out.sort();
}

async function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Read the two owner-side views of one plan.
 *
 * Both are optional by design: `/events` and `/revisions` need a credential the pilot
 * runner has and a link holder does not, so a run without a token still produces a
 * dataset — with fewer numbers, and a note on every row saying which ones are missing.
 * A failed read is never fatal: one unreachable plan must not lose the other twenty.
 */
async function hostViews(spoolId, cfg, { send = true } = {}) {
  const headers = { accept: 'application/json' };
  if (cfg.token && send) headers.authorization = `Bearer ${cfg.token}`;
  const get = async (path) => {
    try {
      const res = await fetch(`${cfg.host}/api/plans/${spoolId}${path}`, { headers });
      return res.ok ? await res.json() : null;
    } catch {
      return null;
    }
  };
  const [events, revisions] = await Promise.all([get('/events'), get('/revisions')]);
  return { events: events?.events ?? null, revisions: revisions?.revisions ?? null };
}

/**
 * Collect the dataset.
 *
 * The roster is the spine: one row per planned chain, whether or not it published yet,
 * so a scenario nobody started is a visible zero instead of an absent row. Discovered
 * workdirs fill in the spool ids, and a workdir whose task is not on the roster is
 * reported as `unrostered` rather than silently added — the sample is a decision, not
 * whatever happened to be recorded.
 */
export async function collect({
  roots = [],
  rosterPath,
  host,
  token,
  offline = false,
  closeWithinDays = CLOSE_WITHIN_DAYS,
  now = new Date(),
} = {}) {
  const roster = await readRoster(rosterPath);
  const workdirs = await discover(roots);
  const byTask = new Map();
  for (const w of workdirs) if (w.taskKey && !byTask.has(w.taskKey)) byTask.set(w.taskKey, w);

  const cfg = offline ? { host: null, token: null } : await resolveConfig({ host, token });
  // The credential goes to the configured host, or to one named on purpose — the same
  // rule `spool read --plan` follows, for the same reason.
  const configured = offline ? { host: null } : await resolveConfig({});
  const trusted = !!token || !!host || cfg.host === configured.host;

  const chains = [];
  for (const entry of roster.entries) {
    const wd = byTask.get(entry.taskKey) ?? null;
    const dir = entry.dir ?? wd?.dir ?? null;
    const spoolId = entry.spoolId ?? wd?.spoolId ?? null;
    const target = spoolId ?? dir;

    let payload = null;
    let views = { events: null, revisions: null };
    // `--offline` means no network at all, so a chain known only by its spool id has
    // nothing to read: a bare id is a pointer at the host, not a local record.
    const readable = offline ? dir : target;
    if (readable) {
      try {
        payload = await readPlan(readable, { offline, host, token });
      } catch {
        payload = null; // an unreadable target is a row with no facts, never a crash
      }
      const id = payload?.spoolId ?? spoolId;
      if (id && !offline) views = await hostViews(id, cfg, { send: trusted });
    }

    chains.push(
      chainRecord({
        entry: { ...entry, dir, spoolId },
        payload,
        events: views.events,
        revisions: views.revisions,
        closeWithinDays,
      })
    );
  }

  const rostered = new Set(roster.entries.map((e) => e.taskKey));
  const unrostered = workdirs
    .filter((w) => !w.taskKey || !rostered.has(w.taskKey))
    .map((w) => ({ dir: w.dir, taskKey: w.taskKey, spoolId: w.spoolId, goal: w.goal }));

  return {
    version: DATASET_VERSION,
    kind: 'pilot-dataset',
    generatedAt: now.toISOString(),
    host: cfg.host ?? null,
    window: { closeWithinDays },
    roster: { path: roster.path, entries: roster.entries.length },
    chains,
    summary: summarize(chains, { closeWithinDays }),
    coverage: coverage(roster.entries, chains),
    unrostered,
  };
}
