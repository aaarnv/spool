// `spool reliability` — read the local journal and say whether Spool is meeting
// the R6.3 targets on this machine, and which runbook recovers what is not.

import { existsSync } from 'node:fs';
import { journalPath, journalRoot, readJournal } from './journal.mjs';
import { exitCodeFor, formatReport, summarize } from './report.mjs';

/** `--since 7d | 24h | 2026-08-01` → an ISO cutoff, or null when it means "all of it". */
export function parseSince(input, now = Date.now()) {
  if (!input) return null;
  const relative = String(input).match(/^(\d+)\s*([hdw])$/i);
  if (relative) {
    const [, n, unit] = relative;
    const hours = { h: 1, d: 24, w: 24 * 7 }[unit.toLowerCase()];
    return new Date(now - Number(n) * hours * 3600_000).toISOString();
  }
  const at = Date.parse(input);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

export async function reliabilityCmd({ dir = null, json = false, since = null } = {}) {
  const root = journalRoot(dir || process.cwd());
  const path = journalPath(root);
  const cutoff = parseSince(since);
  const rows = await readJournal(root, { since: cutoff });
  const report = summarize(rows);

  if (json) {
    console.log(
      JSON.stringify(
        { journal: existsSync(path) ? path : null, since: cutoff, ...report, verdictExit: exitCodeFor(report) },
        null,
        2
      )
    );
  } else {
    console.log(formatReport(report, { path: existsSync(path) ? path : null, since: cutoff }));
    if (rows.length === 0) {
      console.log('');
      console.log('Nothing recorded yet. Record, render or publish a spool and run this again.');
      console.log('Targets and recovery paths: docs/PLAN-SPOOLS-RELIABILITY.md');
    }
  }
  return exitCodeFor(report);
}
