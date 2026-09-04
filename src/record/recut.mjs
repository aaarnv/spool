// Re-derive a take's step boundaries from its signal log. The video is never opened,
// never re-encoded and never re-recorded: a cut is numbers in timeline.json, so fixing
// one is a single pass over signals.jsonl. This is what makes a bad boundary cheap.

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { inferSteps, applyCutOps, parseSignals, MIN_STEP_S } from './signals.mjs';

export const SIGNALS_FILE = 'signals.jsonl';

/** Narration is keyed by step NAME, so it survives a cut that renumbers the steps. */
function carryNarration(steps, previous) {
  const byName = new Map();
  for (const s of previous || []) {
    if (s && s.name && s.narration) byName.set(s.name, s.narration);
  }
  if (!byName.size) return steps;
  return steps.map((s) => (s.narration || !byName.has(s.name) ? s : { ...s, narration: byName.get(s.name) }));
}

/**
 * Recut `workdir` in place.
 *
 * Returns `{ steps, previous, timeline }` and, unless `dryRun`, has rewritten
 * timeline.json with the previous cut saved beside it as timeline.prev.json.
 */
export async function recutWorkdir(workdir, { minStep = MIN_STEP_S, ops = [], dryRun = false } = {}) {
  workdir = path.resolve(workdir);
  const signalsPath = path.join(workdir, SIGNALS_FILE);
  const timelinePath = path.join(workdir, 'timeline.json');

  if (!existsSync(signalsPath)) {
    throw new Error(
      `no ${SIGNALS_FILE} in ${workdir} — this take was captured before signals were logged, so its cut cannot be re-derived. Re-record it with \`spool live\`.`
    );
  }
  if (!existsSync(timelinePath)) throw new Error(`no timeline.json in ${workdir}`);

  const signals = parseSignals(await readFile(signalsPath, 'utf8'));
  const timeline = JSON.parse(await readFile(timelinePath, 'utf8'));
  const previous = timeline.steps || [];

  const inferred = inferSteps(signals, { total: timeline.total, minStep });
  const steps = carryNarration(applyCutOps(inferred, ops), previous);

  const next = { ...timeline, steps };
  if (!dryRun) {
    await writeFile(path.join(workdir, 'timeline.prev.json'), JSON.stringify(timeline, null, 2) + '\n');
    await writeFile(timelinePath, JSON.stringify(next, null, 2) + '\n');
  }
  return { steps, previous, timeline: next };
}

export function formatCut(steps, { previous } = {}) {
  const was = new Map((previous || []).map((s) => [s.name, s]));
  const lines = steps.map((s) => {
    const dur = (s.end - s.start).toFixed(2);
    const mark = !was.size ? ' ' : was.has(s.name) ? ' ' : '+';
    const narr = s.narration ? '  voiced' : '';
    return `  ${mark} ${String(s.i).padStart(2)} ${s.name.padEnd(28)} ${String(s.start.toFixed(2)).padStart(7)}s..${s.end.toFixed(2)}s  (${dur}s, ${s.source || 'step'})${narr}`;
  });
  const head = `${steps.length} step(s)${previous ? ` (was ${previous.length})` : ''}`;
  return [head, ...lines].join('\n');
}
