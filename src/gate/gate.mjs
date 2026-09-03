// The implementation gate itself: policy × risk × plan status → allow, warn or block,
// plus the command-level explanation a blocked agent reads. See CONTRACTS.md
// "Implementation gate".
//
// This module is pure. Everything it needs is passed in, so the same inputs produce
// the same verdict on any machine — a gate nobody can reproduce is a gate nobody
// trusts. I/O lives in plan-target.mjs (which plan?), audit.mjs (what happened?) and
// cmd.mjs (the command surface).

import { POLICY_RANK } from './policy.mjs';

/** What the gate says about a command. */
export const GATE_DECISIONS = ['allow', 'warn', 'block'];

/**
 * Why the gate decided what it did, as tokens a caller can branch on. The prose next
 * to them is for a person; these are for the agent that has to pick what to do next.
 */
export const GATE_REASONS = [
  'policy_off',
  'plan_approved',
  'plan_approved_with_notes',
  'plan_implementing',
  'plan_not_approved',
  'plan_status_unknown',
  'plan_missing',
  'plan_ambiguous',
  'high_risk',
  'not_high_risk',
  'bypassed',
];

/**
 * The plan states an agent may implement from. `approved` is the decision itself;
 * `implementing` is a plan whose work already started, so a second command in the
 * same run is not a second question.
 */
export const IMPLEMENTABLE_STATUSES = ['approved', 'implementing'];

/**
 * What the audit log records for a run. A run that proceeds without an approved plan
 * is a bypass under EVERY policy, including `advisory` — that is the whole value of
 * the advisory setting (FR-19).
 */
export const AUDIT_EVENTS = ['implementation_started', 'implementation_bypassed', 'implementation_blocked'];

/** One-line prose per reason code, written for the agent that is blocked. */
const REASON_TEXT = {
  policy_off: 'the plan policy is off, so Plan Spools are informational here',
  plan_approved: 'the active plan is approved',
  plan_approved_with_notes: 'the active plan is approved, with notes to honour',
  plan_implementing: 'the active plan is already being implemented',
  plan_not_approved: 'the active plan is not approved yet',
  plan_status_unknown: 'the plan status could not be read, so it is treated as not approved',
  plan_missing: 'no active plan was found for this project',
  plan_ambiguous: 'several plan workdirs are here, so the active plan is ambiguous',
  high_risk: 'this change touches high-risk work',
  not_high_risk: 'this change is not high-risk work',
  bypassed: 'a human recorded a reason to proceed without an approved plan',
};

export const reasonText = (code) => REASON_TEXT[code] || code;

/** True when the policy blocks unapproved work of this risk level. */
export function enforces(policy, highRisk) {
  if (policy === 'required') return true;
  if (policy === 'high_risk_required') return Boolean(highRisk);
  return false;
}

/**
 * Evaluate the gate.
 *
 * @param {object} args
 * @param {string} args.policy      resolved policy (see policy.mjs)
 * @param {object} args.risk        `classifyRisk` output
 * @param {object} args.plan        normalized plan facts (see plan-target.mjs)
 * @param {object|null} args.bypass `{ reason }` when a human recorded one
 * @returns {{decision: string, event: string, reasons: string[], enforced: boolean,
 *           bypassed: boolean, notes: string|null}}
 */
export function evaluateGate({ policy, risk = { highRisk: false }, plan = { found: false }, bypass = null } = {}) {
  if (POLICY_RANK[policy] == null) throw new Error(`unknown policy ${JSON.stringify(policy)}`);

  // `off` asks no question, so it reads no status and blocks nothing.
  if (policy === 'off') {
    return { decision: 'allow', event: 'implementation_started', reasons: ['policy_off'], enforced: false, bypassed: false, notes: null };
  }

  const reasons = [];
  if (policy === 'high_risk_required') reasons.push(risk.highRisk ? 'high_risk' : 'not_high_risk');

  const approved = plan.found && IMPLEMENTABLE_STATUSES.includes(plan.status);
  if (approved) {
    // An approval carrying a caveat still approves (decision #20): the caveat is a
    // condition on the work, not a second decision to wait for. The gate passes it
    // through so the agent honours it, and the audit record keeps it.
    reasons.push(
      plan.status === 'implementing'
        ? 'plan_implementing'
        : plan.decisionType === 'approved_with_notes'
          ? 'plan_approved_with_notes'
          : 'plan_approved'
    );
    return {
      decision: 'allow',
      event: 'implementation_started',
      reasons,
      enforced: enforces(policy, risk.highRisk),
      bypassed: false,
      notes: plan.notes || null,
    };
  }

  reasons.push(planGap(plan));

  const enforced = enforces(policy, risk.highRisk);
  if (!enforced) {
    // Advisory: the work proceeds, and the fact that it proceeded unapproved is
    // recorded anyway. Nothing about an advisory run is silent.
    return { decision: 'warn', event: 'implementation_bypassed', reasons, enforced: false, bypassed: true, notes: null };
  }
  if (bypass?.reason) {
    reasons.push('bypassed');
    return { decision: 'allow', event: 'implementation_bypassed', reasons, enforced: true, bypassed: true, notes: null };
  }
  return { decision: 'block', event: 'implementation_blocked', reasons, enforced: true, bypassed: false, notes: null };
}

/** Which "not approved" this is. Ambiguity and unreachability both fail closed. */
function planGap(plan) {
  if (plan.ambiguous) return 'plan_ambiguous';
  if (!plan.found) return 'plan_missing';
  if (plan.status === 'unknown') return 'plan_status_unknown';
  return 'plan_not_approved';
}

const label = (v, fallback = '—') => (v == null || v === '' ? fallback : String(v));

/**
 * The explanation the CLI prints. It names the command that was gated, the policy and
 * where it came from, the plan and its status, the link to open, and the one audited
 * way to proceed — so a blocked agent never has to guess what it is waiting for.
 */
export function explainGate(outcome, ctx = {}) {
  const { policy, via, risk = {}, plan = {}, command } = ctx;
  const head =
    outcome.decision === 'block'
      ? `spool gate: BLOCKED — ${command ? `\`${command}\`` : 'this implementation'} may not run yet.`
      : outcome.decision === 'warn'
        ? `spool gate: WARNING — ${command ? `\`${command}\`` : 'this implementation'} is running without an approved plan.`
        : `spool gate: ALLOWED — ${command ? `\`${command}\`` : 'implementation'} may proceed.`;

  const lines = [head, ''];
  const row = (k, v) => lines.push(`  ${k.padEnd(11)}${v}`);

  row('policy', `${policy}${via && via !== 'default' ? ` (${via})` : ' (default)'}`);
  if (policy === 'high_risk_required') {
    const why = risk.why?.length ? risk.why.join(', ') : 'nothing matched the high-risk definition';
    row('risk', `${risk.highRisk ? 'high risk' : 'normal'} — ${why}`);
  }
  row(
    'plan',
    plan.found
      ? `${label(plan.target || plan.spoolId)} → ${label(plan.status)}${plan.revision ? ` (revision ${plan.revision})` : ''}`
      : plan.ambiguous
        ? `ambiguous: ${(plan.candidates || []).join(', ')}`
        : 'none found'
  );
  row('reason', outcome.reasons.map(reasonText).join('; '));
  if (plan.error) row('note', plan.error);
  if (outcome.notes) row('notes', outcome.notes);
  if (plan.watch) row('watch', plan.watch);

  lines.push('');
  for (const line of nextSteps(outcome, ctx)) lines.push(`  ${line}`);
  return lines.join('\n');
}

/** What to do about it — one instruction per line, in the order to try them. */
function nextSteps(outcome, ctx) {
  const { plan = {}, command } = ctx;
  const cmd = command ? ` -- ${command}` : '';
  const steps = [];
  if (outcome.decision === 'allow' && outcome.bypassed) {
    steps.push('Recorded: this run proceeded without an approved plan. The bypass is in the audit log.');
    return steps;
  }
  if (outcome.decision === 'allow') {
    if (outcome.notes) steps.push('The approval carries notes. Honour them, or ask before you deviate.');
    return steps.length ? steps : ['Nothing to do: the plan approves this work.'];
  }

  if (outcome.reasons.includes('plan_missing')) {
    steps.push('Record a plan first: `spool plan init <slug> --goal "..."`, then `spool plan build spool/<slug>`.');
  } else if (outcome.reasons.includes('plan_ambiguous')) {
    steps.push('Name the plan this work belongs to: `spool gate check --plan spool/<slug>`.');
  } else if (outcome.reasons.includes('plan_status_unknown')) {
    steps.push('The host could not be reached. Retry, or read the plan yourself: `spool read --plan <target>`.');
  } else if (plan.watch) {
    steps.push(`Ask the reviewer to decide: ${plan.watch}`);
  } else {
    steps.push('Publish the plan and ask the reviewer to decide: `spool plan build <workdir>`.');
  }

  if (outcome.decision === 'block') {
    steps.push(`To proceed anyway, record why: \`spool gate run --bypass --reason "..."${cmd}\``);
  }
  return steps;
}

/** One line, short enough for a GitHub commit-status description (140 characters). */
export function gateSummary(outcome, ctx = {}) {
  const { policy, plan = {} } = ctx;
  const state = plan.found ? label(plan.status) : plan.ambiguous ? 'ambiguous plan' : 'no plan';
  const verdict = outcome.decision === 'block' ? 'blocked' : outcome.decision === 'warn' ? 'advisory' : 'allowed';
  const rev = plan.revision ? ` r${plan.revision}` : '';
  return `${verdict}: policy ${policy}, plan ${state}${rev}`.slice(0, 140);
}
