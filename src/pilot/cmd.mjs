// `spool pilot` — the R6.1 dogfood harness.
//
// Three commands, one for each thing a pilot runner does: check the sample is the
// right shape (`scenarios`), gather the chains (`collect`), and read the numbers
// (`report`). Nothing here decides anything; the dataset is the deliverable, and
// docs/PILOT.md says how to read it.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { readRegister, synthesize } from './assumptions.mjs';
import { collect } from './collect.mjs';
import { formatChecklist, formatDataset, formatSynthesis } from './report.mjs';
import { coverage, readRoster } from './scenarios.mjs';

/** Exit codes every `spool pilot` command shares. */
export const PILOT_EXIT = {
  ok: 0,       // it ran
  gaps: 1,     // it ran, and the sample has coverage gaps R6.1 would fail on
  failed: 2,   // it could not run
};

const DEFAULT_OUT = 'pilot/dataset.json';
const DEFAULT_SYNTHESIS = 'pilot/assumptions.md';

/** Where `collect` scans for plan workdirs. */
function pilotRoots() {
  const env = (process.env.SPOOL_PILOT_ROOTS || '').split(':').map((s) => s.trim()).filter(Boolean);
  return env.length ? env.map((d) => resolve(d)) : [resolve(process.cwd(), 'spool')];
}

/** Read a dataset written by an earlier `collect`. */
async function readDataset(path) {
  const p = resolve(path);
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch (e) {
    throw new Error(`pilot: cannot read ${p} (${e.message}) — run \`spool pilot collect\` first`);
  }
}

/**
 * `spool pilot collect` — gather every rostered chain and write the dataset.
 *
 * Exits 1 when coverage is short, because that is the acceptance criterion R6.1 is
 * judged on: "enough complete chains to measure time-to-decision and rework". A pilot
 * that quietly ran on four UI features would otherwise report success.
 */
export async function pilotCollectCmd(opts = {}) {
  let data;
  try {
    data = await collect({
      // ./spool is where plan workdirs live. SPOOL_PILOT_ROOTS (colon-separated) is the
      // one case that needs more: collecting one dataset across several worktrees.
      roots: pilotRoots(),
      host: opts.host,
      token: opts.token,
      offline: !!opts.offline,
    });
  } catch (e) {
    console.error(e.message);
    return PILOT_EXIT.failed;
  }

  const out = resolve(DEFAULT_OUT);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(data, null, 2) + '\n');

  console.log(opts.json ? JSON.stringify(data, null, 2) : formatDataset(data));
  if (!opts.json) console.log(`\nwritten: ${out}`);
  return data.coverage.gaps.length ? PILOT_EXIT.gaps : PILOT_EXIT.ok;
}

/** `spool pilot report` — read a dataset back without collecting it again. */
export async function pilotReportCmd(path, opts = {}) {
  let data;
  try {
    data = await readDataset(path || DEFAULT_OUT);
  } catch (e) {
    console.error(e.message);
    return PILOT_EXIT.failed;
  }
  console.log(opts.json ? JSON.stringify(data, null, 2) : formatDataset(data));
  return data.coverage?.gaps?.length ? PILOT_EXIT.gaps : PILOT_EXIT.ok;
}

/**
 * `spool pilot scenarios` — the checklist: which real work runs as which shape.
 *
 * Reads the dataset when one exists, so the checklist shows progress rather than only
 * intent; without one it still prints the plan, which is what it is for before the
 * pilot starts.
 */
export async function pilotScenariosCmd(opts = {}) {
  let roster;
  try {
    roster = await readRoster();
  } catch (e) {
    console.error(e.message);
    return PILOT_EXIT.failed;
  }
  let chains = [];
  try {
    chains = (await readDataset(DEFAULT_OUT)).chains ?? [];
  } catch {
    /* no dataset yet: the checklist is intent only */
  }
  const cov = coverage(roster.entries, chains);
  console.log(opts.json ? JSON.stringify({ roster: roster.path, entries: roster.entries, coverage: cov }, null, 2) : formatChecklist(roster, cov));
  return cov.gaps.length ? PILOT_EXIT.gaps : PILOT_EXIT.ok;
}

/**
 * `spool pilot synthesize` — the R6.2 deliverable.
 *
 * Scores every assumption in the register against the collected dataset, and writes the
 * prioritised retained / changed / removed list. Exits 1 when nothing could be
 * answered, because a synthesis over an empty sample is a report about the pilot, not
 * about the product — and a run that returned 0 there would read as a result.
 *
 * The verdicts are arithmetic over thresholds written down before the data existed;
 * what the reader has to supply is the interpretation. See docs/PILOT-OBSERVATION.md.
 */
export async function pilotSynthesizeCmd(opts = {}) {
  let data;
  let register;
  try {
    data = await readDataset(DEFAULT_OUT);
    register = await readRegister();
  } catch (e) {
    console.error(e.message);
    return PILOT_EXIT.failed;
  }

  const synthesis = synthesize({ dataset: data, register });
  const text = formatSynthesis(synthesis);

  const out = resolve(DEFAULT_SYNTHESIS);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, ['# Pilot synthesis (R6.2)', '', '```', text, '```', ''].join('\n'));
  if (opts.json) console.log(JSON.stringify(synthesis, null, 2));
  else console.log(`${text}\n\nwritten: ${out}`);

  // Nothing answerable is a gap in the sample, which is exactly what `gaps` means here.
  return synthesis.assumptions.some((a) => a.verdict !== 'untested') ? PILOT_EXIT.ok : PILOT_EXIT.gaps;
}
