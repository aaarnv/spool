// change.json holds the change record a spool can carry: the intent behind the work,
// the delivered result with honest statuses, the evidence behind each claim, and
// the source revision it was built from.
//
// A spool without change.json records, shares, publishes and plays exactly as
// before. A spool with one carries the SAME normalized document twice: as
// share/change.json in the bundle, and inline on spool.json as `spool.change`,
// so the watch page needs no second fetch.
//
// Dependency-free and pure apart from the file and git reads, like plan.mjs and
// proof.mjs: the CLI checks the record at `spool share`, and web/lib/change.ts
// checks the same rules again at publish.
//
// See CONTRACTS.md "Change record".

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { formatDiagnostics } from '../plan/schema.mjs';

const exec = promisify(execFile);

export const CHANGE_FILE = 'change.json';
export const CHANGE_VERSION = 1;

/** Where a request came from. `inferred` is the agent reconstructing it, never the user's words. */
export const REQUEST_SOURCES = ['user', 'issue', 'pr', 'inferred'];
/** When the request was saved, relative to the drive it explains. */
export const CAPTURED_WHEN = ['before', 'during', 'publish'];
/** Who says a statement. Every statement carries one, so nothing reads as the user's word by default. */
export const STATEMENT_SOURCES = ['user', 'agent', 'inferred'];
/** The proof vocabulary plus `unchecked`, which is an honest answer rather than a silence. */
export const OUTCOME_STATUSES = ['verified', 'partial', 'unmet', 'unchecked'];
/** `compare` is the one type that carries a pair of screenshots, the UI before and after. */
export const EVIDENCE_TYPES = ['ui', 'diff', 'test', 'diagram', 'compare'];

// Caps are privacy, not layout: a record must not become a place a transcript is
// pasted. The request gets more room because it is quoted verbatim.
export const MAX_REQUEST_TEXT = 1200;
export const MAX_TEXT = 600;
export const MAX_CONSTRAINTS = 12;
export const MAX_CLARIFICATIONS = 25;
export const MAX_OUTCOMES = 50;
export const MAX_DEVIATIONS = 25;
export const MAX_UNKNOWNS = 25;
export const MAX_EVIDENCE = 50;
export const MAX_COMPARE = 20;
export const MAX_ID = 40;
// A screenshot pair is published as-is, so the cap is the one a reviewer waits on.
export const MAX_SHOT_BYTES = 2 * 1024 * 1024;
// A backstop, not a budget: every field is capped on its own, so an honest record is
// orders of magnitude under this. It exists so nothing pathological reaches a publish.
export const MAX_DOC_BYTES = 256 * 1024;

const SPOOL_ID_RE = /^[A-Za-z0-9_-]{16,}$/;
const COMMIT_RE = /^[0-9a-f]{7,40}$/;
/** The directory a screenshot pair lives in, in the workdir and in the bundle alike. */
export const SHOTS_DIR = 'shots';
export const SHOT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
export const SHOT_STATES = ['before', 'after'];
// A path, never a url: the CLI never writes a url here and the server never trusts one.
export const SHOT_PATH_RE = /^shots\/[a-z0-9][a-z0-9._-]{0,60}\.png$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const text = (v) => (typeof v === 'string' ? v.trim() : '');
const list = (v) => (Array.isArray(v) ? v : []);

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a change record, optionally against the step names it may anchor to.
 * Returns { ok, errors, warnings } in the packet validator's shape, so
 * `formatDiagnostics` prints it and every path names the field to fix.
 *
 * @param {unknown} doc the parsed change.json
 * @param {{stepNames?: string[]|null}} opts the recorded step names, when known
 */
export function validateChange(doc, { stepNames = null } = {}) {
  const errors = [];
  const warnings = [];
  const error = (path, code, message) => errors.push({ path, code, message });
  const steps = Array.isArray(stepNames) ? new Set(stepNames) : null;

  if (!isObject(doc)) {
    error('(root)', 'invalid-type', `${CHANGE_FILE} must be a JSON object`);
    return { ok: false, errors, warnings };
  }
  if (doc.version !== CHANGE_VERSION) {
    error('version', 'invalid-version', `version must be ${CHANGE_VERSION} (got ${JSON.stringify(doc.version)})`);
  }
  if (doc.kind !== 'change') {
    error('kind', 'invalid-kind', `kind must be "change" (got ${JSON.stringify(doc.kind)})`);
  }
  try {
    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (bytes > MAX_DOC_BYTES) {
      error('(root)', 'too-large', `the record is ${bytes} bytes; the cap is ${MAX_DOC_BYTES}`);
    }
  } catch { /* a document that will not serialize fails its own field checks below */ }

  // A text field the record quotes: present, a string, and inside its cap.
  const checkText = (value, path, { required = true, max = MAX_TEXT } = {}) => {
    // An optional field left empty means "not stated", the same as null, and both
    // normalize to null. A required one still refuses an empty string.
    if (value === undefined || value === null || (!required && value === '')) {
      if (required) error(path, 'required', `${path} is required and must be a non-empty string`);
      return;
    }
    if (!isText(value)) return error(path, 'invalid-type', `${path} must be a non-empty string`);
    if (value.length > max) {
      error(path, 'too-long', `${path} is ${value.length} chars; the cap is ${max}. Reference the detail, do not paste it`);
    }
  };
  const checkRef = (value, path) => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string') return error(path, 'invalid-type', `${path} must be a string url or "path#Lx-Ly", or null`);
    if (value.length > MAX_TEXT) error(path, 'too-long', `${path} is ${value.length} chars; the cap is ${MAX_TEXT}`);
  };
  const checkStep = (value, path) => {
    if (value === undefined || value === null) return;
    if (!isText(value)) return error(path, 'invalid-type', `${path} must name a recorded step`);
    if (steps && !steps.has(value.trim())) {
      error(path, 'unknown-step', `${path} names no step in this spool ("${value.trim()}"). Anchor to one of: ${[...steps].join(', ') || '(none)'}`);
    }
  };
  // Returns the trimmed id, or '' when there is none: an id names an anchor other
  // fields point at, so it has to survive being read back.
  const checkId = (value, path) => {
    const id = text(value);
    if (!id) {
      error(path, 'required', `${path} is required and must be a non-empty id`);
      return '';
    }
    if (id.length > MAX_ID) error(path, 'too-long', `${path} is ${id.length} chars; the cap is ${MAX_ID}`);
    return id;
  };
  const checkAt = (value, path) => {
    if (value === undefined || value === null) return;
    if (typeof value !== 'string' || !ISO_RE.test(value)) {
      error(path, 'invalid-date', `${path} must be an ISO 8601 timestamp, for example 2026-09-07T03:10:00Z`);
    }
  };

  // ---- intent --------------------------------------------------------------
  if (doc.intent !== undefined && doc.intent !== null) {
    if (!isObject(doc.intent)) {
      error('intent', 'invalid-type', 'intent must be an object');
    } else {
      const request = doc.intent.request;
      if (request !== undefined && request !== null) {
        if (!isObject(request)) {
          error('intent.request', 'invalid-type', 'intent.request must be an object, or null when no request was recorded');
        } else {
          checkText(request.text, 'intent.request.text', { max: MAX_REQUEST_TEXT });
          if (!REQUEST_SOURCES.includes(request.source)) {
            error('intent.request.source', 'invalid-source', `intent.request.source must be one of ${REQUEST_SOURCES.join(', ')}`);
          }
          checkRef(request.ref, 'intent.request.ref');
          checkAt(request.capturedAt, 'intent.request.capturedAt');
          if (request.capturedWhen !== undefined && request.capturedWhen !== null && !CAPTURED_WHEN.includes(request.capturedWhen)) {
            error('intent.request.capturedWhen', 'invalid-when', `intent.request.capturedWhen must be one of ${CAPTURED_WHEN.join(', ')}`);
          }
        }
      }

      const interpretation = doc.intent.interpretation;
      if (interpretation !== undefined && interpretation !== null) {
        if (!isObject(interpretation)) {
          error('intent.interpretation', 'invalid-type', 'intent.interpretation must be an object');
        } else {
          checkText(interpretation.outcome, 'intent.interpretation.outcome');
          // The agent is the only author of an interpretation: it is what the agent
          // set out to deliver, never something the user said.
          if (interpretation.source !== undefined && interpretation.source !== null && interpretation.source !== 'agent') {
            error('intent.interpretation.source', 'invalid-source', 'intent.interpretation.source is always "agent"');
          }
          const constraints = interpretation.constraints;
          if (constraints !== undefined && constraints !== null && !Array.isArray(constraints)) {
            error('intent.interpretation.constraints', 'invalid-type', 'intent.interpretation.constraints must be an array of strings');
          } else if (list(constraints).length > MAX_CONSTRAINTS) {
            error('intent.interpretation.constraints', 'too-many', `at most ${MAX_CONSTRAINTS} constraints (got ${list(constraints).length})`);
          } else {
            list(constraints).forEach((c, i) => checkText(c, `intent.interpretation.constraints[${i}]`));
          }
        }
      }

      const clarifications = doc.intent.clarifications;
      if (clarifications !== undefined && clarifications !== null && !Array.isArray(clarifications)) {
        error('intent.clarifications', 'invalid-type', 'intent.clarifications must be an array');
      } else {
        const items = list(clarifications);
        if (items.length > MAX_CLARIFICATIONS) {
          error('intent.clarifications', 'too-many', `at most ${MAX_CLARIFICATIONS} clarifications (got ${items.length})`);
        }
        const seen = new Set();
        items.forEach((c, i) => {
          const at = `intent.clarifications[${i}]`;
          if (!isObject(c)) return error(at, 'invalid-type', `${at} must be an object`);
          const id = checkId(c.id, `${at}.id`);
          if (id && seen.has(id)) error(`${at}.id`, 'duplicate', `clarification id "${id}" is used twice`);
          checkText(c.text, `${at}.text`);
          if (!STATEMENT_SOURCES.includes(c.source)) {
            error(`${at}.source`, 'invalid-source', `${at}.source must be one of ${STATEMENT_SOURCES.join(', ')}`);
          }
          checkAt(c.at, `${at}.at`);
          // Only backwards: a clarification superseding a later one would make the
          // thread unorderable, and nothing here ever rewrites earlier text.
          if (c.supersedes !== undefined && c.supersedes !== null) {
            const target = text(c.supersedes);
            if (!seen.has(target)) {
              error(`${at}.supersedes`, 'unknown-clarification', `${at}.supersedes must name an EARLIER clarification id (got ${JSON.stringify(c.supersedes)})`);
            }
          }
          if (id) seen.add(id);
        });
      }
    }
  }

  // ---- evidence ------------------------------------------------------------
  const evidenceIds = new Set();
  if (doc.evidence !== undefined && doc.evidence !== null && !Array.isArray(doc.evidence)) {
    error('evidence', 'invalid-type', 'evidence must be an array');
  } else {
    const items = list(doc.evidence);
    if (items.length > MAX_EVIDENCE) error('evidence', 'too-many', `at most ${MAX_EVIDENCE} evidence items (got ${items.length})`);
    let compares = 0;
    items.forEach((e, i) => {
      const at = `evidence[${i}]`;
      if (!isObject(e)) return error(at, 'invalid-type', `${at} must be an object`);
      const id = checkId(e.id, `${at}.id`);
      if (id && evidenceIds.has(id)) error(`${at}.id`, 'duplicate', `evidence id "${id}" is used twice`);
      else if (id) evidenceIds.add(id);
      if (!EVIDENCE_TYPES.includes(e.type)) {
        error(`${at}.type`, 'invalid-type-value', `${at}.type must be one of ${EVIDENCE_TYPES.join(', ')}`);
      }
      checkText(e.label, `${at}.label`);
      checkStep(e.step, `${at}.step`);
      checkRef(e.ref, `${at}.ref`);
      checkText(e.detail, `${at}.detail`, { required: false });
      // A test nobody can scope is a claim, not evidence: "next build" says nothing
      // about what it covered.
      if (e.type === 'test' && !isText(e.detail)) {
        error(`${at}.detail`, 'required', `evidence "${id || i}" is a test, so it must say what ran and its scope, for example "tsc --noEmit and next build, web/ only"`);
      }
      // Both halves, or it is not a comparison. The paths are checked as strings here;
      // `spool share` is where the files themselves are checked.
      if (e.type === 'compare') {
        compares++;
        for (const half of SHOT_STATES) {
          const value = e[half];
          const where = `${at}.${half}`;
          const message = `evidence "${id || i}".${half} must be a png under ${SHOTS_DIR}/`;
          if (value === undefined || value === null || value === '') error(where, 'required', message);
          else if (typeof value !== 'string' || !SHOT_PATH_RE.test(value)) error(where, 'invalid-path', message);
        }
      }
    });
    if (compares > MAX_COMPARE) error('evidence', 'too-many-compare', `at most ${MAX_COMPARE} compare items (got ${compares})`);
  }

  // ---- result --------------------------------------------------------------
  const outcomeIds = new Set();
  if (doc.result !== undefined && doc.result !== null) {
    if (!isObject(doc.result)) {
      error('result', 'invalid-type', 'result must be an object');
    } else {
      checkText(doc.result.summary, 'result.summary', { required: false });

      if (doc.result.outcomes !== undefined && doc.result.outcomes !== null && !Array.isArray(doc.result.outcomes)) {
        error('result.outcomes', 'invalid-type', 'result.outcomes must be an array');
      } else {
        const items = list(doc.result.outcomes);
        if (items.length > MAX_OUTCOMES) error('result.outcomes', 'too-many', `at most ${MAX_OUTCOMES} outcomes (got ${items.length})`);
        items.forEach((o, i) => {
          const at = `result.outcomes[${i}]`;
          if (!isObject(o)) return error(at, 'invalid-type', `${at} must be an object`);
          const id = checkId(o.id, `${at}.id`);
          if (id && outcomeIds.has(id)) error(`${at}.id`, 'duplicate', `outcome id "${id}" is used twice`);
          else if (id) outcomeIds.add(id);
          checkText(o.claim, `${at}.claim`);
          if (!OUTCOME_STATUSES.includes(o.status)) {
            error(`${at}.status`, 'invalid-status', `${at}.status must be one of ${OUTCOME_STATUSES.join(', ')}`);
          }
          if (!STATEMENT_SOURCES.includes(o.source)) {
            error(`${at}.source`, 'invalid-source', `${at}.source must be one of ${STATEMENT_SOURCES.join(', ')}`);
          }
          checkStep(o.step, `${at}.step`);

          const cited = o.evidence;
          if (cited !== undefined && cited !== null && !Array.isArray(cited)) {
            error(`${at}.evidence`, 'invalid-type', `${at}.evidence must be an array of evidence ids`);
          } else {
            list(cited).forEach((ref, j) => {
              const key = text(ref);
              if (!key) return error(`${at}.evidence[${j}]`, 'invalid-type', `${at}.evidence[${j}] must be an evidence id string`);
              if (!evidenceIds.has(key)) error(`${at}.evidence[${j}]`, 'unknown-evidence', `${at}.evidence[${j}] names no evidence item ("${key}")`);
            });
          }
          // The rule the whole block exists for: "verified" is the one status that
          // claims somebody checked, so it must point at what they checked.
          if (o.status === 'verified' && !list(cited).filter((r) => isText(r)).length) {
            error(`${at}.evidence`, 'unevidenced-claim', `outcome "${id || i}" is "verified", so it must cite at least one evidence id, or say "unchecked"`);
          }
        });
      }

      if (doc.result.deviations !== undefined && doc.result.deviations !== null && !Array.isArray(doc.result.deviations)) {
        error('result.deviations', 'invalid-type', 'result.deviations must be an array');
      } else {
        const items = list(doc.result.deviations);
        if (items.length > MAX_DEVIATIONS) error('result.deviations', 'too-many', `at most ${MAX_DEVIATIONS} deviations (got ${items.length})`);
        items.forEach((d, i) => {
          const at = `result.deviations[${i}]`;
          if (!isObject(d)) return error(at, 'invalid-type', `${at} must be an object`);
          checkText(d.note, `${at}.note`);
          if (d.outcome !== undefined && d.outcome !== null) {
            const key = text(d.outcome);
            if (!outcomeIds.has(key)) error(`${at}.outcome`, 'unknown-outcome', `${at}.outcome names no outcome ("${key}")`);
          }
        });
      }

      if (doc.result.unknowns !== undefined && doc.result.unknowns !== null && !Array.isArray(doc.result.unknowns)) {
        error('result.unknowns', 'invalid-type', 'result.unknowns must be an array of strings');
      } else {
        const items = list(doc.result.unknowns);
        if (items.length > MAX_UNKNOWNS) error('result.unknowns', 'too-many', `at most ${MAX_UNKNOWNS} unknowns (got ${items.length})`);
        items.forEach((u, i) => checkText(u, `result.unknowns[${i}]`));
      }
    }
  }

  // ---- source + lineage ----------------------------------------------------
  if (doc.source !== undefined && doc.source !== null) {
    if (!isObject(doc.source)) {
      error('source', 'invalid-type', 'source must be an object');
    } else {
      if (doc.source.repo !== undefined && doc.source.repo !== null && !isText(doc.source.repo)) {
        error('source.repo', 'invalid-type', 'source.repo must be "owner/name" or null');
      }
      if (doc.source.commit !== undefined && doc.source.commit !== null && !COMMIT_RE.test(text(doc.source.commit))) {
        error('source.commit', 'invalid-commit', 'source.commit must be a 7 to 40 character hex sha, or null');
      }
      if (doc.source.dirty !== undefined && doc.source.dirty !== null && typeof doc.source.dirty !== 'boolean') {
        error('source.dirty', 'invalid-type', 'source.dirty must be a boolean');
      }
      checkRef(doc.source.fingerprint, 'source.fingerprint');
      // The fingerprint hashes the uncommitted diff, so a clean tree cannot have one.
      // It is not required when dirty: git is not always there to produce it.
      if (isText(doc.source.fingerprint) && doc.source.dirty !== true) {
        error('source.fingerprint', 'contradictory', 'source.fingerprint hashes the uncommitted diff, so it must be null when source.dirty is false');
      }
    }
  }
  if (doc.supersedesSpoolId !== undefined && doc.supersedesSpoolId !== null && !SPOOL_ID_RE.test(text(doc.supersedesSpoolId))) {
    error('supersedesSpoolId', 'invalid-spool-id', 'supersedesSpoolId must be a published spool id, or null');
  }

  return { ok: errors.length === 0, errors, warnings };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** True when the workdir carries a change record. Spools without one are untouched. */
export function hasChange(workdir) {
  return existsSync(join(resolve(workdir), CHANGE_FILE));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// The recorded step names a record may anchor to, or null when the workdir has
// not been recorded yet: unknown must never be reported as "no such step".
async function timelineStepNames(dir) {
  const path = join(dir, 'timeline.json');
  if (!existsSync(path)) return null;
  try {
    const timeline = await readJson(path);
    return list(timeline.steps).map((s) => s?.name).filter((n) => typeof n === 'string');
  } catch {
    return null;
  }
}

/**
 * Read and validate the change record in a workdir.
 * Returns { present, ok, change, stepNames, errors, warnings }. A workdir with no
 * change.json returns { present: false, ok: true }, so every caller can gate on it
 * unconditionally.
 */
export async function readChange(workdir) {
  const dir = resolve(workdir);
  const path = join(dir, CHANGE_FILE);
  if (!existsSync(path)) return { present: false, ok: true, change: null, stepNames: null, errors: [], warnings: [] };

  let change;
  try {
    change = await readJson(path);
  } catch (e) {
    return {
      present: true,
      ok: false,
      change: null,
      stepNames: null,
      errors: [{ path: CHANGE_FILE, code: 'invalid-json', message: `${CHANGE_FILE} is not valid JSON: ${e.message}` }],
      warnings: [],
    };
  }

  const stepNames = await timelineStepNames(dir);
  const res = validateChange(change, { stepNames });
  return { present: true, ok: res.ok, change, stepNames, errors: res.errors, warnings: res.warnings };
}

// ---------------------------------------------------------------------------
// The published copy
// ---------------------------------------------------------------------------

const capped = (v, max) => {
  const s = text(v);
  return s ? s.slice(0, max) : null;
};

/**
 * Build the published copy: the authored record, normalized and stripped of every
 * key nobody declared, plus `start`/`end` on the OUTPUT clock for each outcome and
 * evidence item that names a step. Pure, so bundles diff cleanly.
 *
 * @param {object} doc the validated change.json
 * @param {{name: string, start: number, end: number}[]} steps the share/spool.json steps
 */
export function buildShareChange(doc, steps = []) {
  const window = new Map(list(steps).map((s) => [s.name, { start: s.start, end: s.end }]));
  // A step name that survived validation always resolves; the guard is for a record
  // published from a workdir whose cut was changed after the record was written.
  const anchor = (value) => {
    const name = text(value);
    const w = name ? window.get(name) : null;
    return { step: name || null, window: w ? { start: w.start, end: w.end } : null };
  };

  const intent = isObject(doc.intent) ? doc.intent : {};
  const request = isObject(intent.request) ? intent.request : null;
  const interpretation = isObject(intent.interpretation) ? intent.interpretation : null;
  const result = isObject(doc.result) ? doc.result : {};
  const source = isObject(doc.source) ? doc.source : {};

  return {
    version: CHANGE_VERSION,
    kind: 'change',
    intent: {
      request: request
        ? {
            text: capped(request.text, MAX_REQUEST_TEXT),
            source: request.source,
            ref: capped(request.ref, MAX_TEXT),
            capturedAt: text(request.capturedAt) || null,
            capturedWhen: CAPTURED_WHEN.includes(request.capturedWhen) ? request.capturedWhen : null,
          }
        : null,
      interpretation: interpretation
        ? {
            outcome: capped(interpretation.outcome, MAX_TEXT),
            constraints: list(interpretation.constraints).filter(isText).map((c) => capped(c, MAX_TEXT)),
            source: 'agent',
          }
        : null,
      clarifications: list(intent.clarifications)
        .filter(isObject)
        .map((c) => ({
          id: text(c.id),
          text: capped(c.text, MAX_TEXT),
          source: c.source,
          at: text(c.at) || null,
          supersedes: text(c.supersedes) || null,
        })),
    },
    result: {
      summary: capped(result.summary, MAX_TEXT),
      outcomes: list(result.outcomes)
        .filter(isObject)
        .map((o) => {
          const at = anchor(o.step);
          return {
            id: text(o.id),
            claim: capped(o.claim, MAX_TEXT),
            status: o.status,
            source: o.source,
            // Deduped: citing one id twice says nothing, and the server's stored copy
            // dedupes, so the two normalized copies have to agree here.
            evidence: [...new Set(list(o.evidence).filter(isText).map((e) => text(e)))],
            step: at.step,
            ...(at.window ?? {}),
          };
        }),
      deviations: list(result.deviations)
        .filter(isObject)
        .map((d) => ({ outcome: text(d.outcome) || null, note: capped(d.note, MAX_TEXT) })),
      unknowns: list(result.unknowns).filter(isText).map((u) => capped(u, MAX_TEXT)),
    },
    evidence: list(doc.evidence)
      .filter(isObject)
      .map((e) => {
        const at = anchor(e.step);
        // Key order follows the authored schema, with start and end appended, because
        // this document and the server's rewritten copy are meant to be the same bytes.
        return {
          id: text(e.id),
          type: e.type,
          label: capped(e.label, MAX_TEXT),
          step: at.step,
          ref: capped(e.ref, MAX_TEXT),
          detail: capped(e.detail, MAX_TEXT),
          // Null on every other type, so a renderer never branches on absence.
          before: e.type === 'compare' ? text(e.before) || null : null,
          after: e.type === 'compare' ? text(e.after) || null : null,
          ...(at.window ?? {}),
        };
      }),
    source: {
      repo: text(source.repo) || null,
      commit: text(source.commit) || null,
      dirty: source.dirty === true,
      fingerprint: text(source.fingerprint) || null,
    },
    supersedesSpoolId: text(doc.supersedesSpoolId) || null,
  };
}

/**
 * Copy every screenshot a compare item names into share/shots/, keeping the basename
 * so the path in the published copy does not move. Checks every file first: a record
 * that names a screenshot nobody can load is refused before a byte is copied.
 */
async function copyShots(workdir, shareDir, doc) {
  const dir = resolve(workdir);
  const wanted = new Map();
  for (const e of list(doc.evidence)) {
    if (!isObject(e) || e.type !== 'compare') continue;
    for (const half of SHOT_STATES) {
      const rel = text(e[half]);
      if (rel && !wanted.has(rel)) wanted.set(rel, text(e.id));
    }
  }
  if (!wanted.size) return [];
  for (const [rel, id] of wanted) {
    const from = join(dir, rel);
    let bytes;
    try {
      bytes = (await stat(from)).size;
    } catch {
      throw new Error(`share: evidence "${id}" names ${rel}, which is not in ${dir}, so the published copy would lie`);
    }
    if (bytes > MAX_SHOT_BYTES) {
      throw new Error(`share: evidence "${id}" names ${rel}, which is ${bytes} bytes against a cap of ${MAX_SHOT_BYTES}, so the published copy would lie`);
    }
  }
  await mkdir(join(shareDir, SHOTS_DIR), { recursive: true });
  for (const rel of wanted.keys()) await copyFile(join(dir, rel), join(shareDir, rel));
  return [...wanted.keys()];
}

/**
 * Write share/change.json for a validated record. Returns the document the share
 * bundle stamps onto `spool.change`, or null when the workdir carries no record.
 * Throws on an invalid record: a published copy that does not validate would lie.
 *
 * `fallbackRequest` is used only when the record states no request of its own; the
 * caller decides where one may come from (see share.mjs, the PR body).
 */
export async function writeShareChange(workdir, shareDir, steps = [], { fallbackRequest = null } = {}) {
  const record = await readChange(workdir);
  if (!record.present) return null;
  if (!record.ok) {
    throw new Error(`share: ${join(workdir, CHANGE_FILE)} is invalid, so the published copy would lie:\n${formatDiagnostics(record)}`);
  }
  const doc = record.change;
  if (fallbackRequest && !isObject(doc.intent?.request)) {
    doc.intent = { ...(isObject(doc.intent) ? doc.intent : {}), request: fallbackRequest };
  }
  const shareChange = buildShareChange(doc, steps);
  await copyShots(workdir, shareDir, shareChange);
  await writeFile(join(shareDir, CHANGE_FILE), JSON.stringify(shareChange, null, 2) + '\n');
  return shareChange;
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

/**
 * An empty record with the source revision filled in. Every statement field starts
 * null: a scaffold that already claims something is a claim nobody made.
 */
export function changeTemplate({ source = null } = {}) {
  return {
    version: CHANGE_VERSION,
    kind: 'change',
    intent: { request: null, interpretation: null, clarifications: [] },
    result: { summary: null, outcomes: [], deviations: [], unknowns: [] },
    evidence: [],
    source: source ?? { repo: null, commit: null, dirty: false, fingerprint: null },
    supersedesSpoolId: null,
  };
}

async function git(cwd, args, opts = {}) {
  try {
    const { stdout } = await exec('git', args, { cwd, ...opts });
    return stdout;
  } catch {
    return null;
  }
}

// "owner/name" from any remote URL form. Anything else stays null: a wrong repo
// name points the reader at the wrong tree.
function repoSlug(url) {
  const m = String(url || '').match(/(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The revision the work was built from: repo, short commit, whether the tree was
 * dirty, and a fingerprint of the uncommitted diff. Outside a checkout every value
 * is null, which is still a valid record. It just cannot be pinned.
 */
export async function gitSource(cwd = process.cwd()) {
  const empty = { repo: null, commit: null, dirty: false, fingerprint: null };
  if (!(await git(cwd, ['rev-parse', '--is-inside-work-tree']))) return empty;
  const [remote, commit, status] = await Promise.all([
    git(cwd, ['remote', 'get-url', 'origin']),
    git(cwd, ['rev-parse', '--short=10', 'HEAD']),
    // Untracked files are not uncommitted work on the recorded tree, and they never
    // reach the diff below, so they must not make a clean tree read as dirty.
    git(cwd, ['status', '--porcelain', '--untracked-files=no']),
  ]);
  const dirty = !!status && status.trim().length > 0;
  let fingerprint = null;
  if (dirty) {
    // 64MB: a working diff can be large, and a failed read must degrade to null
    // rather than throw away the rest of the source block.
    const diff = await git(cwd, ['diff', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 });
    if (diff !== null && diff.length) fingerprint = createHash('sha256').update(diff).digest('hex');
  }
  return { repo: repoSlug(remote && remote.trim()), commit: commit ? commit.trim() : null, dirty, fingerprint };
}

/**
 * Write change.json into a workdir. Refuses to overwrite: a record is appended to
 * across a session, and a second scaffold would erase what was already saved.
 */
export async function initChange(workdir, { cwd = process.cwd() } = {}) {
  const dir = resolve(workdir);
  const path = join(dir, CHANGE_FILE);
  if (existsSync(path)) {
    throw new Error(`${path} already exists. Edit it, or send POST /intent to add to it`);
  }
  const source = await gitSource(cwd);
  const doc = changeTemplate({ source });
  await writeFile(path, JSON.stringify(doc, null, 2) + '\n');
  return { path, change: doc, source };
}

/** Where one half of a screenshot pair lives, relative to the workdir and the bundle. */
export function shotPath(name, state) {
  return `${SHOTS_DIR}/${name}-${state}.png`;
}

/**
 * Upsert the `compare` evidence item for a screenshot pair, and only once BOTH halves
 * are on disk: one half is a screenshot, not a comparison. Creates change.json from the
 * template when there is none, touches no other field, and refuses a record that would
 * not validate. Returns { id, file, evidence, pending }.
 *
 * @param {string} workdir the session directory holding shots/
 * @param {{name: string, label?: string|null, step?: string|null, cwd?: string|null}} opts
 */
export async function upsertShot(workdir, { name, label = null, step = null, cwd = null } = {}) {
  const dir = resolve(workdir);
  const shot = text(name);
  if (!SHOT_NAME_RE.test(shot)) {
    throw new Error(`shot name must be lower-case letters, digits and dashes, up to 41 characters (got ${JSON.stringify(name)})`);
  }
  const id = `shot-${shot}`;
  const halves = Object.fromEntries(SHOT_STATES.map((s) => [s, shotPath(shot, s)]));
  const missing = SHOT_STATES.filter((s) => !existsSync(join(dir, halves[s])));
  if (missing.length) return { id, file: null, evidence: null, pending: missing[0] };

  const file = join(dir, CHANGE_FILE);
  let doc;
  if (existsSync(file)) {
    doc = JSON.parse(await readFile(file, 'utf8'));
  } else {
    doc = changeTemplate({ source: await gitSource(cwd ?? dir) });
  }
  if (!Array.isArray(doc.evidence)) doc.evidence = [];
  const index = doc.evidence.findIndex((e) => isObject(e) && text(e.id) === id);
  const prev = index >= 0 ? doc.evidence[index] : null;
  // A second take of the same pair refreshes the paths and keeps whatever a person
  // wrote on the item: a re-shoot must not silently drop an edited label or detail.
  const item = {
    ...(prev ?? {}),
    id,
    type: 'compare',
    label: text(label) || text(prev?.label) || shot.replace(/-/g, ' '),
    before: halves.before,
    after: halves.after,
    step: text(step) || text(prev?.step) || null,
    ref: prev?.ref ?? null,
    detail: prev?.detail ?? null,
  };
  if (index >= 0) doc.evidence[index] = item;
  else doc.evidence.push(item);

  const res = validateChange(doc);
  if (!res.ok) throw new Error(res.errors.map((e) => `${e.path}: ${e.message}`).join('; '));
  await writeFile(file, JSON.stringify(doc, null, 2) + '\n');
  return { id, file, evidence: id, pending: null };
}

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

// mm:ss on the output clock, zero-padded so a column of them lines up.
function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/** Short human digest of a published change record, for `spool read`. */
export function changeDigest(change) {
  const lines = ['change:'];
  const request = change.intent?.request ?? null;
  if (!request) {
    lines.push('  request: not recorded');
  } else if (request.source === 'inferred') {
    // Never rendered as the original ask: an inference is the agent's reconstruction.
    lines.push(`  request (inferred by the agent): "${request.text}"${request.ref ? `  [${request.ref}]` : ''}`);
  } else {
    const when = request.capturedWhen ? `, ${request.capturedWhen}` : '';
    lines.push(`  request (${request.source}${when}): "${request.text}"${request.ref ? `  [${request.ref}]` : ''}`);
  }

  const interpretation = change.intent?.interpretation ?? null;
  if (interpretation) {
    lines.push(`  interpretation: ${interpretation.outcome}`);
    if (interpretation.constraints?.length) lines.push(`    constraints: ${interpretation.constraints.join('; ')}`);
  }
  const clarifications = change.intent?.clarifications ?? [];
  if (clarifications.length) {
    lines.push('  clarifications:');
    for (const c of clarifications) {
      lines.push(`    - ${c.id} (${c.source}): ${c.text}${c.supersedes ? ` [supersedes ${c.supersedes}]` : ''}`);
    }
  }

  if (change.result?.summary) lines.push(`  result: ${change.result.summary}`);
  const outcomes = change.result?.outcomes ?? [];
  if (outcomes.length) {
    lines.push('  outcomes:');
    for (const o of outcomes) {
      const at = typeof o.start === 'number' ? ` [${clock(o.start)}–${clock(o.end)}]` : '';
      const cited = o.evidence?.length ? `  evidence: ${o.evidence.join(', ')}` : '';
      lines.push(`    - ${o.id} ${o.status} (${o.source})${at}: ${o.claim}${cited}`);
    }
  }
  const evidence = change.evidence ?? [];
  if (evidence.length) {
    lines.push('  evidence:');
    for (const e of evidence) {
      const at = e.step ? `  step: ${e.step}` : '';
      const pair = e.type === 'compare' ? `  before: ${e.before}  after: ${e.after}` : '';
      lines.push(`    - ${e.id} ${e.type}  "${e.label}"${pair}${at}`);
    }
  }
  const deviations = change.result?.deviations ?? [];
  if (deviations.length) {
    lines.push('  deviations:');
    for (const d of deviations) lines.push(`    - ${d.outcome ? `${d.outcome}: ` : ''}${d.note}`);
  }
  const unknowns = change.result?.unknowns ?? [];
  if (unknowns.length) {
    lines.push('  unknowns:');
    for (const u of unknowns) lines.push(`    - ${u}`);
  }

  const source = change.source ?? {};
  if (source.repo || source.commit) {
    const at = `${source.repo ?? '(unknown repo)'}${source.commit ? `@${source.commit}` : ''}`;
    lines.push(`  source: ${at} (${source.dirty ? 'plus uncommitted changes' : 'clean'})`);
  }
  if (change.supersedesSpoolId) lines.push(`  re-records: ${change.supersedesSpoolId}`);
  return lines.join('\n');
}
