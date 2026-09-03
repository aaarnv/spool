// `spool plan init` — scaffold a Plan Spool packet into spool/<slug>/.
//
// The template is the contract's starting point (templates/plan.json +
// templates/evidence.json). init wires in the two facts the authoring agent
// always knows (the goal, the task it came from) and the git facts nobody
// remembers to fill in (repo, branch, commit), so evidence permalinks can pin
// to the commit the plan was authored against. See CONTRACTS.md "Plan Spools".

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { EVIDENCE_FILE, PLAN_FILE } from './plan.mjs';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

// Same shape as an approach step id: the slug names the workdir and, later, the
// published plan, so keep it to one lowercase kebab-case token set.
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function git(cwd, args) {
  try {
    const { stdout } = await exec('git', args, { cwd });
    const out = stdout.trim();
    return out.length ? out : null;
  } catch {
    return null;
  }
}

// "owner/name" from any remote URL form (ssh, https, with or without .git).
// Anything else stays null: a wrong repo link pins evidence to the wrong tree.
function repoSlug(url) {
  if (!url) return null;
  const m = url.match(/(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Read the git facts a plan can pin evidence against. Every value is optional:
 * a plan authored outside a checkout is still a valid plan, it just cannot
 * build permalinks.
 */
export async function gitLinks(cwd = process.cwd()) {
  if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree']))) return { repo: null, branch: null, commit: null };
  const [remote, branch, commit] = await Promise.all([
    git(cwd, ['remote', 'get-url', 'origin']),
    git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(cwd, ['rev-parse', 'HEAD']),
  ]);
  return { repo: repoSlug(remote), branch: branch === 'HEAD' ? null : branch, commit };
}

/**
 * Write spool/<slug>/plan.json + evidence.json from the templates.
 * Returns { workdir, planPath, evidencePath, links }.
 * Throws with an actionable message on a bad slug or an existing packet.
 */
export async function initPlan({ slug, goal, outcome, task, pr, issue, dir, force = false, cwd = process.cwd() } = {}) {
  if (!slug || !SLUG_RE.test(slug)) {
    throw new Error(`slug "${slug ?? ''}" must be kebab-case (a-z, 0-9, dashes), for example "ask-anchors"`);
  }
  if (typeof goal !== 'string' || !goal.trim()) {
    throw new Error('--goal is required: one sentence saying what the work is for (it is the first thing a reviewer reads)');
  }

  const workdir = dir ? resolve(cwd, dir) : resolve(cwd, 'spool', slug);
  const planPath = join(workdir, PLAN_FILE);
  const evidencePath = join(workdir, EVIDENCE_FILE);
  if (existsSync(planPath) && !force) {
    throw new Error(`${planPath} already exists — edit it, or pass --force to overwrite it`);
  }

  const plan = JSON.parse(await readFile(join(root, 'templates', PLAN_FILE), 'utf8'));
  const evidence = JSON.parse(await readFile(join(root, 'templates', EVIDENCE_FILE), 'utf8'));

  const links = await gitLinks(cwd);
  plan.goal = goal.trim();
  if (typeof outcome === 'string' && outcome.trim()) plan.outcome = outcome.trim();
  // `pr` and `issue` start empty: the pull request usually does not exist yet, and
  // `spool plan pr` writes it back into the packet the first time it comments.
  plan.links = {
    task: task?.trim() || null,
    repo: links.repo,
    branch: links.branch,
    commit: links.commit,
    pr: pr?.trim() || null,
    issue: issue?.trim() || null,
  };

  await mkdir(workdir, { recursive: true });
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n');
  // The template plan references ev-1, so the descriptor bundle is not optional
  // here: a claim that promises a source the packet cannot resolve is an error.
  if (!existsSync(evidencePath) || force) {
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
  }
  return { workdir, planPath, evidencePath, links };
}

/** What to tell the agent after a scaffold, as a relative path it can paste. */
export function initNextSteps(workdir, cwd = process.cwd()) {
  const rel = relative(cwd, workdir) || '.';
  return [
    `Created ${join(rel, PLAN_FILE)} and ${join(rel, EVIDENCE_FILE)}`,
    'Next:',
    '  1. Replace the placeholder currentState, approach, risks and decision text.',
    `  2. Point each evidence descriptor at a real file, URL, test or commit.`,
    `  3. spool plan validate ${rel}`,
  ].join('\n');
}
