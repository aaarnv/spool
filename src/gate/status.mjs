// The gate on a pull request. `required` mode needs a check a repository can protect
// a branch with, so the verdict is published as a GitHub commit status.
//
// Statuses, not checks: a status needs no GitHub App, so `gh` on a developer's laptop
// and `gh` in CI post the same thing. See CONTRACTS.md "Implementation gate".
//
// Every call goes through the shared runner in src/github/gh.mjs, which is where
// rate-limit backoff lives.

import { createGh, repoFacts } from '../github/gh.mjs';

/** The status context to protect a branch with. Stable: branch rules name it. */
export const STATUS_CONTEXT = 'spool/plan-gate';

/** Verdict → GitHub status state. An advisory gate reports, it never fails a PR. */
export const STATUS_STATE = { allow: 'success', warn: 'success', block: 'failure' };

/** owner/name of the repository `cwd` is in. */
export async function ghRepo(cwd = process.cwd()) {
  return repoFacts(createGh({ cwd }));
}

/**
 * The pull request the gate is judging: its head commit (what the status attaches
 * to), its labels and its changed files (both feed the high-risk classification).
 * With no number, `gh` resolves the current branch's PR.
 */
export async function prFacts(numberOrUrl = null, cwd = process.cwd()) {
  const gh = createGh({ cwd });
  const target = numberOrUrl ? [String(numberOrUrl)] : [];
  const pr = await gh.json(['pr', 'view', ...target, '--json', 'number,headRefOid,labels,url,files']);
  return {
    number: pr.number,
    sha: pr.headRefOid,
    url: pr.url,
    labels: (pr.labels || []).map((l) => l.name).filter(Boolean),
    paths: (pr.files || []).map((f) => f.path).filter(Boolean),
  };
}

/** Post the commit status. Returns the URL GitHub stored it at. */
export async function postGateStatus({ owner, repo, sha, state, description, targetUrl, cwd = process.cwd() }) {
  const gh = createGh({ cwd });
  const args = [
    'api',
    '-X',
    'POST',
    `repos/${owner}/${repo}/statuses/${sha}`,
    '-f',
    `state=${state}`,
    '-f',
    `context=${STATUS_CONTEXT}`,
    '-f',
    `description=${description.slice(0, 140)}`,
  ];
  if (targetUrl) args.push('-f', `target_url=${targetUrl}`);
  const out = await gh(args);
  try {
    return JSON.parse(out).url || null;
  } catch {
    return null;
  }
}
