// GitHub issue and pull-request references, as a plan packet writes them.
//
// A plan says where it lives in `links` (CONTRACTS.md "Plan Spools"). This module is
// the one place that decides what an issue or pull-request link means, so the
// validator, the PR comment and the stale detector all read the same string the same
// way. It is pure and dependency-free: `plan.json` must validate wherever an agent
// runs, with nothing installed and no network.

/**
 * The URL shape, as a pattern string per kind.
 *
 * These are strings so `src/plan/json-schema.mjs` can put the same rule in the
 * portable JSON Schema mirror: an off-the-shelf validator then rejects an issue URL in
 * `links.pr` exactly as this module does. The scheme and host are lower-cased before
 * matching (see `parseGitHubRef`), which a JSON Schema pattern cannot do — a
 * mixed-case host is the one input where the two differ.
 */
const urlShape = (kind) => `^https?://(?:www\\.)?github\\.com/([^/\\s]+)/([^/\\s#?]+?)(?:\\.git)?/(${kind})/(\\d+)(?:[/?#]\\S*)?$`;
export const GITHUB_URL_PATTERNS = { pull: urlShape('pull'), issue: urlShape('issues') };

/** Accepted written forms, most specific first. */
const URL_RE = new RegExp(urlShape('pull|issues'));
const SHORT_RE = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+)#(\d+)$/;
const HASH_RE = /^#(\d+)$/;
const NUMBER_RE = /^\d+$/;

/** A repository slug, from `owner/name` or any GitHub URL that carries one. */
const SLUG_RE = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?$/;
const REPO_URL_RE = /^(?:https?:\/\/(?:www\.)?github\.com\/|git@github\.com:)([A-Za-z0-9][\w.-]*)\/([\w.-]+?)(?:\.git)?(?:[/?#]\S*)?$/i;

/**
 * Read `owner/name` out of a repository link. Returns `{ owner, name }` or null.
 * Anything this cannot read stays null: a wrong owner points every built link at
 * somebody else's repository.
 */
export function parseRepo(input) {
  const s = String(input ?? '').trim();
  if (!s) return null;
  const url = s.match(REPO_URL_RE);
  if (url) return { owner: url[1], name: url[2] };
  const slug = s.match(SLUG_RE);
  return slug ? { owner: slug[1], name: slug[2] } : null;
}

/**
 * Parse one issue or pull-request reference.
 *
 * Accepts a full URL (`https://github.com/o/r/pull/12`, `…/issues/12`), the short form
 * (`o/r#12`), `#12`, and a bare number. The last two need `repo` — pass the packet's
 * `links.repo`. Returns `{ owner, name, number, kind, url }`, or null when the string
 * is not a GitHub reference at all.
 *
 * `kind` is `"pull"`, `"issue"`, or null when the written form does not say. A number
 * alone cannot say: GitHub draws issue and pull-request numbers from one sequence, so
 * `o/r#12` is whichever of the two exists.
 *
 * `owner`/`name`/`url` stay null for a bare number with no repository to resolve it
 * against. That reference is still usable — `spool plan pr` runs inside a checkout
 * that knows its own repository — it just cannot be turned into a link here.
 */
export function parseGitHubRef(input, { repo = null } = {}) {
  // The scheme and host are case-insensitive; everything after them is a GitHub path,
  // where case is meaningful. Lower-casing only the origin keeps both true.
  const s = String(input ?? '').trim().replace(/^https?:\/\/[^/\s]+/i, (origin) => origin.toLowerCase());
  if (!s) return null;

  const url = s.match(URL_RE);
  if (url) return ref(url[1], url[2], Number(url[4]), url[3] === 'pull' ? 'pull' : 'issue');

  const short = s.match(SHORT_RE);
  if (short) return ref(short[1], short[2], Number(short[3]), null);

  const hash = s.match(HASH_RE) || s.match(NUMBER_RE);
  if (!hash) return null;
  const number = Number(hash[1] ?? hash[0]);
  const slug = parseRepo(repo);
  return slug ? ref(slug.owner, slug.name, number, null) : ref(null, null, number, null);
}

function ref(owner, name, number, kind) {
  if (!Number.isInteger(number) || number < 1) return null;
  return { owner, name, number, kind, url: refUrl(owner, name, number, kind) };
}

/**
 * The canonical link for a reference.
 *
 * An unknown kind builds the `/issues/` form on purpose: GitHub redirects
 * `/issues/{n}` to `/pull/{n}` when the number is a pull request, so one link is
 * right either way and no lookup is needed to write it.
 */
export function refUrl(owner, name, number, kind = null) {
  if (!owner || !name) return null;
  return `https://github.com/${owner}/${name}/${kind === 'pull' ? 'pull' : 'issues'}/${number}`;
}

/** The short form a human reads: `owner/name#12`, or `#12` when the repo is unknown. */
export function formatRef(ref) {
  if (!ref) return null;
  return ref.owner && ref.name ? `${ref.owner}/${ref.name}#${ref.number}` : `#${ref.number}`;
}

/**
 * Check one `links` value that claims to be an issue or a pull request.
 *
 * Returns null when the value is usable, else `{ code, message }`:
 *
 * - `wrong-github-kind` — a GitHub URL of the other kind. This is an error: the packet
 *   names a pull request that is an issue, and every tool that follows the link acts
 *   on the wrong thing.
 * - `unrecognized-github-ref` — not a GitHub reference. This is a warning: a project
 *   may track work somewhere spool does not integrate with, and the link is still
 *   worth carrying.
 */
export function checkLinkRef(value, expected, { repo = null } = {}) {
  const parsed = parseGitHubRef(value, { repo });
  if (!parsed) {
    return {
      code: 'unrecognized-github-ref',
      level: 'warn',
      message:
        `is not a GitHub ${expected === 'pull' ? 'pull request' : 'issue'} reference ` +
        `(expected a github.com URL, "owner/name#12", or a number with links.repo set); ` +
        'GitHub features (PR comment, stale detection) stay off for this plan',
    };
  }
  if (parsed.kind && parsed.kind !== expected) {
    return {
      code: 'wrong-github-kind',
      level: 'error',
      message: `points at ${parsed.kind === 'pull' ? 'a pull request' : 'an issue'}; move it to links.${parsed.kind === 'pull' ? 'pr' : 'issue'}`,
    };
  }
  return null;
}

/**
 * Every GitHub reference a packet carries, keyed by the link it came from.
 * `links.task` is included when it happens to be a GitHub issue: a team that tracks
 * work in GitHub writes the issue there, and the PR comment can then link it.
 */
export function packetRefs(links = {}) {
  const repo = links.repo ?? null;
  const out = {};
  for (const [key, expected] of [['pr', 'pull'], ['issue', 'issue'], ['task', null]]) {
    const value = links[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const parsed = parseGitHubRef(value, { repo });
    if (!parsed) continue;
    if (expected && parsed.kind && parsed.kind !== expected) continue;
    out[key] = parsed;
  }
  return out;
}
