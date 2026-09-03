// The gate verdict itself (roadmap R4.3, FR-18 and FR-19).
//
// `evaluateGate` is pure, so the whole truth table is testable without a repository, a
// network or a plan. The explanation is tested here too: a blocked agent that cannot
// read what it is waiting for is blocked twice.

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateGate, explainGate, gateSummary, enforces } from '../src/gate/gate.mjs';

const plan = (over = {}) => ({
  found: true,
  ambiguous: false,
  target: 'spool/ask-anchors',
  spoolId: 'sp_123456789012345678',
  status: 'awaiting_decision',
  revision: 2,
  revisionId: 'rev-1',
  decisionType: null,
  notes: null,
  watch: 'https://spoolkit.dev/l/sp_123456789012345678',
  ...over,
});

const approved = () => plan({ status: 'approved', decisionType: 'approve' });
const risky = { highRisk: true, unknown: false, why: ['path:db/0001.sql'] };
const safe = { highRisk: false, unknown: false, why: [] };

// --- which policies block ---------------------------------------------------

test('only required and high-risk work under high_risk_required enforce', () => {
  assert.equal(enforces('off', true), false);
  assert.equal(enforces('advisory', true), false);
  assert.equal(enforces('required', false), true);
  assert.equal(enforces('high_risk_required', true), true);
  assert.equal(enforces('high_risk_required', false), false);
});

test('an unknown policy is a programming error, not a default', () => {
  assert.throws(() => evaluateGate({ policy: 'strict', plan: plan() }), /unknown policy/);
});

// --- the truth table --------------------------------------------------------

test('off allows everything and asks nothing', () => {
  const out = evaluateGate({ policy: 'off', risk: risky, plan: plan({ found: false }) });
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.reasons, ['policy_off']);
  assert.equal(out.bypassed, false);
});

test('advisory warns without an approved plan, and never blocks', () => {
  for (const risk of [safe, risky]) {
    const out = evaluateGate({ policy: 'advisory', risk, plan: plan() });
    assert.equal(out.decision, 'warn');
    assert.equal(out.enforced, false);
    assert.deepEqual(out.reasons, ['plan_not_approved']);
  }
});

test('required blocks unapproved work of any risk level', () => {
  const out = evaluateGate({ policy: 'required', risk: safe, plan: plan() });
  assert.equal(out.decision, 'block');
  assert.equal(out.event, 'implementation_blocked');
  assert.deepEqual(out.reasons, ['plan_not_approved']);
});

test('high_risk_required blocks the high-risk work and advises on the rest', () => {
  const blocked = evaluateGate({ policy: 'high_risk_required', risk: risky, plan: plan() });
  assert.equal(blocked.decision, 'block');
  assert.deepEqual(blocked.reasons, ['high_risk', 'plan_not_approved']);

  const advised = evaluateGate({ policy: 'high_risk_required', risk: safe, plan: plan() });
  assert.equal(advised.decision, 'warn');
  assert.deepEqual(advised.reasons, ['not_high_risk', 'plan_not_approved']);
});

test('an approved plan allows the work under every policy', () => {
  for (const policy of ['advisory', 'high_risk_required', 'required']) {
    const out = evaluateGate({ policy, risk: risky, plan: approved() });
    assert.equal(out.decision, 'allow');
    assert.equal(out.event, 'implementation_started');
    assert.equal(out.bypassed, false);
    assert.ok(out.reasons.includes('plan_approved'));
  }
});

// The R4.3 half of decision #20: `approved_with_notes` is a decision type, not a
// state. It approves, and the caveat travels with the verdict for the agent to honour.
test('an approval with notes unblocks the work and carries the notes', () => {
  const out = evaluateGate({
    policy: 'required',
    risk: risky,
    plan: plan({ status: 'approved', decisionType: 'approved_with_notes', notes: 'ship it, but rename the flag' }),
  });
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.reasons, ['plan_approved_with_notes']);
  assert.equal(out.notes, 'ship it, but rename the flag');
  assert.match(explainGate(out, { policy: 'required', plan: plan({ status: 'approved' }) }), /Honour them/);
});

test('a plan already being implemented does not ask the question twice', () => {
  const out = evaluateGate({ policy: 'required', risk: risky, plan: plan({ status: 'implementing' }) });
  assert.equal(out.decision, 'allow');
  assert.deepEqual(out.reasons, ['plan_implementing']);
});

// --- fail closed ------------------------------------------------------------

test('an unreadable status, a missing plan and an ambiguous one all fail closed', () => {
  const cases = [
    [plan({ status: 'unknown', error: 'host unreachable' }), 'plan_status_unknown'],
    [{ found: false, ambiguous: false }, 'plan_missing'],
    [{ found: false, ambiguous: true, candidates: ['spool/a', 'spool/b'] }, 'plan_ambiguous'],
  ];
  for (const [facts, reason] of cases) {
    const out = evaluateGate({ policy: 'required', risk: safe, plan: facts });
    assert.equal(out.decision, 'block', reason);
    assert.deepEqual(out.reasons, [reason]);
  }
});

test('a draft plan is not an approved plan', () => {
  const out = evaluateGate({ policy: 'required', risk: safe, plan: plan({ status: 'draft', spoolId: null }) });
  assert.equal(out.decision, 'block');
  assert.deepEqual(out.reasons, ['plan_not_approved']);
});

// --- FR-19: every run without an approval is auditable ----------------------

test('every unapproved run records a bypass, including an advisory one', () => {
  const advisory = evaluateGate({ policy: 'advisory', risk: safe, plan: plan() });
  assert.equal(advisory.event, 'implementation_bypassed');
  assert.equal(advisory.bypassed, true);

  const bypassed = evaluateGate({ policy: 'required', risk: safe, plan: plan(), bypass: { reason: 'prod is down' } });
  assert.equal(bypassed.decision, 'allow');
  assert.equal(bypassed.event, 'implementation_bypassed');
  assert.equal(bypassed.bypassed, true);
  assert.ok(bypassed.reasons.includes('bypassed'));
});

test('a bypass with no reason does not unblock', () => {
  const out = evaluateGate({ policy: 'required', risk: safe, plan: plan(), bypass: { reason: '' } });
  assert.equal(out.decision, 'block');
});

// --- FR-18: the explanation -------------------------------------------------

test('a blocked explanation names the command, the policy, the plan and the link', () => {
  const ctx = { policy: 'required', via: 'repo', risk: safe, plan: plan(), command: 'npm run migrate' };
  const out = evaluateGate({ policy: 'required', risk: safe, plan: ctx.plan });
  const text = explainGate(out, ctx);
  assert.match(text, /BLOCKED/);
  assert.match(text, /npm run migrate/);
  assert.match(text, /required \(repo\)/);
  assert.match(text, /awaiting_decision \(revision 2\)/);
  assert.match(text, /the active plan is not approved yet/);
  assert.match(text, /https:\/\/spoolkit\.dev\/l\/sp_123456789012345678/);
  // The one audited way past the gate is named, with the command already in it.
  assert.match(text, /--bypass --reason ".\.\." -- npm run migrate/);
});

test('an explanation without a plan says how to record one', () => {
  const ctx = { policy: 'required', via: 'repo', risk: safe, plan: { found: false, ambiguous: false }, command: 'make deploy' };
  const text = explainGate(evaluateGate({ policy: 'required', risk: safe, plan: ctx.plan }), ctx);
  assert.match(text, /spool plan init/);
});

test('an ambiguous plan tells the agent to name one', () => {
  const facts = { found: false, ambiguous: true, candidates: ['spool/a', 'spool/b'] };
  const ctx = { policy: 'required', via: 'repo', risk: safe, plan: facts };
  const text = explainGate(evaluateGate({ policy: 'required', risk: safe, plan: facts }), ctx);
  assert.match(text, /spool\/a, spool\/b/);
  assert.match(text, /--plan spool\/<slug>/);
});

test('the high-risk line says what matched', () => {
  const ctx = { policy: 'high_risk_required', via: 'repo', risk: risky, plan: plan() };
  const text = explainGate(evaluateGate({ policy: 'high_risk_required', risk: risky, plan: plan() }), ctx);
  assert.match(text, /high risk — path:db\/0001\.sql/);
});

test('the summary fits a commit-status description', () => {
  const ctx = { policy: 'required', plan: plan() };
  const line = gateSummary(evaluateGate({ policy: 'required', risk: safe, plan: plan() }), ctx);
  assert.equal(line, 'blocked: policy required, plan awaiting_decision r2');
  assert.ok(line.length <= 140);
});
