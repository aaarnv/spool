// The implementation-gate policy: what a team's autonomy setting is, where it comes
// from, and which work counts as high risk. See CONTRACTS.md "Implementation gate".
//
// Everything here is pure except `loadGateConfig`, which reads one file. Policy
// resolution has to be reproducible on another machine from the same repository, so
// the inputs are values a caller passes in and the output names the source that won.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

/** The four autonomy policies (roadmap R4.3), weakest first. */
export const POLICIES = ['off', 'advisory', 'high_risk_required', 'required'];

/**
 * Strength order. `required` blocks every implementation without an approved plan;
 * `high_risk_required` blocks only the configured high-risk work, so it sits between
 * "warn about everything" and "block everything".
 */
export const POLICY_RANK = { off: 0, advisory: 1, high_risk_required: 2, required: 3 };

/** With nothing configured anywhere, a project is advisory (FR-17). */
export const DEFAULT_POLICY = 'advisory';

/** The repository file that carries a project's gate configuration. */
export const CONFIG_FILE = 'spool.config.json';

/** Environment override, read by `resolveGatePolicy` callers. */
export const POLICY_ENV = 'SPOOL_PLAN_POLICY';

/**
 * What counts as high risk when a team turns on `high_risk_required` and configures
 * nothing else: the paths where a mistake is expensive and hard to undo. A team
 * replaces this list with `highRisk.paths` in spool.config.json.
 */
export const DEFAULT_HIGH_RISK_PATHS = [
  '**/migrations/**',
  '**/*.sql',
  '**/auth/**',
  '**/billing/**',
  '**/payments/**',
  '**/secrets/**',
  '**/.env*',
  '.github/workflows/**',
  '**/Dockerfile',
  'infra/**',
  'terraform/**',
];

export const isPolicy = (v) => POLICIES.includes(v);

/**
 * Translate one glob to a regular expression. `**` crosses directories, `*` and `?`
 * do not. A dependency-free matcher keeps the gate runnable in a repository that has
 * installed nothing, which is the point of a locally reproducible check.
 */
export function globToRegExp(glob) {
  let out = '';
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      const doubled = g[i + 1] === '*';
      if (doubled) {
        // `**/` is "zero or more whole directories", so `**/auth/**` matches `auth/x`
        // as well as `web/lib/auth/x`. Whole segments keep the match linear.
        if (g[i + 2] === '/') {
          out += '(?:[^/]+/)*';
          i += 2;
          continue;
        }
        out += '.*';
        i += 1;
        continue;
      }
      out += '[^/]*';
      continue;
    }
    if (c === '?') {
      out += '[^/]';
      continue;
    }
    out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

/** True when `path` (repo-relative, forward slashes) matches any glob in `globs`. */
export function matchesGlob(path, globs) {
  const p = String(path).split(sep).join('/').replace(/^\.\//, '');
  return (globs || []).some((g) => globToRegExp(g).test(p));
}

/**
 * Find the `spool.config.json` that governs `cwd`: the nearest one at or above it,
 * never above the repository root. Looking past the root would let a file in a home
 * directory change how a checked-out repository behaves.
 */
export function findGateConfig(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (;;) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git'))) return null; // repository root, and it has no config
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Read the project's gate configuration. Returns `{ path, config }`, with `config`
 * empty when there is no file. A malformed file is an error rather than a silent
 * default: a gate that quietly stops enforcing is worse than one that stops.
 */
export async function loadGateConfig(cwd = process.cwd()) {
  const path = findGateConfig(cwd);
  if (!path) return { path: null, config: {} };
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object`);
  }
  if (parsed.policy != null && !isPolicy(parsed.policy)) {
    throw new Error(`${path}: policy must be one of ${POLICIES.join(' | ')} (got ${JSON.stringify(parsed.policy)})`);
  }
  return { path, config: parsed };
}

/**
 * Resolve the effective policy from every configured source.
 *
 * The strongest configured source wins, and a source that configures nothing is
 * ignored. A gate that a local flag or an environment variable could weaken is not a
 * gate, so `--policy` and `SPOOL_PLAN_POLICY` can only raise what the repository
 * asks for. The audited way to proceed against the policy is `--bypass`.
 *
 * Returns `{ policy, via, sources }`; `sources` lists every configured value, so an
 * agent can print exactly why the gate is what it is.
 */
export function resolveGatePolicy({ flag, env, repo, prefs } = {}) {
  const sources = [];
  for (const [source, raw] of [
    ['flag', flag],
    ['env', env],
    ['repo', repo],
    ['prefs', prefs],
  ]) {
    if (raw == null || raw === '') continue;
    if (!isPolicy(raw)) throw new Error(`${source}: policy must be one of ${POLICIES.join(' | ')} (got ${JSON.stringify(raw)})`);
    sources.push({ source, value: raw });
  }
  if (!sources.length) return { policy: DEFAULT_POLICY, via: 'default', sources };
  // `reduce` keeps the first of equal ranks, so ties report the earlier source:
  // flag, then env, then repo, then prefs.
  const strongest = sources.reduce((a, b) => (POLICY_RANK[b.value] > POLICY_RANK[a.value] ? b : a));
  return { policy: strongest.value, via: strongest.source, sources };
}

/** The high-risk definition in force: the configured one, else the built-in default. */
export function highRiskDefinition(config = {}) {
  const hr = config.highRisk || {};
  const paths = Array.isArray(hr.paths) ? hr.paths.map(String) : null;
  return {
    paths: paths && paths.length ? paths : DEFAULT_HIGH_RISK_PATHS,
    labels: (Array.isArray(hr.labels) ? hr.labels : []).map((l) => String(l).toLowerCase()),
    categories: (Array.isArray(hr.categories) ? hr.categories : []).map((c) => String(c).toLowerCase()),
    configured: Boolean(paths?.length || hr.labels?.length || hr.categories?.length),
  };
}

/**
 * Decide whether this change is high risk, and say why.
 *
 * `pathsKnown: false` means the CLI could not learn which files the work touches (no
 * repository, or `git` is unavailable). The gate then treats the change as high risk:
 * an unclassifiable change under `high_risk_required` must fail closed, not open.
 */
export function classifyRisk({ config = {}, paths = [], labels = [], categories = [], pathsKnown = true } = {}) {
  const def = highRiskDefinition(config);
  const why = [];
  for (const p of paths) if (matchesGlob(p, def.paths)) why.push(`path:${p}`);
  for (const l of labels) if (def.labels.includes(String(l).toLowerCase())) why.push(`label:${l}`);
  for (const c of categories) if (def.categories.includes(String(c).toLowerCase())) why.push(`category:${c}`);
  // No matching path, and no other evidence either: the CLI learned nothing about this
  // work. Labels or categories the caller did supply count as evidence, so a team whose
  // definition is label-based still gets a real "not high risk" answer from them.
  if (!pathsKnown && !why.length && !labels.length && !categories.length) {
    return { highRisk: true, unknown: true, why: ['paths_unknown'], definition: def };
  }
  return { highRisk: why.length > 0, unknown: false, why, definition: def };
}

/** Repo-relative, forward-slashed form of a path, for glob matching and printing. */
export const repoPath = (root, p) => relative(root, resolve(root, p)).split(sep).join('/');
