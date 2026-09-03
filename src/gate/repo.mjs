// Repository facts the gate needs: where the checkout starts, and which files the
// work touches. Kept apart from the evaluator so the verdict stays a pure function of
// values somebody can print.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** The checkout root, or `cwd` when this is not a repository. */
export function findRepoRoot(cwd = process.cwd()) {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(`${dir}/.git`)) return dir;
    const up = dirname(dir);
    if (up === dir) return resolve(cwd);
    dir = up;
  }
}

const lines = (out) =>
  String(out || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * The files this work touches, and where the list came from.
 *
 * `explicit` wins, because only the agent knows which files work it has not written
 * yet will land in. Otherwise: the changes in the working tree, against `base` when
 * one is given. An empty result means the CLI learned nothing — not that the work is
 * safe — and the caller treats that as unclassified (see `classifyRisk`).
 */
export async function changedPaths({ cwd = process.cwd(), explicit = [], base = null } = {}) {
  if (explicit?.length) return { paths: explicit.map(String), source: 'explicit' };

  const root = findRepoRoot(cwd);
  const git = async (args) => {
    try {
      const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 });
      return lines(stdout);
    } catch {
      return null;
    }
  };

  const diff = base ? await git(['diff', '--name-only', `${base}...HEAD`]) : null;
  const worktree = await git(['diff', '--name-only', 'HEAD']);
  const untracked = await git(['ls-files', '--others', '--exclude-standard']);
  if (diff == null && worktree == null && untracked == null) return { paths: [], source: 'unavailable' };

  const paths = [...new Set([...(diff || []), ...(worktree || []), ...(untracked || [])])].sort();
  return { paths, source: base ? 'git-range' : 'git-worktree' };
}
