// The pilot dashboard: the dataset, read out loud.
//
// R6.1 asks for an instrumentation dashboard. This is it, and it is text on purpose —
// the pilot runs from a terminal beside the fleet, and a number nobody looks at is not
// instrumentation. `--json` prints the dataset itself, which is the contract; this
// module only ever formats it.

import { subjectOf } from './assumptions.mjs';
import { SCENARIO_LABEL } from './scenarios.mjs';

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Durations a human reads at a glance: minutes below an hour, then hours, then days. */
export function duration(msValue) {
  if (typeof msValue !== 'number' || !Number.isFinite(msValue)) return '—';
  if (msValue < MIN) return `${Math.round(msValue / 1000)}s`;
  if (msValue < HOUR) return `${Math.round(msValue / MIN)}m`;
  if (msValue < DAY) return `${(msValue / HOUR).toFixed(1)}h`;
  return `${(msValue / DAY).toFixed(1)}d`;
}

const pct = (v) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
const pad = (s, n) => String(s ?? '').padEnd(n);
const cut = (s, n) => (String(s ?? '').length > n ? String(s).slice(0, n - 1) + '…' : String(s ?? ''));

/** One chain per line: the shape, the state, and the three numbers that matter. */
function chainTable(chains) {
  const head = `  ${pad('task', 10)}${pad('scenario', 16)}${pad('state', 17)}${pad('rev', 4)}${pad('to-decide', 10)}${pad('to-proof', 9)}dev`;
  const rows = chains.map((c) => {
    const state = c.outcome === 'stopped' ? 'stopped' : (c.status ?? 'not published');
    return (
      `  ${pad(cut(c.taskKey, 9), 10)}${pad(cut(c.scenario, 15), 16)}${pad(cut(state, 16), 17)}` +
      `${pad(c.revisions || '—', 4)}${pad(duration(c.timeToFirstDecisionMs), 10)}${pad(duration(c.timeToProofMs), 9)}` +
      `${c.deviations ?? '—'}`
    );
  });
  return [head, ...rows].join('\n');
}

/** Coverage, per scenario: what was planned, what published, what closed. */
function coverageTable(cov) {
  const head = `  ${pad('scenario', 22)}${pad('planned', 9)}${pad('live', 6)}${pad('decided', 9)}closed`;
  const rows = cov.scenarios.map(
    (r) => `  ${pad(r.label, 22)}${pad(r.planned, 9)}${pad(r.live, 6)}${pad(r.decided, 9)}${r.closed}`
  );
  return [head, ...rows].join('\n');
}

/**
 * The whole dashboard.
 *
 * Order is the pilot's own question order: is the sample the right shape, how fast do
 * decisions come, how much rework do they cause, and did the loop close.
 */
export function formatDataset(data) {
  const s = data.summary;
  const out = [];

  out.push(`pilot dataset — ${data.chains.length} chains, generated ${data.generatedAt}`);
  out.push(`  host: ${data.host ?? 'offline'}   roster: ${data.roster.path}`);
  out.push('');

  out.push('coverage');
  out.push(coverageTable(data.coverage));
  if (data.coverage.gaps.length) {
    out.push('');
    for (const gap of data.coverage.gaps) out.push(`  gap: ${gap}`);
  }
  out.push('');

  out.push('chains');
  out.push(chainTable(data.chains));
  out.push('');

  out.push('decisions');
  out.push(`  published ${s.published}   decided ${s.decided}   approved ${s.approved}`);
  out.push(
    `  time to first decision: median ${duration(s.timeToDecisionMs.median)}` +
      `  p90 ${duration(s.timeToDecisionMs.p90)}  (n=${s.timeToDecisionMs.n})`
  );
  out.push('');

  out.push('rework');
  out.push(`  chains revised ${s.reworkChains}/${s.decided} (${pct(s.reworkRate)})   revisions ${s.revisionsTotal}`);
  out.push(`  chains redirected at least once: ${pct(s.redirectRate)}`);
  out.push('');

  out.push('proof');
  out.push(`  proved ${s.proved}   stopped ${s.stopped}   open ${s.open}   bypassed gate ${s.bypassed}`);
  out.push(`  proof rate (of approved): ${pct(s.proofRate)}`);
  out.push(`  deviations stated: ${s.deviationsStated} across ${s.chainsStatingDeviations} chains`);
  out.push(
    `  north star — approved → proof within ${s.northStar.window}: ` +
      `${s.northStar.closedInWindow}/${s.northStar.approved} (${pct(s.northStar.rate)})`
  );

  // Grouped by the note, not by the chain: "eighteen rows have no event log" is the
  // caveat, and printing it eighteen times buries the one row that is different.
  const byNote = new Map();
  for (const c of data.chains) for (const n of c.notes) byNote.set(n, [...(byNote.get(n) ?? []), c.taskKey]);
  if (byNote.size) {
    out.push('');
    out.push('what this run could not measure');
    for (const [note, keys] of byNote) out.push(`  ${note}\n    ${keys.length} chains: ${cut(keys.join(', '), 90)}`);
  }
  if (data.unrostered.length) {
    out.push('');
    out.push('plan workdirs not on the roster (add them, or leave them out of the sample on purpose)');
    for (const u of data.unrostered) out.push(`  ${u.taskKey ?? 'no links.task'} — ${u.dir}`);
  }
  return out.join('\n');
}

/** `spool pilot scenarios`: the checklist, with coverage when a dataset is at hand. */
export function formatChecklist(roster, cov) {
  const out = [`pilot scenario checklist — ${roster.entries.length} chains (${roster.path})`, ''];
  for (const scenario of Object.keys(SCENARIO_LABEL)) {
    const rows = roster.entries.filter((e) => e.scenario === scenario);
    const row = cov?.scenarios.find((r) => r.scenario === scenario);
    const tally = row ? `  [${row.closed} closed / ${row.live} live / ${row.planned} planned]` : `  [${rows.length} planned]`;
    out.push(`${SCENARIO_LABEL[scenario]}${tally}`);
    for (const e of rows) {
      out.push(`  ${pad(e.taskKey, 10)}${e.title}`);
      if (e.why) out.push(`  ${pad('', 10)}why: ${e.why}`);
      if (e.stop) out.push(`  ${pad('', 10)}stopped: ${e.stop.reason}`);
    }
    if (!rows.length) out.push('  (none planned)');
    out.push('');
  }
  if (cov?.gaps.length) {
    out.push('gaps');
    for (const gap of cov.gaps) out.push(`  ${gap}`);
  }
  return out.join('\n').trimEnd();
}

// ---------------------------------------------------------------------------
// The R6.2 synthesis
// ---------------------------------------------------------------------------

const VERDICT_HEAD = {
  removed: 'removed — the evidence refutes these',
  changed: 'changed — the evidence is between the two thresholds these were registered with',
  retained: 'retained — the evidence supports these',
  untested: 'not yet answerable — the sample is too small to say',
};

/** One assumption, with the number behind it and the chains that number came from. */
function assumptionBlock(a) {
  const m = a.metric;
  const value = m.unit === 'rate' ? pct(m.value) : m.unit === 'ms' ? duration(m.value) : (m.value ?? '—');
  const out = [
    `  [w${a.weight}] ${a.id}`,
    `    ${a.claim}`,
    `    ${m.label}${m.arg ? ` (${m.arg})` : ''}: ${value}  (n=${m.n} ${subjectOf(m, m.n)}, need ${m.minSample})`,
    `    why: ${a.because}`,
  ];
  if (a.chains.length) out.push(`    chains: ${cut(a.chains.join(', '), 88)}`);
  if (a.verdict !== 'retained' && a.ifRemoved) out.push(`    so what: ${a.ifRemoved}`);
  for (const q of a.quotes) out.push(`    "${cut(q.text, 84)}" — ${q.taskKey ?? 'unrostered'} (${q.field})`);
  return out.join('\n');
}

/**
 * The R6.2 report: what the pilot retained, changed and removed.
 *
 * Coverage is printed FIRST and the one-participant limit with it, because every
 * verdict underneath is only worth what those two lines say it is. A reader who stops
 * after the header should already know this is a hypothesis list.
 */
export function formatSynthesis(data) {
  const c = data.coverage;
  const o = data.observation;
  const out = [];

  out.push(`pilot synthesis — ${data.register.assumptions} assumptions, generated ${data.generatedAt}`);
  out.push(`  register: ${data.register.path ?? '(packaged)'}`);
  out.push('');
  out.push('what this rests on');
  out.push(`  chains ${c.chains}   decided ${c.decidedChains}   observed ${c.observedChains}   notes ${c.notes}`);
  out.push(`  participants: ${c.participants}. One person cannot be an operator, a decider and a`);
  out.push('  reviewer separately, so everything below is a hypothesis to test with somebody else,');
  out.push('  never a validated finding. See docs/PILOT-OBSERVATION.md.');
  out.push('');

  out.push('what the sessions did');
  out.push(`  decided before the video ended: ${pct(o.decidedBeforeEndRate)} of ${o.withDecision}`);
  out.push(`  median first frame to decision: ${duration(o.medianSessionToDecisionMs)}   median watched: ${pct(o.medianWatchedRatio)}`);
  if (o.chapters.length) {
    out.push(`  ${pad('chapter', 12)}${pad('skipped', 10)}rewatched`);
    for (const ch of o.chapters) out.push(`  ${pad(ch.id, 12)}${pad(pct(ch.skipRate), 10)}${pct(ch.rewatchRate)}`);
  } else {
    out.push('  no chapter coverage recorded yet');
  }
  out.push(`  effect: decision ${o.effect.quality}   presentation ${o.effect.presentation}   neither ${o.effect.neither}`);
  out.push(`  would require again: yes ${o.wouldRequire.yes}   no ${o.wouldRequire.no}   unsure ${o.wouldRequire.unsure}`);
  out.push('');

  for (const verdict of ['removed', 'changed', 'retained', 'untested']) {
    const rows = data.assumptions.filter((a) => a.verdict === verdict);
    if (!rows.length) continue;
    out.push(`${VERDICT_HEAD[verdict]}`);
    for (const a of rows) out.push(assumptionBlock(a));
    out.push('');
  }

  return out.join('\n').trimEnd();
}
