// The pilot roster: which real work runs as a Plan Spool, and which shape it is.
//
// The roadmap asks for 15–25 chains across FOUR scenarios (R6.1). Left alone, a
// dogfood pilot draws every chain from whatever the fleet is building this week, and a
// sample that is all one shape cannot answer "which workflow pulls hardest?" — which is
// the R6.4 question the pilot exists to feed. So the roster is written first and the
// dataset is joined to it: coverage is a number before the chains exist, not a
// discovery afterwards.
//
// The file is `docs/pilot/scenarios.json`. It is the only hand-maintained input to the
// pilot; everything else is read back off the product.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Where a roster lives, inside whichever repository is being piloted. */
export const ROSTER_FILE = 'docs/pilot/scenarios.json';

/**
 * The default roster: the one in the repository the command was run in, else the one
 * this CLI ships with. A globally installed `spool` piloting another repo must read
 * that repo's roster, not the copy inside node_modules.
 */
export const defaultRosterPath = (cwd = process.cwd()) => {
  const local = resolve(cwd, ROSTER_FILE);
  return existsSync(local) ? local : join(root, ROSTER_FILE);
};

/** The packaged roster. Kept for tests and for `--roster` documentation. */
export const ROSTER_PATH = join(root, ROSTER_FILE);

export const ROSTER_VERSION = 1;

/**
 * The four shapes of work the roadmap wants represented. Each one stresses a different
 * part of the product, which is why the sample has to hold all four:
 *
 * - `ui-feature`    something a reviewer can SEE — the case video is obviously good at.
 * - `risky-refactor` no visible surface, high blast radius — the case a plan has to
 *                    argue in words, and the case the gate exists for.
 * - `bug-fix`       a reproduction, a cause and a fix — the shortest chain, so the one
 *                   that shows whether the ceremony is worth it on small work.
 * - `agent-handoff` one agent plans, another implements — the case `spool read --plan`
 *                   was built for, and the R6.4 "persistent context" wedge.
 */
export const SCENARIOS = ['ui-feature', 'risky-refactor', 'bug-fix', 'agent-handoff'];

export const SCENARIO_LABEL = {
  'ui-feature': 'visible UI feature',
  'risky-refactor': 'risky refactor',
  'bug-fix': 'bug fix with repro',
  'agent-handoff': 'agent handoff',
};

/** The sample size R6.1 asks for. Coverage is judged against both ends. */
export const TARGET_MIN = 15;
export const TARGET_MAX = 25;
/** With four scenarios and a 15-chain floor, no shape may fall below this. */
export const PER_SCENARIO_MIN = 3;

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Validate a parsed roster. Returns { ok, errors, warnings } in the same shape as the
 * packet validator, so `formatDiagnostics` prints it.
 */
export function validateRoster(value) {
  const errors = [];
  const warnings = [];
  const error = (path, code, message) => errors.push({ path, code, message });
  const warn = (path, code, message) => warnings.push({ path, code, message });

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    error('', 'invalid-type', 'scenarios.json must be a JSON object');
    return { ok: false, errors, warnings };
  }
  if (value.version !== ROSTER_VERSION) {
    error('version', 'invalid-version', `version must be ${ROSTER_VERSION} (got ${JSON.stringify(value.version)})`);
  }
  if (!Array.isArray(value.entries)) {
    error('entries', 'required', 'entries must be an array of roster entries');
    return { ok: errors.length === 0, errors, warnings };
  }

  const keys = new Set();
  value.entries.forEach((e, i) => {
    const path = `entries[${i}]`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      error(path, 'invalid-type', `${path} must be an object`);
      return;
    }
    if (!isText(e.taskKey)) error(`${path}.taskKey`, 'required', `${path}.taskKey is required (the bb task or issue key)`);
    else if (keys.has(e.taskKey)) error(`${path}.taskKey`, 'duplicate', `${path}.taskKey "${e.taskKey}" is listed twice`);
    else keys.add(e.taskKey);

    if (!isText(e.title)) error(`${path}.title`, 'required', `${path}.title is required`);
    if (!SCENARIOS.includes(e.scenario)) {
      error(`${path}.scenario`, 'unknown-scenario', `${path}.scenario must be one of ${SCENARIOS.join(', ')}`);
    }
    // `why` is what stops a roster becoming a backlog copy: it says what this chain is
    // supposed to teach, which is the thing R6.2 reads back.
    if (!isText(e.why)) warn(`${path}.why`, 'missing-why', `${path}.why should say what this chain is meant to show`);

    for (const key of ['spoolId', 'dir']) {
      if (e[key] !== undefined && e[key] !== null && !isText(e[key])) {
        error(`${path}.${key}`, 'invalid-type', `${path}.${key} must be a non-empty string or null`);
      }
    }
    if (e.stop !== undefined && e.stop !== null) {
      if (typeof e.stop !== 'object' || Array.isArray(e.stop)) {
        error(`${path}.stop`, 'invalid-type', `${path}.stop must be an object { at, reason }`);
      } else if (!isText(e.stop.reason)) {
        error(`${path}.stop.reason`, 'required', `${path}.stop.reason is required: an explicit stop must say why`);
      }
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** Read and validate the roster. Throws with the diagnostics on an invalid one. */
export async function readRoster(path = defaultRosterPath()) {
  if (!existsSync(path)) throw new Error(`pilot: no roster at ${path} (see docs/PILOT.md)`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`pilot: ${path} is not valid JSON: ${e.message}`);
  }
  const res = validateRoster(parsed);
  if (!res.ok) {
    throw new Error(`pilot: ${path} is invalid:\n${res.errors.map((d) => `  ${d.path}: ${d.message}`).join('\n')}`);
  }
  return { ...parsed, path, warnings: res.warnings };
}

/**
 * Scenario coverage of a set of chains.
 *
 * `planned` is what the roster committed to, `live` is what actually published, and
 * `closed` is what reached a proof or an explicit stop. All three are reported per
 * scenario, because a pilot that planned four refactors and published none has a gap
 * the totals hide.
 */
export function coverage(entries, chains = []) {
  const byKey = new Map(chains.map((c) => [c.taskKey, c]));
  const rows = SCENARIOS.map((scenario) => {
    const planned = entries.filter((e) => e.scenario === scenario);
    const live = planned.filter((e) => byKey.get(e.taskKey)?.publishedAt || byKey.get(e.taskKey)?.spoolId);
    const decided = planned.filter((e) => byKey.get(e.taskKey)?.firstDecisionAt);
    const closed = planned.filter((e) => ['proved', 'stopped'].includes(byKey.get(e.taskKey)?.outcome));
    return {
      scenario,
      label: SCENARIO_LABEL[scenario],
      planned: planned.length,
      live: live.length,
      decided: decided.length,
      closed: closed.length,
      short: Math.max(0, PER_SCENARIO_MIN - closed.length),
    };
  });

  const gaps = [];
  const total = entries.length;
  if (total < TARGET_MIN) gaps.push(`the roster lists ${total} chains; R6.1 asks for at least ${TARGET_MIN}`);
  if (total > TARGET_MAX) gaps.push(`the roster lists ${total} chains; R6.1 caps the sample at ${TARGET_MAX}`);
  for (const r of rows) {
    if (r.planned === 0) gaps.push(`no chain is planned for ${r.label}`);
    else if (r.short > 0) gaps.push(`${r.label}: ${r.closed} of ${PER_SCENARIO_MIN} chains closed (${r.short} to go)`);
  }

  return { target: { min: TARGET_MIN, max: TARGET_MAX, perScenario: PER_SCENARIO_MIN }, total, scenarios: rows, gaps };
}
