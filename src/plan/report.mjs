// `spool plan validate` output: a terse human report and a stable JSON
// diagnostics document over the same packet result.
//
// Both are scripting surfaces, so both are contracts (CONTRACTS.md "Plan
// Spools" → "spool plan"). The JSON keys and the exit codes below only ever
// gain fields; they never change meaning.

import { PLAN_FILE } from './plan.mjs';

/** Exit codes `spool plan validate` and `spool plan build` use. */
export const PLAN_EXIT = {
  ok: 0,       // packet valid (warnings allowed unless --strict)
  invalid: 1,  // packet present and invalid
  absent: 2,   // no plan.json here: this workdir is not a Plan Spool
};

/**
 * The one-glance facts about a readable plan: what it asks for and how big it
 * is. Returns null when the plan could not be parsed at all.
 */
export function planSummary(packet) {
  const plan = packet.plan;
  if (!plan || typeof plan !== 'object') return null;
  const list = (v) => (Array.isArray(v) ? v : []);
  const ids = (v) => list(v).map((x) => x?.id).filter((id) => typeof id === 'string');
  return {
    version: Number.isInteger(plan.version) ? plan.version : null,
    goal: typeof plan.goal === 'string' ? plan.goal : null,
    outcome: typeof plan.outcome === 'string' ? plan.outcome : null,
    chapters: ids(plan.chapters),
    approach: ids(plan.approach),
    alternatives: ids(plan.alternatives),
    decision: {
      type: plan.decision?.type ?? null,
      prompt: plan.decision?.prompt ?? null,
      options: list(plan.decision?.options),
    },
    evidence: list(packet.evidence?.items).length,
  };
}

/**
 * Stable machine diagnostics for `--json`. `ok` answers the only question a
 * script asks; `errors`/`warnings` carry { path, code, message } as the
 * validator produced them, with `path` naming the file and field.
 */
export function planReportJson(packet, { dir, strict = false } = {}) {
  const ok = packet.present && packet.ok && !(strict && packet.warnings.length > 0);
  return {
    ok,
    dir,
    present: packet.present,
    exit: planExitCode(packet, { strict }),
    summary: packet.present ? planSummary(packet) : null,
    errors: packet.errors,
    warnings: packet.warnings,
  };
}

/** The exit code for a packet result, so the report and the process agree. */
export function planExitCode(packet, { strict = false } = {}) {
  if (!packet.present) return PLAN_EXIT.absent;
  if (!packet.ok) return PLAN_EXIT.invalid;
  if (strict && packet.warnings.length > 0) return PLAN_EXIT.invalid;
  return PLAN_EXIT.ok;
}

// One column width for both, so the facts and the problems read as one table.
const field = (label, value) => `  ${label.padEnd(12)} ${value}`;
const diagnostic = (level, x) => `  ${level.padEnd(12)} ${x.path || '(root)'}  ${x.message}`;

/**
 * The terse human report: what the plan asks for, then one line per problem,
 * then a verdict. Every problem line names the field to fix.
 */
export function formatPlanReport(packet, { dir, strict = false } = {}) {
  const lines = [`plan  ${dir}`];
  if (!packet.present) {
    lines.push(`  no ${PLAN_FILE} here — this workdir is not a Plan Spool.`);
    lines.push('  Fix: run `spool plan init <slug> --goal "..."`, or use `spool build` for an ordinary spool.');
    return lines.join('\n');
  }

  const s = planSummary(packet);
  if (s) {
    if (s.goal) lines.push(field('goal', s.goal));
    if (s.outcome) lines.push(field('outcome', s.outcome));
    if (s.chapters.length) lines.push(field('chapters', s.chapters.join(', ')));
    if (s.approach.length) lines.push(field('approach', `${s.approach.length} step(s): ${s.approach.join(', ')}`));
    lines.push(field('alternatives', s.alternatives.length ? s.alternatives.join(', ') : 'none stated'));
    if (s.decision.type || s.decision.prompt) {
      lines.push(field('decision', `${s.decision.type ?? '?'}: ${s.decision.prompt ?? '?'} [${s.decision.options.join(', ')}]`));
    }
    lines.push(field('evidence', `${s.evidence} descriptor(s)`));
  }

  for (const e of packet.errors) lines.push(diagnostic('error', e));
  for (const w of packet.warnings) lines.push(diagnostic(strict ? 'error' : 'warn', w));

  const n = packet.errors.length + (strict ? packet.warnings.length : 0);
  const warned = strict ? 0 : packet.warnings.length;
  const counts = `${n} error(s), ${warned} warning(s)`;
  if (planExitCode(packet, { strict }) === PLAN_EXIT.ok) lines.push(`valid — ${counts}.`);
  else lines.push(`invalid — ${counts}. Contract: CONTRACTS.md "Plan Spools".`);
  return lines.join('\n');
}
