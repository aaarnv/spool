// The R6.2 deliverable: which product assumptions the pilot retained, changed, or
// removed — and which it still cannot answer.
//
// The roadmap asks for "a prioritized evidence-backed list of retained, changed, and
// removed assumptions". Two things make that list honest rather than a story told after
// the fact:
//
//   1. **The thresholds are pre-registered.** An assumption in docs/pilot/assumptions.json
//      declares what would support it and what would refute it BEFORE the data exists.
//      A verdict is then arithmetic, not judgement, and it cannot be tuned once the
//      numbers are in. This is the whole reason the synthesis is automated while the
//      observation is not (R6.2 non-functional requirement).
//   2. **Every verdict names its chains.** A metric returns the task keys it was
//      computed from, so no claim in the report is unattributed — the roadmap's other
//      non-functional requirement.
//
// The sentences a person wrote are never classified. They are QUOTED, under the
// assumption whose register entry asks for them, with the chain they came from. There
// is no sentiment model here and there should not be one: with a sample this size, a
// classifier would invent signal that the reader can just read.
//
// Pure. `collect` fetches, `cmd.mjs` prints, this module only decides.
//
// See docs/PILOT-OBSERVATION.md.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { observationSummary, quotes } from './observe.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** Where a register lives, inside whichever repository is being piloted. */
export const REGISTER_FILE = 'docs/pilot/assumptions.json';

export const REGISTER_VERSION = 1;

/** The packaged register. Same fallback rule as the roster (scenarios.mjs). */
export const defaultRegisterPath = (cwd = process.cwd()) => {
  const local = resolve(cwd, REGISTER_FILE);
  return existsSync(local) ? local : join(root, REGISTER_FILE);
};

export const REGISTER_PATH = join(root, REGISTER_FILE);

/**
 * The four verdicts.
 *
 * `untested` is not a failure of the synthesis; it is the most likely answer early, and
 * saying it plainly is what stops a two-chain pilot reading like a result.
 */
export const VERDICTS = ['removed', 'changed', 'retained', 'untested'];

/** How much a verdict should move the reader. Priority is weight × this. */
const IMPACT = { removed: 3, changed: 2, retained: 1, untested: 0 };

const OPS = {
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
  '<=': (a, b) => a <= b,
  '<': (a, b) => a < b,
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const keysOf = (rows) => [...new Set(rows.map((r) => r.taskKey).filter(Boolean))];

const rate = (matching, all) => ({
  value: all.length ? Math.round((matching.length / all.length) * 1000) / 1000 : null,
  n: all.length,
  chains: keysOf(all),
});

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const notes = (obs) => obs.filter((o) => o.note);
const decided = (obs) => obs.filter((o) => o.decisionAction);

/**
 * The closed metric catalog.
 *
 * A register entry may only name one of these. That is deliberate: a register that
 * could declare its own expression would let an assumption be re-scored by rewriting
 * the question, which is the thing pre-registration exists to prevent.
 *
 * Every metric returns `{ value, n, chains }` — the number, its denominator, and the
 * chains it came from. `unit` says how to print it, and `subject` says what the
 * denominator counts, so a report can never label a rate over sessions as a rate over
 * chains.
 */
export const METRICS = {
  effectQualityRate: {
    label: 'notes saying the video changed the decision',
    unit: 'rate',
    subject: 'note',
    subjects: 'notes',
    compute: ({ observations }) => {
      const all = notes(observations);
      return rate(all.filter((o) => o.note.effect === 'quality'), all);
    },
  },
  effectAnyRate: {
    label: 'notes saying the video helped at all',
    unit: 'rate',
    subject: 'note',
    subjects: 'notes',
    compute: ({ observations }) => {
      const all = notes(observations);
      return rate(all.filter((o) => o.note.effect && o.note.effect !== 'neither'), all);
    },
  },
  decidedBeforeEndRate: {
    label: 'decisions made before the video ended',
    unit: 'rate',
    subject: 'observed decision',
    subjects: 'observed decisions',
    compute: ({ observations }) => {
      const all = decided(observations);
      return rate(all.filter((o) => o.decidedBeforeEnd === true), all);
    },
  },
  chapterSkipRate: {
    label: 'sessions that skipped the chapter',
    unit: 'rate',
    subject: 'session that saw it',
    subjects: 'sessions that saw it',
    needsArg: true,
    compute: ({ observations }, chapterId) => {
      const all = observations.filter((o) => o.chapters.some((c) => c.id === chapterId));
      return rate(all.filter((o) => o.chapters.find((c) => c.id === chapterId)?.skipped), all);
    },
  },
  chapterRewatchRate: {
    label: 'sessions that played the chapter twice',
    unit: 'rate',
    subject: 'session that saw it',
    subjects: 'sessions that saw it',
    needsArg: true,
    compute: ({ observations }, chapterId) => {
      const all = observations.filter((o) => o.chapters.some((c) => c.id === chapterId));
      return rate(all.filter((o) => o.chapters.find((c) => c.id === chapterId)?.rewatched), all);
    },
  },
  stillNeededRate: {
    label: 'notes naming text the reviewer still needed',
    unit: 'rate',
    subject: 'note',
    subjects: 'notes',
    compute: ({ observations }) => {
      const all = notes(observations);
      return rate(all.filter((o) => o.note.stillNeeded), all);
    },
  },
  distrustRate: {
    label: 'notes naming something that caused distrust',
    unit: 'rate',
    subject: 'note',
    subjects: 'notes',
    compute: ({ observations }) => {
      const all = notes(observations);
      return rate(all.filter((o) => o.note.distrust), all);
    },
  },
  wouldRequireYesRate: {
    label: 'notes that would require a plan spool for this class of work',
    unit: 'rate',
    subject: 'note',
    subjects: 'notes',
    compute: ({ observations }) => {
      const all = notes(observations);
      return rate(all.filter((o) => o.note.wouldRequire === 'yes'), all);
    },
  },
  medianSessionToDecisionMs: {
    label: 'median time from the first frame to the decision',
    unit: 'ms',
    subject: 'observed decision',
    subjects: 'observed decisions',
    compute: ({ observations }) => {
      const all = decided(observations).filter((o) => typeof o.sessionToDecisionMs === 'number');
      return { value: median(all.map((o) => o.sessionToDecisionMs)), n: all.length, chains: keysOf(all) };
    },
  },
  medianTimeToDecisionMs: {
    label: 'median time from publishing to the first decision',
    unit: 'ms',
    subject: 'decided chain',
    subjects: 'decided chains',
    compute: ({ chains }) => {
      const all = chains.filter((c) => typeof c.timeToFirstDecisionMs === 'number');
      return { value: median(all.map((c) => c.timeToFirstDecisionMs)), n: all.length, chains: keysOf(all) };
    },
  },
  reworkRate: {
    label: 'decided chains that needed a revision',
    unit: 'rate',
    subject: 'decided chain',
    subjects: 'decided chains',
    compute: ({ chains }) => {
      const all = chains.filter((c) => c.firstDecisionAt);
      return rate(all.filter((c) => c.rework > 0), all);
    },
  },
  proofRate: {
    label: 'approved chains that reached a proof',
    unit: 'rate',
    subject: 'approved chain',
    subjects: 'approved chains',
    compute: ({ chains }) => {
      const all = chains.filter((c) => c.approvedAt);
      return rate(all.filter((c) => c.proof), all);
    },
  },
  northStarRate: {
    label: 'approved chains that reached a proof inside the window',
    unit: 'rate',
    subject: 'approved chain',
    subjects: 'approved chains',
    compute: ({ chains }) => {
      const all = chains.filter((c) => c.approvedAt);
      return rate(all.filter((c) => c.closedInWindow === true), all);
    },
  },
  bypassRate: {
    label: 'chains where work started without an approved plan',
    unit: 'rate',
    subject: 'work start',
    subjects: 'work starts',
    compute: ({ chains }) => {
      const all = chains.filter((c) => c.implementation?.startedAt || c.implementation?.bypassed !== null);
      return rate(all.filter((c) => c.implementation?.bypassed === true), all);
    },
  },
};

// ---------------------------------------------------------------------------
// The register
// ---------------------------------------------------------------------------

const isText = (v) => typeof v === 'string' && v.trim().length > 0;

const isThreshold = (v) =>
  !!v && typeof v === 'object' && !Array.isArray(v) && Object.prototype.hasOwnProperty.call(OPS, v.op) && Number.isFinite(v.value);

/** Validate a parsed register. Same `{ ok, errors, warnings }` shape as the roster. */
export function validateRegister(value) {
  const errors = [];
  const warnings = [];
  const error = (path, code, message) => errors.push({ path, code, message });
  const warn = (path, code, message) => warnings.push({ path, code, message });

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    error('', 'invalid-type', 'assumptions.json must be a JSON object');
    return { ok: false, errors, warnings };
  }
  if (value.version !== REGISTER_VERSION) {
    error('version', 'invalid-version', `version must be ${REGISTER_VERSION} (got ${JSON.stringify(value.version)})`);
  }
  if (!Array.isArray(value.assumptions)) {
    error('assumptions', 'required', 'assumptions must be an array');
    return { ok: errors.length === 0, errors, warnings };
  }

  const ids = new Set();
  value.assumptions.forEach((a, i) => {
    const path = `assumptions[${i}]`;
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      error(path, 'invalid-type', `${path} must be an object`);
      return;
    }
    if (!isText(a.id)) error(`${path}.id`, 'required', `${path}.id is required`);
    else if (ids.has(a.id)) error(`${path}.id`, 'duplicate', `${path}.id "${a.id}" is listed twice`);
    else ids.add(a.id);

    if (!isText(a.claim)) error(`${path}.claim`, 'required', `${path}.claim is required: one sentence, stated as a belief`);
    if (!isText(a.source)) warn(`${path}.source`, 'missing-source', `${path}.source should name the doc this belief comes from`);
    if (!Number.isInteger(a.weight) || a.weight < 1 || a.weight > 3) {
      error(`${path}.weight`, 'invalid-weight', `${path}.weight must be 1, 2 or 3 (how load-bearing this belief is)`);
    }

    const metric = METRICS[a.metric];
    if (!metric) {
      error(`${path}.metric`, 'unknown-metric', `${path}.metric must be one of ${Object.keys(METRICS).join(', ')}`);
    } else if (metric.needsArg && !isText(a.arg)) {
      error(`${path}.arg`, 'required', `${path}.arg is required for ${a.metric} (the chapter id it measures)`);
    }

    // Both thresholds, always. An assumption that says what would confirm it but not
    // what would refute it is unfalsifiable, and the register exists to stop that.
    if (!isThreshold(a.supportIf)) error(`${path}.supportIf`, 'invalid-threshold', `${path}.supportIf must be { op, value }`);
    if (!isThreshold(a.rejectIf)) error(`${path}.rejectIf`, 'invalid-threshold', `${path}.rejectIf must be { op, value }`);
    if (isThreshold(a.supportIf) && isThreshold(a.rejectIf) && OPS[a.supportIf.op](a.rejectIf.value, a.supportIf.value)) {
      error(
        `${path}.rejectIf`,
        'overlapping-thresholds',
        `${path}: a value can satisfy both supportIf and rejectIf, so the verdict would depend on the order they are checked`
      );
    }
    if (!Number.isInteger(a.minSample) || a.minSample < 1) {
      error(`${path}.minSample`, 'invalid-sample', `${path}.minSample must be a positive integer`);
    }
    if (a.quotes !== undefined && (!Array.isArray(a.quotes) || a.quotes.some((q) => !isText(q)))) {
      error(`${path}.quotes`, 'invalid-type', `${path}.quotes must be an array of note field names`);
    }
    if (!isText(a.ifRemoved)) {
      warn(`${path}.ifRemoved`, 'missing-consequence', `${path}.ifRemoved should say what changes if this belief is wrong`);
    }
  });

  return { ok: errors.length === 0, errors, warnings };
}

/** Read and validate the register. Throws with the diagnostics on an invalid one. */
export async function readRegister(path = defaultRegisterPath()) {
  if (!existsSync(path)) throw new Error(`pilot: no assumption register at ${path} (see docs/PILOT-OBSERVATION.md)`);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    throw new Error(`pilot: ${path} is not valid JSON: ${e.message}`);
  }
  const res = validateRegister(parsed);
  if (!res.ok) {
    throw new Error(`pilot: ${path} is invalid:\n${res.errors.map((d) => `  ${d.path}: ${d.message}`).join('\n')}`);
  }
  return { ...parsed, path, warnings: res.warnings };
}

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

/**
 * Score one assumption.
 *
 * Order matters and is fixed: sample size first, then support, then rejection, then the
 * gap between them. An assumption whose evidence is thin is `untested` even when the
 * number looks decisive, because two sessions agreeing is not a finding.
 */
export function scoreAssumption(assumption, context) {
  const metric = METRICS[assumption.metric];
  const measured = metric.compute(context, assumption.arg);
  const { value, n, chains } = measured;

  let verdict = 'untested';
  let because;
  if (n < assumption.minSample || value === null) {
    because = `${n} of ${assumption.minSample} ${subjectOf(metric, assumption.minSample)} needed`;
  } else if (OPS[assumption.supportIf.op](value, assumption.supportIf.value)) {
    verdict = 'retained';
    because = `${fmt(value, metric.unit)} ${assumption.supportIf.op} ${fmt(assumption.supportIf.value, metric.unit)}`;
  } else if (OPS[assumption.rejectIf.op](value, assumption.rejectIf.value)) {
    verdict = 'removed';
    because = `${fmt(value, metric.unit)} ${assumption.rejectIf.op} ${fmt(assumption.rejectIf.value, metric.unit)}`;
  } else {
    verdict = 'changed';
    because = `${fmt(value, metric.unit)} is between the two thresholds this was registered with`;
  }

  return {
    id: assumption.id,
    claim: assumption.claim,
    source: assumption.source ?? null,
    weight: assumption.weight,
    verdict,
    because,
    priority: assumption.weight * IMPACT[verdict],
    metric: {
      id: assumption.metric,
      arg: assumption.arg ?? null,
      label: metric.label,
      unit: metric.unit,
      subject: metric.subject,
      subjects: metric.subjects,
      value,
      n,
      minSample: assumption.minSample,
      supportIf: assumption.supportIf,
      rejectIf: assumption.rejectIf,
    },
    // The traceability requirement, made structural: an assumption's verdict prints the
    // chains it was computed from, so no claim in the report is unattributed.
    chains,
    quotes: (assumption.quotes ?? []).flatMap((field) =>
      quotes(context.observations, field).map((q) => ({ field, ...q }))
    ),
    ifRemoved: assumption.ifRemoved ?? null,
  };
}

/**
 * How to name a metric's denominator for a count.
 *
 * Both forms are spelled out in the catalog rather than derived: "approved chain" and
 * "session that saw it" pluralise in different places, and a report that says
 * "0 approveds chain" reads as a bug in the finding.
 */
export const subjectOf = (metric, count) => (count === 1 ? metric.subject : metric.subjects);

const fmt = (value, unit) => {
  if (value === null) return '—';
  if (unit === 'rate') return `${Math.round(value * 100)}%`;
  if (unit === 'ms') return duration(value);
  return String(value);
};

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Same reading rules as the pilot dashboard (report.mjs), so one number reads one way. */
export function duration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—';
  if (ms < MIN) return `${Math.round(ms / 1000)}s`;
  if (ms < HOUR) return `${Math.round(ms / MIN)}m`;
  if (ms < DAY) return `${(ms / HOUR).toFixed(1)}h`;
  return `${(ms / DAY).toFixed(1)}d`;
}

/**
 * The whole synthesis: every assumption, scored, prioritised, with its evidence.
 *
 * Sorted by priority — weight × how far the evidence moved the belief — so the list
 * opens on the load-bearing beliefs the pilot actually changed, and the untested ones
 * fall to the end where they read as a gap rather than a result.
 */
export function synthesize({ dataset, register, now = new Date() }) {
  const chains = Array.isArray(dataset?.chains) ? dataset.chains : [];
  const observations = chains.flatMap((c) => c.observations ?? []);
  const context = { chains, observations };

  const scored = register.assumptions
    .map((a) => scoreAssumption(a, context))
    .sort((a, b) => b.priority - a.priority || b.weight - a.weight || a.id.localeCompare(b.id));

  const decidedChains = chains.filter((c) => c.firstDecisionAt);
  const observedChains = new Set(observations.map((o) => o.taskKey).filter(Boolean));

  return {
    version: 1,
    kind: 'pilot-synthesis',
    generatedAt: now.toISOString(),
    dataset: { generatedAt: dataset?.generatedAt ?? null, chains: chains.length },
    register: { path: register.path ?? null, assumptions: register.assumptions.length },

    // How much of the pilot this synthesis actually saw. Printed first in the report,
    // because every verdict below it is only as good as this line.
    coverage: {
      chains: chains.length,
      decidedChains: decidedChains.length,
      // Chains whose decision left a measured session behind. The rest were decided
      // somewhere the instrument was not, so they contribute nothing here.
      observedChains: observedChains.size,
      observations: observations.length,
      notes: observations.filter((o) => o.note).length,
      // One person, wearing all three hats. Stated as a number so the limit is in the
      // data and not only in the prose (docs/PILOT-OBSERVATION.md).
      participants: 1,
    },

    observation: observationSummary(observations),
    assumptions: scored,
    byVerdict: Object.fromEntries(VERDICTS.map((v) => [v, scored.filter((a) => a.verdict === v).length])),
  };
}
