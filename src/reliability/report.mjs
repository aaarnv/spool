// `spool reliability`: what the local journal says about the eight failure points.
//
// Pure aggregation over the rows journal.mjs wrote, plus the text a person reads.
// The verdict itself is `operationHealth` from signals.mjs — the same function the
// server's dashboard note uses — so a local report and the hosted one cannot
// disagree about whether a number is acceptable.

import { RELIABILITY_OPERATIONS, operationHealth, worstVerdict } from './signals.mjs';

/** Percentile over a sorted-in-place copy. Nearest-rank, which is honest at n=3. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

/**
 * Fold journal rows into one report.
 *
 * Every operation appears, including the ones with no rows: "we have never
 * measured this" is a finding, not an empty space. That is the difference between
 * a reliability baseline and a success wall.
 */
export function summarize(rows, { operations = RELIABILITY_OPERATIONS } = {}) {
  const byOperation = new Map(operations.map((op) => [op, { ok: 0, retried: 0, failed: 0, durations: [], reasons: new Map(), lastFailure: null }]));
  for (const row of rows) {
    const bucket = byOperation.get(row.operation);
    if (!bucket) continue;
    if (row.outcome === 'ok' || row.outcome === 'retried' || row.outcome === 'failed') bucket[row.outcome] += 1;
    if (Number.isFinite(row.ms)) bucket.durations.push(row.ms);
    if (row.outcome === 'failed') {
      const key = row.reason || 'unknown';
      bucket.reasons.set(key, (bucket.reasons.get(key) ?? 0) + 1);
      if (!bucket.lastFailure || String(row.at) >= String(bucket.lastFailure.at)) bucket.lastFailure = row;
    }
  }

  const items = operations.map((op) => {
    const b = byOperation.get(op);
    const health = operationHealth(op, b);
    return {
      ...health,
      p50Ms: percentile(b.durations, 50),
      p95Ms: percentile(b.durations, 95),
      reasons: [...b.reasons.entries()].sort((a, b2) => b2[1] - a[1]).map(([reason, count]) => ({ reason, count })),
      lastFailure: b.lastFailure,
    };
  });

  return {
    rows: rows.length,
    operations: items,
    verdict: worstVerdict(items),
    breached: items.filter((i) => i.verdict === 'breached').map((i) => i.operation),
  };
}

const pct = (rate) => (rate === null ? '   —' : `${(rate * 100).toFixed(1).padStart(5)}%`);
const ms = (v) => (v === null ? '—' : `${v}ms`);

const MARK = { met: 'ok  ', at_risk: 'warn', breached: 'FAIL', unknown: '?   ' };

/** The report as a person reads it: the verdict first, then what to do about it. */
export function formatReport(report, { path = null, since = null } = {}) {
  const lines = [];
  lines.push(`── spool reliability${since ? ` (since ${since})` : ''}`);
  lines.push(path ? `journal: ${path} (${report.rows} attempt[s])` : `journal: none (${report.rows} attempt[s])`);
  lines.push('');
  // Built with the same padding as a row, so the columns line up without counting spaces.
  lines.push(
    ['     ' + 'operation'.padEnd(13), '  rate', ' target', ' attempts', '  ok/retried/failed'.padEnd(19), 'p95'].join(' ')
  );
  for (const item of report.operations) {
    const t = item.target;
    lines.push(
      [
        `${MARK[item.verdict]} ${item.operation.padEnd(13)}`,
        pct(item.rate),
        `${(t.objective * 100).toFixed(0).padStart(6)}%`,
        String(item.attempts).padStart(9),
        `  ${item.ok}/${item.retried}/${item.failed}`.padEnd(19),
        ms(item.p95Ms),
      ].join(' ')
    );
  }

  const trouble = report.operations.filter((i) => i.failed > 0 || i.verdict === 'breached' || i.verdict === 'at_risk');
  if (trouble.length) {
    lines.push('');
    lines.push('what failed:');
    for (const item of trouble) {
      const reasons = item.reasons.map((r) => `${r.reason} x${r.count}`).join(', ') || 'no recorded failures';
      lines.push(`  ${item.operation}: ${reasons}`);
      if (item.lastFailure?.detail) lines.push(`    last: ${item.lastFailure.at} — ${item.lastFailure.detail}`);
      lines.push(`    recover: ${item.target.runbook} (docs/PLAN-SPOOLS-RUNBOOKS.md)`);
    }
  }

  lines.push('');
  lines.push(
    report.verdict === 'breached'
      ? `verdict: BREACHED — ${report.breached.join(', ')} below target`
      : report.verdict === 'at_risk'
        ? 'verdict: at risk — one or more operations are inside the margin'
        : report.verdict === 'unknown'
          ? 'verdict: not enough attempts yet to judge every operation'
          : 'verdict: every measured operation is meeting its target'
  );
  return lines.join('\n');
}

/** 0 nothing breached · 1 a target is breached · 2 nothing measured yet. */
export function exitCodeFor(report) {
  if (report.rows === 0) return 2;
  return report.verdict === 'breached' ? 1 : 0;
}
