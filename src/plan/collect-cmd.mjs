// `spool plan evidence` — attach the proof an agent already produced.
//
// The agent changed files, ran a test, recorded a browser. This command reads
// those, turns them into descriptors (src/plan/collect.mjs) and merges them into
// the workdir's evidence.json, so a plan claim can cite the thing that caused it.
//
// Contract: CONTRACTS.md "Plan Spools" -> "Evidence adapters".

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { EVIDENCE_FILE, PLAN_FILE, repoRoot } from './plan.mjs';
import { validateEvidence, validatePacket } from './schema.mjs';
import {
  commitEvidence,
  consoleEvidence,
  diffEvidence,
  keyframeEvidence,
  mergeEvidence,
  testEvidence,
} from './collect.mjs';
import {
  readChangedFiles,
  readCommit,
  readConsoleLog,
  readKeyframes,
  recordingCommand,
  repoRelative,
  runTestCommand,
} from './collect-sources.mjs';

/** What `--all` turns on. `--test` stays out: it runs a command the agent must name. */
export const DEFAULT_COLLECTORS = ['diff', 'commit', 'console', 'keyframes'];

/**
 * Gather every requested collector into one list of descriptors, with a note per
 * collector for the report. Never throws: a collector with nothing to read says
 * so and the others still run.
 */
export async function collectEvidence(workdir, opts = {}) {
  const dir = resolve(workdir);
  const chapterIds = opts.chapter ? [opts.chapter] : [];
  const notes = [];
  const items = [];
  const want = new Set(opts.collectors || []);

  const commit = want.has('commit') || want.has('diff') ? await readCommit(dir) : null;

  if (want.has('diff')) {
    const changed = await readChangedFiles({ cwd: dir, base: opts.base ?? null });
    if (!changed) {
      notes.push({ collector: 'diff', level: 'warn', text: 'no git checkout here, so no diff was collected' });
    } else if (!changed.files.length) {
      notes.push({ collector: 'diff', level: 'warn', text: `no changed files ${opts.base ? `in ${opts.base}...HEAD` : 'in the working tree'}` });
    } else {
      const built = diffEvidence({ files: changed.files, revision: commit?.sha ?? null, chapterIds });
      items.push(...built.items);
      notes.push({
        collector: 'diff',
        level: 'info',
        text: `${built.items.length} of ${changed.total} changed file(s)${built.dropped || changed.total > changed.files.length ? ` — ${changed.total - built.items.length} not attached (cap)` : ''}`,
      });
    }
  }

  if (want.has('commit')) {
    if (!commit) {
      notes.push({ collector: 'commit', level: 'warn', text: 'no git checkout with a commit here' });
    } else {
      const changed = await readChangedFiles({ cwd: dir, base: opts.base ?? null });
      const built = commitEvidence({
        sha: commit.sha,
        branch: commit.branch,
        subject: commit.subject,
        changedFiles: (changed?.files || []).map((f) => f.path),
        chapterIds,
      });
      items.push(...built.items);
      notes.push({ collector: 'commit', level: 'info', text: `${commit.branch || 'detached HEAD'} at ${commit.sha.slice(0, 7)}` });
    }
  }

  // A test command runs from the REPOSITORY ROOT, not the spool workdir: an
  // agent types the command it would type in a terminal ("npm test"), and every
  // path in it is relative to the project, not to spool/<slug>/.
  const from = repoRoot(dir) || dir;
  for (const command of opts.tests || []) {
    const run = await runTestCommand({ cwd: from, command, onData: opts.onTestOutput ?? null });
    const built = testEvidence({ ...run, chapterIds });
    items.push(...built.items);
    notes.push({
      collector: 'test',
      level: run.exitCode === 0 ? 'info' : 'warn',
      text: run.timedOut
        ? `${command} timed out and was killed`
        : `${command} exited ${run.exitCode} after ${(run.durationMs / 1000).toFixed(1)}s`,
    });
  }

  if (want.has('console')) {
    const events = await readConsoleLog(dir);
    if (events === null) {
      notes.push({ collector: 'console', level: 'warn', text: 'no console.jsonl in this workdir (record first)' });
    } else {
      const dirRef = repoRelative(repoRoot(dir) || dir, dir) || basename(dir);
      const built = consoleEvidence({ command: await recordingCommand(dir, dirRef), events, chapterIds });
      items.push(...built.items);
      notes.push({ collector: 'console', level: built.errors ? 'warn' : 'info', text: `${built.errors} error(s), ${built.warnings} warning(s) in ${events.length} event(s)` });
    }
  }

  if (want.has('keyframes')) {
    const shot = await readKeyframes(dir);
    if (!shot || !shot.frames.length) {
      notes.push({ collector: 'keyframes', level: 'warn', text: 'no keyframes/ or share/frames/ in this workdir (record first)' });
    } else {
      const built = keyframeEvidence({ frames: shot.frames, url: shot.url, chapterIds });
      items.push(...built.items);
      notes.push({ collector: 'keyframes', level: 'info', text: `${built.items.length} descriptor(s) from ${built.total} keyframe(s)${built.dropped ? ` — ${built.dropped} not attached (cap)` : ''}` });
    }
  }

  return { items, notes };
}

/**
 * Collect, merge and write evidence.json.
 * Returns the report `spool plan evidence` prints; `--dry-run` produces the same
 * report with nothing written.
 */
export async function evidenceCmd(workdir, opts = {}) {
  const dir = resolve(workdir);
  if (!existsSync(dir)) return { code: 2, error: `no such workdir: ${dir}` };
  if (!existsSync(join(dir, PLAN_FILE))) {
    return { code: 2, error: `${join(dir, PLAN_FILE)} does not exist — evidence backs a plan's claims. Run \`spool plan init\` first.` };
  }

  // Read for one question only: does any claim cite a descriptor? A packet that does
  // not parse is `spool plan validate`'s to report, so a broken plan.json costs the
  // warning and nothing else.
  let plan = null;
  try {
    plan = JSON.parse(await readFile(join(dir, PLAN_FILE), 'utf8'));
  } catch {
    plan = null;
  }

  const { items, notes } = await collectEvidence(dir, opts);
  const path = join(dir, EVIDENCE_FILE);
  let existing = null;
  if (existsSync(path)) {
    try {
      existing = JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      return { code: 1, error: `${path} is not valid JSON (${e.message}); fix or delete it before collecting` };
    }
  }

  const merged = mergeEvidence(existing, items);
  // The written bundle is validated with the same gate `spool plan validate`
  // runs: a collector that produced something the packet layer rejects is a bug
  // here, and it must not reach the workdir as a file the author has to repair.
  const check = validateEvidence(merged.evidence);
  if (!check.ok) {
    return { code: 1, error: 'the collected descriptors did not validate', notes, diagnostics: check.errors };
  }

  // Collected, validated — and cited by nothing. The rule itself is the packet's
  // (`uncited-evidence` in validatePacket), so the collector states it in the run that
  // caused it rather than owning a second copy of it. Said once, and only when the
  // packet parses: a broken plan.json is `spool plan validate`'s to report.
  if (plan !== null) {
    const uncited = validatePacket({ plan, evidence: merged.evidence }).warnings.find((w) => w.code === 'uncited-evidence');
    if (uncited) notes.push({ collector: 'plan', level: 'warn', text: uncited.message });
  }

  if (!opts.dryRun) await writeFile(path, JSON.stringify(merged.evidence, null, 2) + '\n');
  return {
    code: 0,
    path,
    notes,
    added: merged.added,
    replaced: merged.replaced,
    skipped: merged.skipped,
    warnings: check.warnings,
    dryRun: Boolean(opts.dryRun),
    total: merged.evidence.items.length,
  };
}

/** The human report. Plain language first, ids second — the same order as a card. */
export function formatEvidenceReport(result) {
  if (result.error) {
    const lines = [`[plan evidence] ${result.error}`];
    for (const d of result.diagnostics || []) lines.push(`  ${d.path}: ${d.message}`);
    return lines.join('\n');
  }
  const lines = [];
  for (const note of result.notes) lines.push(`  ${note.level === 'warn' ? '!' : '-'} ${note.collector}: ${note.text}`);
  const changes = [];
  if (result.added.length) changes.push(`added ${result.added.length}`);
  if (result.replaced.length) changes.push(`updated ${result.replaced.length}`);
  lines.push(`[plan evidence] ${changes.length ? changes.join(', ') : 'no change'} — ${result.total} descriptor(s) in ${result.path}${result.dryRun ? ' (dry run, nothing written)' : ''}`);
  for (const id of result.added) lines.push(`  + ${id}`);
  for (const id of result.replaced) lines.push(`  ~ ${id}`);
  // A cap that drops evidence is always printed: silence would read as coverage.
  for (const s of result.skipped) lines.push(`  x ${s.id}: not attached — ${s.reason}`);
  for (const w of result.warnings || []) lines.push(`  ! ${w.path}: ${w.message}`);
  if (result.added.length || result.replaced.length) {
    lines.push('  Cite these ids from the claims they support: "evidence": ["<id>"] on an outcome, approach step or risk.');
  }
  return lines.join('\n');
}
