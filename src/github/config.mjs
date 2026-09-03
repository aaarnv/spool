// The `github` block of spool.config.json: whether this repository wants spool to
// write on its pull requests, and how far a plan's source revision may drift before
// the plan reads stale. See CONTRACTS.md "GitHub integration".
//
// Commenting is OFF until a repository turns it on. A tool that starts writing on pull
// requests the moment it is installed is a tool teams uninstall, and the value here is
// a comment reviewers trust, not a comment they filter.

import { loadGateConfig } from '../gate/policy.mjs';

/** The repository key that carries this configuration. */
export const CONFIG_KEY = 'github';

/**
 * How far a plan's source revision may drift before it reads stale.
 *
 * `commits`: how far the plan's branch may move past the commit the plan was written
 * against. `days`: how old that commit may be. Ten commits and two weeks are a first
 * guess at "still the same codebase", not a measured number — a team that reviews
 * plans daily should lower both.
 */
export const DEFAULT_STALE_TOLERANCE = { commits: 10, days: 14 };

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** A tolerance value: a non-negative integer, or null for "do not check this". */
function tolerance(value, key, where) {
  if (value === undefined) return DEFAULT_STALE_TOLERANCE[key];
  if (value === null) return null; // the check is off on purpose
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${where}: ${CONFIG_KEY}.stale.${key} must be a non-negative integer, or null to switch the check off (got ${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Normalize the `github` block. Returns
 * `{ comment, stale: { commits, days }, configured }`; `configured` is false when the
 * repository said nothing, so a command can tell "off by default" from "off on
 * purpose" and print the right next step.
 */
export function githubConfig(config = {}, where = 'spool.config.json') {
  const raw = config?.[CONFIG_KEY];
  if (raw === undefined || raw === null) {
    return { comment: false, stale: { ...DEFAULT_STALE_TOLERANCE }, configured: false };
  }
  if (!isObject(raw)) throw new Error(`${where}: ${CONFIG_KEY} must be an object`);
  if (raw.comment !== undefined && typeof raw.comment !== 'boolean') {
    throw new Error(`${where}: ${CONFIG_KEY}.comment must be true or false (got ${JSON.stringify(raw.comment)})`);
  }
  if (raw.stale !== undefined && raw.stale !== null && !isObject(raw.stale)) {
    throw new Error(`${where}: ${CONFIG_KEY}.stale must be an object with commits and/or days`);
  }
  const stale = raw.stale || {};
  return {
    comment: raw.comment === true,
    stale: {
      commits: tolerance(stale.commits, 'commits', where),
      days: tolerance(stale.days, 'days', where),
    },
    configured: true,
  };
}

/** Read the `github` block of the spool.config.json that governs `cwd`. */
export async function loadGithubConfig(cwd = process.cwd()) {
  const { path, config } = await loadGateConfig(cwd);
  return { path, github: githubConfig(config, path || 'spool.config.json'), config };
}

/** The line a command prints when the repository has not opted in. */
export const OPT_IN_HINT =
  `not posted: this repository has not opted in. Add {"${CONFIG_KEY}": {"comment": true}} to spool.config.json to let spool comment on pull requests.`;
