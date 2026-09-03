// `spool gate` — the command surface of the implementation gate.
//
//   spool gate policy            what policy is in force here, and why
//   spool gate check             may this work start?           (exit 1 when blocked)
//   spool gate run -- <cmd>      check, then run the command    (exit 1 when blocked)
//   spool gate status --pr       publish the verdict as a GitHub commit status
//
// Exit codes are a contract: 0 may proceed, 1 blocked, 2 the check could not run.
// See CONTRACTS.md "Implementation gate".

import { spawn } from 'node:child_process';
import { readPrefs } from '../config/prefs.mjs';
import { appendAudit, auditRecord, sendPlanEvent } from './audit.mjs';
import { evaluateGate, explainGate, gateSummary } from './gate.mjs';
import { planFacts, resolveActivePlan, PLAN_ENV } from './plan-target.mjs';
import { classifyRisk, highRiskDefinition, loadGateConfig, POLICY_ENV, resolveGatePolicy } from './policy.mjs';
import { changedPaths, findRepoRoot } from './repo.mjs';
import { ghRepo, postGateStatus, prFacts, STATUS_CONTEXT, STATUS_STATE } from './status.mjs';

export const GATE_EXIT = { ok: 0, blocked: 1, error: 2 };

/**
 * Run the whole check once: resolve the policy, classify the change, read the plan,
 * evaluate, and record. Every command below is a presentation of this result.
 */
export async function runGate(opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const root = findRepoRoot(cwd);
  const { path: configPath, config } = await loadGateConfig(cwd);
  const prefs = await readPrefs();

  const { policy, via, sources } = resolveGatePolicy({
    flag: opts.policy,
    env: process.env[POLICY_ENV],
    repo: config.policy,
    prefs: prefs.planPolicy,
  });

  // Pull-request facts serve two masters: the labels and files feed the risk
  // classification, and the head commit is what a status attaches to.
  let pr = null;
  if (opts.pr != null) pr = await prFacts(opts.pr === true ? null : opts.pr, cwd);

  // What the work touches, best source first: what the agent declared, then what the
  // pull request actually changes, then this checkout's working tree.
  const changed = opts.paths?.length
    ? { paths: opts.paths.map(String), source: 'explicit' }
    : pr?.paths?.length
      ? { paths: pr.paths, source: 'pull-request' }
      : await changedPaths({ cwd: root, base: opts.base });
  const labels = [...(opts.labels || []), ...(pr?.labels || [])];
  const risk = classifyRisk({
    config,
    paths: changed.paths,
    labels,
    categories: opts.categories || [],
    // An empty change set is not evidence that the work is safe: it is the absence of
    // evidence. Under `high_risk_required` that fails closed, so an agent that has not
    // written the code yet declares its files with `--paths`.
    pathsKnown: changed.paths.length > 0,
  });

  const active = await resolveActivePlan({ cwd: root, explicit: opts.plan, env: process.env[PLAN_ENV], config });
  const facts = active.ambiguous
    ? { found: false, ambiguous: true, candidates: active.candidates, target: null, status: null }
    : await planFacts(active.target, { host: opts.host, offline: policy === 'off', label: active.label });

  const bypass = opts.bypass ? { reason: opts.reason } : null;
  const outcome = evaluateGate({ policy, risk, plan: facts, bypass });
  const ctx = { policy, via, sources, risk, plan: facts, command: opts.command || null, configPath, changed, pr };

  const record = auditRecord({
    at: new Date().toISOString(),
    outcome,
    policy,
    via,
    risk,
    plan: facts,
    command: opts.command,
    paths: changed.paths,
    reason: opts.reason || null,
  });

  // Every run is recorded. An unaudited gate run is indistinguishable from one that
  // never happened, which is the one thing the bypass trail exists to prevent.
  const audit = { path: await appendAudit(root, record), server: null };
  // A blocked run started nothing, so there is nothing to report to the plan. The
  // `off` policy makes no network calls at all.
  if (outcome.decision !== 'block' && policy !== 'off') {
    audit.server = await sendPlanEvent(record, { host: opts.host });
  }

  return { outcome, ctx, record, audit, code: outcome.decision === 'block' ? GATE_EXIT.blocked : GATE_EXIT.ok };
}

/** The machine-readable form. Same fields, same names as the human explanation. */
export function gateJson({ outcome, ctx, audit }) {
  return {
    ok: outcome.decision !== 'block',
    decision: outcome.decision,
    reasons: outcome.reasons,
    enforced: outcome.enforced,
    bypassed: outcome.bypassed,
    policy: { value: ctx.policy, via: ctx.via, sources: ctx.sources, config: ctx.configPath },
    risk: { highRisk: ctx.risk.highRisk, unknown: ctx.risk.unknown, why: ctx.risk.why, paths: ctx.changed.paths.length, source: ctx.changed.source },
    plan: ctx.plan,
    command: ctx.command,
    notes: outcome.notes,
    audit: { local: audit?.path ?? null, event: outcome.event, server: audit?.server ?? null },
    explanation: explainGate(outcome, ctx),
  };
}

/**
 * Where the record went, when that is not obvious. An audit trail that quietly failed
 * to reach the plan is worth one line: the local log is still there, and somebody has
 * to know the reviewer's copy is not.
 */
function auditNote({ outcome, audit }) {
  if (!audit?.path || !outcome.bypassed) return null;
  if (audit.server?.sent) return null;
  const why = audit.server?.error ? ` (${audit.server.error})` : '';
  return `  recorded in ${audit.path}; the plan was not updated${why}`;
}

function report(result, { json }) {
  if (json) {
    console.log(JSON.stringify(gateJson(result), null, 2));
    return;
  }
  const note = auditNote(result);
  if (note) console.error(note);
  const text = explainGate(result.outcome, result.ctx);
  if (result.outcome.decision === 'block') console.error(text);
  else console.log(text);
}

/** Reject a bypass with no reason before anything is evaluated or recorded. */
function checkBypass(opts) {
  if (opts.bypass && !String(opts.reason || '').trim()) {
    console.error('spool gate: --bypass needs --reason "<why this work starts without an approved plan>".');
    return false;
  }
  return true;
}

/**
 * Run the check, or fail with one line. A gate that cannot run has not allowed
 * anything: exit 2 is neither "may proceed" nor "blocked", and a caller that treats
 * only 0 as permission is still safe.
 */
async function attempt(opts) {
  try {
    return await runGate(opts);
  } catch (e) {
    console.error(`spool gate: the check could not run: ${e.message}`);
    return null;
  }
}

export async function gateCheckCmd(opts) {
  if (!checkBypass(opts)) return GATE_EXIT.error;
  const result = await attempt(opts);
  if (!result) return GATE_EXIT.error;
  report(result, opts);
  return result.code;
}

export async function gateRunCmd(argv, opts) {
  if (!checkBypass(opts)) return GATE_EXIT.error;
  if (!argv?.length) {
    console.error('spool gate run: name the command to gate, after `--`. Example: spool gate run -- npm run migrate');
    return GATE_EXIT.error;
  }
  const command = argv.join(' ');
  const result = await attempt({ ...opts, command });
  if (!result) return GATE_EXIT.error;
  if (result.code !== GATE_EXIT.ok) {
    report(result, opts);
    return result.code;
  }
  // The command owns the terminal from here; the gate's own note goes to stderr so it
  // cannot corrupt the command's stdout.
  if (opts.json) console.log(JSON.stringify(gateJson(result), null, 2));
  else if (result.outcome.decision === 'warn' || result.outcome.bypassed) {
    const note = auditNote(result);
    if (note) console.error(note);
    console.error(explainGate(result.outcome, result.ctx));
  }

  return await new Promise((resolveCode) => {
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit', shell: false });
    child.on('error', (e) => {
      console.error(`spool gate run: could not run \`${command}\`: ${e.message}`);
      resolveCode(GATE_EXIT.error);
    });
    child.on('exit', (code, signal) => resolveCode(signal ? 1 : (code ?? 0)));
  });
}

/** `spool gate policy` — print the resolved policy and everything that decided it. */
export async function gatePolicyCmd(opts = {}) {
  try {
    return await printPolicy(opts);
  } catch (e) {
    console.error(`spool gate policy: ${e.message}`);
    return GATE_EXIT.error;
  }
}

async function printPolicy(opts) {
  const cwd = opts.cwd || process.cwd();
  const { path: configPath, config } = await loadGateConfig(cwd);
  const prefs = await readPrefs();
  const { policy, via, sources } = resolveGatePolicy({
    flag: opts.policy,
    env: process.env[POLICY_ENV],
    repo: config.policy,
    prefs: prefs.planPolicy,
  });
  const definition = highRiskDefinition(config);
  if (opts.json) {
    console.log(JSON.stringify({ policy, via, sources, config: configPath, highRisk: definition, plan: config.plan ?? null }, null, 2));
    return GATE_EXIT.ok;
  }
  const out = [
    `policy: ${policy} (${via})`,
    `config: ${configPath || 'none — using the built-in default'}`,
  ];
  if (sources.length) {
    out.push('sources:');
    for (const s of sources) out.push(`  ${s.source.padEnd(6)} ${s.value}`);
    out.push('  (the strongest configured source wins; --policy and the environment can only raise it)');
  }
  out.push(`high risk: ${definition.configured ? 'configured' : 'built-in default'}`);
  for (const p of definition.paths) out.push(`  path     ${p}`);
  for (const l of definition.labels) out.push(`  label    ${l}`);
  for (const c of definition.categories) out.push(`  category ${c}`);
  console.log(out.join('\n'));
  return GATE_EXIT.ok;
}

/** `spool gate status` — the same verdict, published where a branch rule can see it. */
export async function gateStatusCmd(opts) {
  if (!checkBypass(opts)) return GATE_EXIT.error;
  const cwd = opts.cwd || process.cwd();
  const result = await attempt({ ...opts, pr: opts.pr ?? true, cwd });
  if (!result) return GATE_EXIT.error;
  const { outcome, ctx } = result;
  const pr = ctx.pr;
  if (!pr?.sha) {
    console.error('spool gate status: no pull request found for this branch (pass --pr <number>).');
    return GATE_EXIT.error;
  }
  const description = gateSummary(outcome, ctx);
  let url = null;
  try {
    const { owner, name } = await ghRepo(cwd);
    url = await postGateStatus({
      owner,
      repo: name,
      sha: pr.sha,
      state: STATUS_STATE[outcome.decision],
      description,
      targetUrl: ctx.plan?.watch || null,
      cwd,
    });
  } catch (e) {
    // The verdict stands; only its publication failed. Say which, and keep the exit
    // code the gate decided — a status nobody could post must not read as a pass.
    console.error(`spool gate status: the verdict could not be posted: ${e.message}`);
    if (result.code === GATE_EXIT.ok) return GATE_EXIT.error;
    return result.code;
  }
  if (opts.json) console.log(JSON.stringify({ ...gateJson(result), status: { context: STATUS_CONTEXT, state: STATUS_STATE[outcome.decision], description, sha: pr.sha, pr: pr.number, url } }, null, 2));
  else {
    console.log(`${STATUS_CONTEXT}: ${STATUS_STATE[outcome.decision]} — ${description}`);
    console.log(`  PR #${pr.number} ${pr.url}`);
    console.log(explainGate(outcome, ctx));
  }
  return result.code;
}
