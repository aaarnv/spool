// `spool status <parent>` — record where the approved work is (roadmap R5.4).
//
// A status spool is a `kind: "status"` reply, so everything `spool reply` does happens
// here too: the parent is read from the host before anything is written, and the
// descriptor is refused if the plan cannot take a status. What this command adds is the
// part R5.4 is about — the REPORT (verdict, what is done, what changed, what blocks,
// whether the approved plan still holds) and the narration skeleton that tells it in
// that order.
//
// It is deliberately its own command rather than a pile of flags on `spool reply`: a
// status without a verdict is the thing this feature exists to remove, so there is one
// way to record one. See CONTRACTS.md "Implementation status".

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { formatDiagnostics } from './schema.mjs';
import { REPLY_FILE, REPLY_KIND_STATES, REPLY_VERSION, validateReply } from './reply.mjs';
import { anchorsFromOptions, readParent, writeReply } from './reply-cmd.mjs';
import { STATUS_REASONS, STATUS_VERDICTS, buildStatusReport, statusDigest, statusHeadline } from './status.mjs';
import { statusStepsFile } from './status-template.mjs';


/** What a caller may type for a verdict, mapped to the vocabulary. */
const VERDICT_ALIASES = {
  'on-plan': 'on_plan',
  onplan: 'on_plan',
  on_plan: 'on_plan',
  changed: 'changed',
  blocked: 'blocked',
};

/** "on plan", "on-plan" and "on_plan" are the same verdict typed three ways. */
export function normalizeVerdict(value) {
  const key = String(value ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  return VERDICT_ALIASES[key] ?? value;
}

/**
 * Is this process a git hook?
 *
 * The roadmap's one hard rule for status spools is that they are an explicit agent
 * action and never a per-commit reflex. `GIT_INDEX_FILE` is set by git for the hooks
 * that run while a commit is being made, so a status recorded from one is refused
 * before it reads the parent, let alone records a video.
 */
export function gitHookEnv(env = process.env) {
  return !!(env.GIT_INDEX_FILE || (env.GIT_AUTHOR_DATE && env.GIT_DIR));
}

/** The step ids a `--done` flag names: repeatable, and comma-separated inside one. */
export function completedFromOptions(opts) {
  const raw = Array.isArray(opts.done) ? opts.done : opts.done ? [opts.done] : [];
  return raw.flatMap((v) => String(v).split(',')).map((v) => v.trim()).filter(Boolean);
}

/**
 * The report the flags describe.
 *
 * `reason` defaults from the verdict — blocked work is a blocker, everything else is a
 * milestone — because those are the two cases an agent reaches for. A request for a new
 * decision is the third and is always named on purpose (`--reason decision`).
 */
export function reportFromOptions(opts) {
  const verdict = normalizeVerdict(opts.verdict);
  return buildStatusReport({
    verdict,
    // Commander gives `planHolds: false` for --no-plan-holds and true otherwise: the
    // approved plan holds unless the agent says it does not.
    planValid: opts.planHolds !== false,
    reason: opts.reason ?? (verdict === 'blocked' ? 'blocker' : 'milestone'),
    completed: completedFromOptions(opts),
    changed: opts.changed,
    blocked: opts.blocked,
    next: opts.next,
  });
}

/**
 * `spool status <parent>`. Returns the process exit code: 0 written, 1 refused.
 */
export async function statusCmd(parent, opts = {}) {
  if (gitHookEnv()) {
    console.error('[status] a status spool is an explicit action, not a per-commit one, and this looks like a git hook.');
    console.error('[status] record one at a material milestone, at a blocker, or when the work needs a new decision.');
    return 1;
  }
  if (!STATUS_VERDICTS.includes(normalizeVerdict(opts.verdict))) {
    console.error(`[status] --verdict must be one of ${STATUS_VERDICTS.join(', ')} (got ${JSON.stringify(opts.verdict ?? null)})`);
    console.error('[status] it is the first thing a reviewer reads: is the work on plan, changed, or blocked?');
    return 1;
  }
  if (opts.reason && !STATUS_REASONS.includes(opts.reason)) {
    console.error(`[status] --reason must be one of ${STATUS_REASONS.join(', ')} (got "${opts.reason}")`);
    return 1;
  }

  let facts;
  let anchors;
  const report = reportFromOptions(opts);
  try {
    facts = await readParent(parent, { host: opts.host, token: opts.token });
    anchors = anchorsFromOptions(opts);
  } catch (e) {
    console.error(`[status] ${e.message}`);
    return 1;
  }

  const slug = `status-${facts.spoolId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  const descriptor = {
    version: REPLY_VERSION,
    kind: 'reply',
    replyKind: 'status',
    parent: {
      spoolId: facts.spoolId,
      revisionId: facts.revisionId,
      revision: facts.revision,
      watch: facts.watch,
    },
    anchors,
    // The timeline row reads even when nobody wrote one: the headline is the summary.
    summary: opts.summary ? String(opts.summary).trim() : statusHeadline(report),
    status: report,
  };

  const validated = validateReply(descriptor, facts);
  if (!validated.ok) {
    console.error(`[status] cannot record a status on ${facts.watch}:`);
    console.error(formatDiagnostics(validated));
    if (validated.errors.some((e) => e.code === 'wrong-state')) {
      console.error(
        `[status] the plan is ${facts.status}; a status reports work the plan approved, so it needs ${REPLY_KIND_STATES.status.join(' or ')}.`
      );
    }
    return 1;
  }
  if (validated.warnings.length) console.error(formatDiagnostics({ warnings: validated.warnings }));

  const workdir = opts.dir ? resolve(process.cwd(), opts.dir) : resolve(process.cwd(), 'spool', slug);
  let path;
  let stepsPath = null;
  try {
    path = await writeReply({ workdir, reply: descriptor, force: opts.force });
    // The creation template. Written only when the workdir has no script of its own:
    // a second `spool status` on the same workdir must never overwrite a recording an
    // agent already authored.
    const steps = join(workdir, 'steps.mjs');
    if (!existsSync(steps) || opts.force) {
      await writeFile(steps, statusStepsFile(report, facts, { url: opts.url }));
      stepsPath = steps;
    }
  } catch (e) {
    console.error(`[status] ${e.message}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify({ workdir, file: path, steps: stepsPath, reply: descriptor, parent: { status: facts.status, goal: facts.goal } }, null, 2));
    return 0;
  }

  const rel = relative(process.cwd(), workdir) || '.';
  console.log(`Status: ${statusDigest(report)}`);
  console.log(`Plan:   ${facts.watch} (revision ${facts.revision}, ${facts.status})`);
  console.log(`Created ${join(rel, REPLY_FILE)}${stepsPath ? ` and ${join(rel, 'steps.mjs')}` : ''}`);
  console.log('Next:');
  console.log(`  1. Record it:   spool live ${rel}   (or edit ${join(rel, 'steps.mjs')})`);
  console.log(`  2. Publish it:  spool publish ${rel}`);
  console.log('     The status appears on the plan, verdict first.');
  return 0;
}
