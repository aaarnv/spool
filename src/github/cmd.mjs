// `spool plan pr` and `spool plan stale` — the GitHub surface of a Plan Spool.
//
//   spool plan pr [dir] [--pr <n|url>]   put (or refresh) the plan comment on the PR
//   spool plan stale [dir]               is the plan still about this code?
//
// Exit codes follow the gate's: 0 fine, 1 stale, 2 the check could not run. Nothing
// here can fail a publish or a build: GitHub is an extra surface for a plan, never the
// place a plan lives. Every network failure degrades to the local answer and says so.

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { findRepoRoot } from '../gate/repo.mjs';
import { resolveActivePlan } from '../gate/plan-target.mjs';
import { readPlanPacket } from '../plan/plan.mjs';
import { readPlan } from '../plan/read.mjs';
import { appendJournal, journalRecord, journalRoot } from '../reliability/journal.mjs';
import { renderPlanComment, upsertPlanComment } from './comment.mjs';
import { loadGithubConfig, OPT_IN_HINT } from './config.mjs';
import { compareCommits, createGh, pullFacts, repoFacts } from './gh.mjs';
import { packetRefs, parseGitHubRef, parseRepo } from './refs.mjs';
import { classifyStale, evidencePaths, readLocalSource, readRemoteSource, staleSummary } from './stale.mjs';

export const GITHUB_EXIT = { ok: 0, stale: 1, error: 2 };

/**
 * Everything both commands start from: the project's configuration and the plan
 * workdir. `dir` wins; with nothing named, the gate's own rule decides which plan is
 * active, so `spool plan pr` and `spool gate check` never disagree about that.
 */
async function context(dir, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const root = findRepoRoot(cwd);
  const { github, config } = await loadGithubConfig(cwd);

  let workdir = dir ? resolve(cwd, dir) : null;
  if (!workdir) {
    const active = await resolveActivePlan({ cwd: root, explicit: opts.plan, config });
    if (active.ambiguous) {
      throw new Error(`several plans here (${active.candidates.join(', ')}); name one, or set "plan" in spool.config.json`);
    }
    if (!active.target) throw new Error('no plan found: name a workdir, or run this from a project with one under spool/');
    workdir = resolve(root, active.target);
  }
  if (!existsSync(join(workdir, 'plan.json'))) {
    // Both commands read the packet itself — the source revision is not on the host —
    // so a watch URL or a spool id is not enough here, unlike everywhere else.
    throw new Error(`${workdir} has no plan.json — name a plan workdir (a watch URL or a spool id carries no source revision)`);
  }

  const packet = await readPlanPacket(workdir);
  return { cwd, root, workdir, packet, github, links: packet.plan?.links || {} };
}

/** The staleness verdict for a workdir, GitHub-assisted only when git cannot answer. */
async function staleness(ctx, { gh = null } = {}) {
  const local = await readLocalSource({
    cwd: ctx.workdir,
    links: ctx.links,
    evidencePaths: evidencePaths(ctx.packet.evidence),
  });
  const source = gh ? await readRemoteSource(local, { gh, links: ctx.links, compare: compareCommits }) : local;
  return classifyStale(source, ctx.github.stale);
}

/** `spool plan stale` — the detector on its own, for an agent about to start work. */
export async function planStaleCmd(dir, opts = {}) {
  let ctx;
  try {
    ctx = await context(dir, opts);
  } catch (e) {
    console.error(`spool plan stale: ${e.message}`);
    return GITHUB_EXIT.error;
  }

  // The remote fallback is one API call and only fires when the checkout cannot
  // answer, so it is worth attempting unless the caller asked to stay offline.
  const gh = opts.offline ? null : safeGh(ctx);
  const verdict = await staleness(ctx, { gh });

  // The stale-plan rate is one of the eight R6.3 failure points, and this command is
  // the only place that measures it. `current` is the success: the plan still
  // describes the revision the branch is on.
  await appendJournal(
    journalRoot(ctx.root || undefined),
    journalRecord({
      at: new Date().toISOString(),
      operation: 'stale_plan',
      outcome: verdict.status === 'fresh' ? 'ok' : 'failed',
      reason: verdict.status === 'stale' ? 'source_moved' : verdict.status === 'unknown' ? 'unknown' : null,
      target: ctx.workdir,
      detail: verdict.why?.[0]?.code ?? null,
    })
  );

  if (opts.json) {
    console.log(JSON.stringify({ ok: verdict.status !== 'stale', dir: ctx.workdir, ...verdict, summary: staleSummary(verdict) }, null, 2));
  } else {
    const out = [staleSummary(verdict)];
    for (const w of verdict.why.slice(verdict.status === 'unknown' ? 1 : 0)) out.push(`  ${w.code}: ${w.detail}`);
    if (verdict.status === 'stale') {
      out.push('  Re-read the changed code, then revise the plan (spool plan validate, re-record, publish a revision).');
    }
    console[verdict.status === 'stale' ? 'error' : 'log'](out.join('\n'));
  }
  if (verdict.status === 'stale') return GITHUB_EXIT.stale;
  if (verdict.status === 'unknown') return GITHUB_EXIT.error;
  return GITHUB_EXIT.ok;
}

/** A runner, or null when this machine has no usable `gh`. Never throws. */
function safeGh(ctx) {
  try {
    return createGh({ cwd: ctx.root });
  } catch {
    return null;
  }
}

/**
 * `spool plan pr` — the compact comment that lets a reviewer find the plan from the
 * pull request, and the plan find its pull request.
 */
export async function planPrCmd(dir, opts = {}) {
  let ctx;
  try {
    ctx = await context(dir, opts);
  } catch (e) {
    console.error(`spool plan pr: ${e.message}`);
    return GITHUB_EXIT.error;
  }
  if (ctx.packet.present && !ctx.packet.ok) {
    console.error(`spool plan pr: ${join(ctx.workdir, 'plan.json')} has validation errors; the comment links it anyway (run \`spool plan validate\`).`);
  }

  const gh = createGh({ cwd: ctx.root });
  let pr;
  try {
    pr = await resolvePr(ctx, gh, opts.pr);
  } catch (e) {
    console.error(`spool plan pr: ${e.message}`);
    return GITHUB_EXIT.error;
  }

  // The status is the one fact this comment exists to carry, but a plan that cannot
  // reach its host still has a goal, a decision and a source revision worth posting.
  let payload = null;
  let readError = null;
  try {
    payload = await readPlan(ctx.workdir, { host: opts.host });
  } catch (e) {
    readError = `the decision status could not be read (${e.message})`;
  }

  const verdict = await staleness(ctx, { gh });
  const slug = basename(ctx.workdir);
  const keys = [payload?.spoolId || slug, slug].filter((k, i, a) => k && a.indexOf(k) === i);
  const refs = packetRefs(ctx.links);
  const body = renderPlanComment({
    key: keys[0],
    goal: payload?.goal ?? ctx.packet.plan?.goal ?? null,
    status: payload?.status ?? 'draft',
    revision: payload?.revision ?? null,
    decision: ctx.packet.plan?.decision ?? null,
    decisionMade: payload?.decision ?? null,
    watch: payload?.links?.watch ?? null,
    branch: ctx.links.branch ?? null,
    commit: ctx.links.commit ?? null,
    openQuestions: payload?.openQuestions?.length ?? 0,
    task: taskLink(ctx.links, refs),
    issue: refs.issue ?? null,
    stale: verdict,
    error: readError || payload?.error || null,
  });

  const result = { ok: true, dir: ctx.workdir, pr: { number: pr.number, url: pr.url, repo: `${pr.owner}/${pr.name}` }, comment: null, stale: verdict.status, body };

  if (!ctx.github.comment || opts.dryRun) {
    result.posted = false;
    result.reason = opts.dryRun ? 'dry run: nothing was posted' : OPT_IN_HINT;
    report(result, opts, [body, '', result.reason]);
    return GITHUB_EXIT.ok;
  }

  try {
    const posted = await upsertPlanComment(gh, { owner: pr.owner, name: pr.name, number: pr.number, keys, body });
    result.posted = posted.action !== 'unchanged';
    result.comment = posted;
    const written = await linkBack(ctx, pr);
    if (written) result.wroteLink = written;
    report(result, opts, [
      `${posted.action} the plan comment on ${pr.owner}/${pr.name}#${pr.number}${posted.url ? ` — ${posted.url}` : ''}`,
      ...(written ? [`wrote links.pr = ${written} into ${join(ctx.workdir, 'plan.json')}`] : []),
      `  ${staleSummary(verdict)}`,
    ]);
    return GITHUB_EXIT.ok;
  } catch (e) {
    // A comment is an extra surface. Losing it costs a reviewer one click, so it is a
    // reported failure and never a non-zero exit that stops a pipeline.
    result.ok = false;
    result.posted = false;
    result.reason = `GitHub could not be written to: ${e.message}`;
    result.comment = null;
    if (opts.json) console.log(JSON.stringify(result, null, 2));
    console.error(`spool plan pr: ${result.reason}`);
    console.error('  The plan is unaffected; run this again when GitHub answers.');
    return GITHUB_EXIT.ok;
  }
}

function report(result, opts, lines) {
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else console.log(lines.filter(Boolean).join('\n'));
}

/** `links.task` as a URL, when it is one (a GitHub issue, or any http link). */
function taskLink(links, refs) {
  if (refs.task?.url) return refs.task.url;
  const task = typeof links.task === 'string' ? links.task.trim() : '';
  return /^https?:\/\//.test(task) ? task : null;
}

/**
 * Which pull request this plan belongs to: the one named on the command line, the one
 * the packet already records, or the one `gh` finds for the current branch.
 */
async function resolvePr(ctx, gh, explicit) {
  const named = explicit && explicit !== true ? String(explicit) : null;
  const ref = named ? parseGitHubRef(named, { repo: ctx.links.repo }) : packetRefs(ctx.links).pr || null;
  if (named && !ref) throw new Error(`--pr ${named} is not a pull-request number or GitHub URL`);

  const slug = ref?.owner ? { owner: ref.owner, name: ref.name } : parseRepo(ctx.links.repo);
  if (ref) {
    const repoArg = slug ? `${slug.owner}/${slug.name}` : null;
    const facts = await pullFacts(gh, { number: ref.number, repo: repoArg });
    const where = slug || (await repoFacts(gh));
    return { number: facts.number, url: facts.url, owner: where.owner, name: where.name, head: facts.head, base: facts.base };
  }

  const facts = await pullFacts(gh).catch(() => null);
  if (!facts) {
    throw new Error('no pull request for this branch — open one, pass --pr <number>, or set links.pr in plan.json');
  }
  const where = slug || (await repoFacts(gh));
  return { number: facts.number, url: facts.url, owner: where.owner, name: where.name, head: facts.head, base: facts.base };
}

/**
 * Record the pull request in the packet, once. After this the plan knows its pull
 * request wherever it travels, and the next run updates the same comment without
 * being told which one it is.
 */
async function linkBack(ctx, pr) {
  const current = ctx.links.pr;
  if (typeof current === 'string' && current.trim()) return null;
  const path = join(ctx.workdir, 'plan.json');
  try {
    const plan = JSON.parse(await readFile(path, 'utf8'));
    const value = `https://github.com/${pr.owner}/${pr.name}/pull/${pr.number}`;
    plan.links = { ...(plan.links || {}), pr: value };
    await writeFile(path, JSON.stringify(plan, null, 2) + '\n');
    return value;
  } catch {
    return null; // an unwritable packet is not worth failing a posted comment over
  }
}
