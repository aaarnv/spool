// Stale-plan detection: is the plan still about the code it was written against?
//
// A plan pins its source revision in `links.branch` and `links.commit` (written by
// `spool plan init`). Work then continues, and at some point the proposal a reviewer
// approved no longer describes the branch it would land on. This module answers that
// with values anybody can print: how far the branch moved, whether the history was
// rewritten, whether a file the plan cites changed, and how old the pinned commit is.
//
// The verdict is a pure function of those facts, so a second machine reading the same
// repository reaches the same answer. See CONTRACTS.md "GitHub integration".

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findRepoRoot } from '../gate/repo.mjs';
import { DEFAULT_STALE_TOLERANCE } from './config.mjs';
import { parseRepo } from './refs.mjs';

const run = promisify(execFile);

/** Why a plan reads stale. Callers branch on these, so they are stable. */
export const STALE_CODES = ['history-rewritten', 'evidence-changed', 'branch-moved', 'plan-aged'];

/** Why staleness could not be judged. */
export const UNKNOWN_CODES = ['no-repo', 'unpinned', 'commit-unknown', 'branch-unknown'];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Decide from the collected facts. Pure.
 *
 * A rewritten history and a changed cited file are stale at any tolerance: the first
 * means the plan's commit is no longer on the branch, and the second means the branch
 * moved in exactly the code the plan reasoned about. Distance and age are the tunable
 * signals, because how much unrelated movement matters is a team's judgement.
 */
export function classifyStale(source, tolerance = DEFAULT_STALE_TOLERANCE) {
  if (!source?.available) {
    return {
      status: 'unknown',
      stale: false,
      why: [{ code: source?.reason || 'no-repo', detail: source?.detail || 'the plan source could not be read' }],
      source: source ?? null,
      tolerance,
    };
  }

  const why = [];
  if (source.ancestor === false) {
    why.push({ code: 'history-rewritten', detail: `${short(source.commit)} is no longer in the history of ${source.ref}` });
  }
  if (source.changed?.length) {
    why.push({
      code: 'evidence-changed',
      detail: `${source.changed.length} file(s) this plan cites changed since ${short(source.commit)}: ${source.changed.slice(0, 3).join(', ')}${source.changed.length > 3 ? ', …' : ''}`,
    });
  }
  if (tolerance.commits != null && source.moved != null && source.moved > tolerance.commits) {
    why.push({
      code: 'branch-moved',
      detail: `${source.ref} is ${source.moved} commit(s) past ${short(source.commit)} (tolerance ${tolerance.commits})`,
    });
  }
  if (tolerance.days != null && source.ageDays != null && source.ageDays > tolerance.days) {
    why.push({
      code: 'plan-aged',
      detail: `${short(source.commit)} is ${Math.floor(source.ageDays)} day(s) old (tolerance ${tolerance.days})`,
    });
  }

  return { status: why.length ? 'stale' : 'fresh', stale: why.length > 0, why, source, tolerance };
}

const short = (sha) => String(sha || '').slice(0, 7) || 'the pinned commit';

/**
 * Read the source facts out of the checkout the plan lives in.
 *
 * `evidencePaths` are the repository-relative files the packet cites; a change in one
 * of them is the strongest staleness signal there is. Every value is optional: a plan
 * with no pinned commit, or one read outside a checkout, reports `available: false`
 * with the reason, and the caller says "unknown" rather than "fresh".
 */
export async function readLocalSource({ cwd = process.cwd(), links = {}, evidencePaths = [] } = {}) {
  const root = findRepoRoot(cwd);
  const git = async (args) => {
    try {
      const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return null;
    }
  };

  if ((await git(['rev-parse', '--is-inside-work-tree'])) !== 'true') {
    return { available: false, reason: 'no-repo', detail: `${root} is not a git checkout`, origin: 'local' };
  }
  const commit = typeof links.commit === 'string' ? links.commit.trim() : '';
  if (!commit) {
    return {
      available: false,
      reason: 'unpinned',
      detail: 'links.commit is empty, so there is no source revision to compare against (spool plan init writes it inside a checkout)',
      origin: 'local',
    };
  }
  if ((await git(['cat-file', '-e', `${commit}^{commit}`])) === null) {
    return { available: false, reason: 'commit-unknown', detail: `${short(commit)} is not in this checkout`, origin: 'local', commit };
  }

  // The branch the plan named, when this checkout has it; otherwise the current HEAD,
  // which is what a reviewer's clone of the same work looks like.
  const branch = typeof links.branch === 'string' && links.branch.trim() ? links.branch.trim() : null;
  const ref = branch && (await git(['rev-parse', '--verify', '--quiet', branch])) ? branch : 'HEAD';
  const head = await git(['rev-parse', ref]);
  if (!head) return { available: false, reason: 'branch-unknown', detail: `${ref} does not resolve in this checkout`, origin: 'local', commit };

  const movedRaw = await git(['rev-list', '--count', `${commit}..${head}`]);
  const ancestor = (await git(['merge-base', '--is-ancestor', commit, head])) !== null;
  const committedAt = await git(['log', '-1', '--format=%cI', commit]);
  const changed = evidencePaths.length
    ? ((await git(['diff', '--name-only', commit, head, '--', ...evidencePaths])) || '').split('\n').map((l) => l.trim()).filter(Boolean)
    : [];

  return {
    available: true,
    origin: 'local',
    commit,
    branch,
    ref: ref === 'HEAD' ? `HEAD (${branch ? `${branch} is not in this checkout` : 'no branch in links'})` : ref,
    head,
    moved: movedRaw == null ? null : Number(movedRaw),
    ancestor,
    committedAt: committedAt || null,
    ageDays: committedAt ? (Date.now() - Date.parse(committedAt)) / DAY_MS : null,
    changed,
  };
}

/**
 * The same facts from GitHub, for the checkout that cannot answer.
 *
 * A shallow CI clone and a reviewer's machine both hit `commit-unknown`, and the API
 * knows what the local objects do not. It reports distance and divergence only; a
 * cited file's history is not worth a request per file, so that signal stays local.
 * Any failure returns the local answer unchanged — degrading to local-only behaviour
 * is the contract, and a comment that fails to post must never fail a build.
 */
export async function readRemoteSource(local, { gh, links = {}, compare } = {}) {
  if (local?.available || !gh || !compare) return local;
  if (local?.reason !== 'commit-unknown' && local?.reason !== 'branch-unknown') return local;

  const slug = parseRepo(links.repo);
  const branch = typeof links.branch === 'string' ? links.branch.trim() : '';
  const commit = local.commit;
  if (!slug || !branch || !commit) return local;

  try {
    const cmp = await compare(gh, { owner: slug.owner, name: slug.name, base: commit, head: branch });
    return {
      available: true,
      origin: 'github',
      commit,
      branch,
      ref: branch,
      head: null,
      moved: cmp.ahead,
      // "diverged" is GitHub's word for the history this plan was written against no
      // longer being an ancestor of the branch.
      ancestor: cmp.status ? cmp.status !== 'diverged' : null,
      committedAt: null,
      ageDays: null,
      changed: [],
    };
  } catch (e) {
    return { ...local, detail: `${local.detail}; GitHub could not answer either (${e.message})` };
  }
}

/** The repository-relative files a packet cites, for the evidence-changed signal. */
export function evidencePaths(evidence) {
  const items = Array.isArray(evidence?.items) ? evidence.items : Array.isArray(evidence) ? evidence : [];
  const paths = items
    .filter((i) => (i.kind === 'file' || i.kind === 'image') && i.visibility !== 'private' && typeof i.ref === 'string')
    .map((i) => i.ref.trim())
    // A ref that starts with a dash would read as a git option, and one that escapes
    // the checkout is not this repository's file.
    .filter((p) => p && !p.startsWith('-') && !p.startsWith('/') && !p.split('/').includes('..'));
  return [...new Set(paths)];
}

/** One line a human reads: the verdict and the first reason for it. */
export function staleSummary(verdict) {
  const first = verdict.why[0];
  if (verdict.status === 'unknown') return `stale: unknown — ${first?.detail ?? 'no source revision to compare'}`;
  if (!verdict.stale) {
    const s = verdict.source;
    const moved = s?.moved ? `${s.moved} commit(s) since ${short(s.commit)}` : `unchanged since ${short(s?.commit)}`;
    return `plan is current: ${moved}, within tolerance`;
  }
  return `plan is stale: ${first.detail}${verdict.why.length > 1 ? ` (+${verdict.why.length - 1} more)` : ''}`;
}
