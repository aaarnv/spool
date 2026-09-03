// The `gh` runner every GitHub call in spool goes through.
//
// Statuses and comments are posted with the `gh` CLI, not with a GitHub App: `gh` on a
// laptop and `gh` in CI then post the same thing, with the credential the developer or
// the workflow already has. Nothing here asks for more than `gh` was given, and spool
// never writes anything but a comment and a commit status.
//
// The one thing a shared runner must add is patience. GitHub answers a burst with a
// rate limit rather than with data, so a call retries with backoff, and a primary rate
// limit waits for the reset the API reports instead of guessing.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Retries after the first attempt. Three covers a secondary limit; more just stalls. */
export const DEFAULT_RETRIES = 3;
/** First backoff, doubled per attempt. */
export const DEFAULT_BACKOFF_MS = 1000;
/** The longest a primary rate-limit reset is worth waiting for. Past this, say so. */
export const MAX_RATE_LIMIT_WAIT_MS = 60_000;

const MAX_BUFFER = 16 * 1024 * 1024;

export class GhError extends Error {
  constructor(message, { status = null, retryable = null, stderr = '' } = {}) {
    super(message);
    this.name = 'GhError';
    this.status = status;
    this.retryable = retryable;
    this.stderr = stderr;
  }
}

const text = (e) => `${e?.stderr || ''}\n${e?.stdout || ''}\n${e?.message || ''}`;

/** The HTTP status `gh` reported, when it reported one. */
export function httpStatus(e) {
  const m = text(e).match(/HTTP (\d{3})/);
  return m ? Number(m[1]) : null;
}

/**
 * Why this failure is worth retrying, or null when it is not.
 *
 * `rate-limit` is the primary hourly limit: it clears at a time the API can be asked
 * for. `secondary-limit` is the burst limit, which clears on its own in seconds.
 * `server` and `network` are the transient failures every remote call has.
 */
export function classifyFailure(e) {
  const out = text(e);
  const status = httpStatus(e);
  if (/rate limit exceeded|API rate limit/i.test(out)) return 'rate-limit';
  if (/secondary rate limit|abuse detection/i.test(out)) return 'secondary-limit';
  if (status === 429) return 'secondary-limit';
  if (status && status >= 500) return 'server';
  if (!status && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|connection reset/i.test(out)) return 'network';
  return null;
}

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build a `gh` runner.
 *
 * `exec`, `sleep` and `now` are injected so a test can drive the retry path without a
 * network and without waiting: the backoff is what needs testing, not `setTimeout`.
 */
export function createGh({
  cwd = process.cwd(),
  exec = execFileAsync,
  sleep = sleepReal,
  now = () => Date.now(),
  retries = DEFAULT_RETRIES,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxWaitMs = MAX_RATE_LIMIT_WAIT_MS,
} = {}) {
  let checked = false;

  const raw = async (args) => {
    const { stdout } = await exec('gh', args, { cwd, maxBuffer: MAX_BUFFER });
    return stdout;
  };

  /** How long until the primary limit resets, from the API's own clock. */
  const resetWait = async () => {
    try {
      const body = JSON.parse(await raw(['api', 'rate_limit']));
      const reset = body?.resources?.core?.reset ?? body?.rate?.reset;
      if (!Number.isFinite(reset)) return null;
      return Math.max(0, reset * 1000 - now());
    } catch {
      return null;
    }
  };

  const gh = async (args) => {
    if (!checked) {
      await raw(['--version']).catch(() => {
        throw new GhError('gh CLI not found on PATH — install it and run `gh auth login` first', { retryable: false });
      });
      checked = true;
    }

    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await raw(args);
      } catch (e) {
        lastError = e;
        const why = classifyFailure(e);
        if (!why || attempt === retries) break;

        let wait = backoffMs * 2 ** attempt;
        if (why === 'rate-limit') {
          const untilReset = await resetWait();
          // A reset further out than the cap is not something to sleep through: the
          // caller degrades to local-only behaviour instead of hanging a build.
          if (untilReset != null && untilReset > maxWaitMs) {
            throw new GhError(
              `GitHub rate limit reached; it resets in ${Math.round(untilReset / 1000)}s. Nothing was posted.`,
              { status: httpStatus(e), retryable: false, stderr: text(e) }
            );
          }
          if (untilReset != null) wait = Math.max(wait, untilReset);
        }
        await sleep(wait);
      }
    }

    const status = httpStatus(lastError);
    throw new GhError(`gh ${args[0]} failed${status ? ` (HTTP ${status})` : ''}: ${firstLine(lastError)}`, {
      status,
      retryable: classifyFailure(lastError),
      stderr: text(lastError),
    });
  };

  gh.json = async (args) => {
    const out = await gh(args);
    try {
      return JSON.parse(out);
    } catch (e) {
      throw new GhError(`gh ${args.join(' ')} did not return JSON: ${e.message}`, { retryable: false });
    }
  };

  return gh;
}

function firstLine(e) {
  const line = text(e)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)[0];
  return line || 'no output';
}

// --- the calls spool makes --------------------------------------------------

/** `owner/name` of the repository `gh` resolves in this checkout. */
export async function repoFacts(gh) {
  const info = await gh.json(['repo', 'view', '--json', 'owner,name']);
  const owner = info?.owner?.login;
  const name = info?.name;
  if (!owner || !name) throw new GhError('run inside a GitHub repository with gh authenticated', { retryable: false });
  return { owner, name };
}

/**
 * The pull request a comment goes on. With no number, `gh` resolves the current
 * branch's pull request; with one, that one.
 */
export async function pullFacts(gh, { number = null, repo = null } = {}) {
  const args = ['pr', 'view'];
  if (number != null) args.push(String(number));
  if (repo) args.push('--repo', repo);
  args.push('--json', 'number,url,state,isDraft,headRefName,baseRefName,headRefOid');
  const pr = await gh.json(args);
  return {
    number: pr.number,
    url: pr.url,
    state: pr.state,
    draft: !!pr.isDraft,
    head: pr.headRefName,
    base: pr.baseRefName,
    sha: pr.headRefOid,
  };
}

/** Every comment on the pull request's conversation, oldest first. */
export async function listComments(gh, { owner, name, number }) {
  const out = await gh(['api', '--paginate', `repos/${owner}/${name}/issues/${number}/comments`]);
  // `--paginate` concatenates one JSON array per page, so parse each and flatten.
  const pages = out.trim().length ? out.trim().split(/\n(?=\[)/) : [];
  return pages.flatMap((page) => {
    try {
      const parsed = JSON.parse(page);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
}

/** Post a new comment. Returns the created comment. */
export async function createComment(gh, { owner, name, number, body }) {
  return gh.json([
    'api',
    '-X',
    'POST',
    `repos/${owner}/${name}/issues/${number}/comments`,
    '-f',
    `body=${body}`,
  ]);
}

/** Rewrite one comment in place. Returns the updated comment. */
export async function updateComment(gh, { owner, name, id, body }) {
  return gh.json(['api', '-X', 'PATCH', `repos/${owner}/${name}/issues/comments/${id}`, '-f', `body=${body}`]);
}

/**
 * How far `head` has moved past `base`, asked of GitHub rather than of a checkout.
 * The stale detector uses this only when the local repository cannot answer.
 */
export async function compareCommits(gh, { owner, name, base, head }) {
  const cmp = await gh.json(['api', `repos/${owner}/${name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`]);
  return { status: cmp.status ?? null, ahead: cmp.ahead_by ?? null, behind: cmp.behind_by ?? null };
}
