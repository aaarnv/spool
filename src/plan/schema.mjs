// plan.json / evidence.json — the Plan Spool packet contract.
//
// This module is the single source of truth for the shape documented in
// CONTRACTS.md "Plan Spools". It is dependency-free on purpose: the CLI runs
// wherever an agent runs, and every consumer (CLI gate, share bundle, tests,
// later the web app) must read the same rules without installing a validator.
//
// Every check reports { path, code, message }, where `path` names the offending
// field so an agent can fix the packet without guessing.

import {
  EVIDENCE_KINDS,
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_TOTAL_CHARS,
  EVIDENCE_VISIBILITIES,
  EXCERPT_MAX_CHARS,
  EXCERPT_MAX_LINES,
  SUMMARY_MAX_CHARS,
  checkRef,
} from './evidence.mjs';
import { checkLinkRef } from '../github/refs.mjs';

// The descriptor vocabulary lives in evidence.mjs (the leaf module that also
// owns ref rules, redaction and URL building) and is re-exported here so this
// file stays the one import a consumer needs.
export { EVIDENCE_KINDS, EVIDENCE_VISIBILITIES } from './evidence.mjs';

export const PLAN_VERSION = 1;

// Chapter IDs are stable semantic anchors. They never index into timeline.json;
// timeline.json stays the recording-clock source of truth and carries chapterId
// as an additive field.
export const CHAPTER_IDS = ['context', 'outcome', 'approach', 'risks', 'decision'];

export const DECISION_TYPES = ['approval', 'selection'];
// Reviewer actions a decision may offer. Lifecycle states live in the lifecycle
// spec; these are the requests a plan is allowed to make.
export const DECISION_ACTIONS = ['approve', 'redirect', 'ask-question', 'needs-input'];

// Kept as a string so the generated JSON Schema and this validator share one
// pattern; see src/plan/json-schema.mjs.
export const ID_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';

const ID_RE = new RegExp(ID_PATTERN);
const ALT_OPTION_RE = /^alternative:(.+)$/;

// Every placeholder string in templates/plan.json and templates/evidence.json
// starts with this marker, so a packet that is still the template says so about
// itself. Structure alone cannot catch it: "the exact action the reviewer must
// take" is a well-formed prompt and a worthless one.
export const PLACEHOLDER = 'TODO:';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

function bag() {
  const errors = [];
  const warnings = [];
  return {
    errors,
    warnings,
    error: (path, code, message) => errors.push({ path, code, message }),
    warn: (path, code, message) => warnings.push({ path, code, message }),
    result: () => ({ ok: errors.length === 0, errors, warnings }),
  };
}

// --- small field checks (each returns the value when usable, else undefined) ---

// `path` is what the reader sees ("decision.prompt"); the key read off `obj` is its
// last segment, so a nested object is checked against its own field name.
function textField(d, obj, path, { required = true, max = 0 } = {}) {
  const v = obj[path.split('.').pop()];
  if (v === undefined || v === null) {
    if (required) d.error(path, 'required', `${path} is required and must be a non-empty string`);
    return undefined;
  }
  if (!isText(v)) {
    d.error(path, 'invalid-type', `${path} must be a non-empty string (got ${describe(v)})`);
    return undefined;
  }
  if (max && v.length > max) d.warn(path, 'too-long', `${path} is ${v.length} chars; keep it under ${max} so it reads on a card`);
  return v;
}

function arrayField(d, value, path, { required = true, min = 0 } = {}) {
  if (value === undefined || value === null) {
    if (required) d.error(path, 'required', `${path} is required and must be an array`);
    return undefined;
  }
  if (!Array.isArray(value)) {
    d.error(path, 'invalid-type', `${path} must be an array (got ${describe(value)})`);
    return undefined;
  }
  if (value.length < min) d.error(path, 'too-few', `${path} needs at least ${min} item${min === 1 ? '' : 's'}`);
  return value;
}

function describe(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

function stringList(d, value, path) {
  const arr = arrayField(d, value, path, { required: false });
  if (!arr) return [];
  arr.forEach((item, i) => {
    if (!isText(item)) d.error(`${path}[${i}]`, 'invalid-type', `${path}[${i}] must be a non-empty string`);
  });
  return arr;
}

// Walk every string in a packet and report the ones still carrying the template
// marker. One rule covers every field, so a new template field needs no new check.
function unedited(d, value, path = '') {
  if (typeof value === 'string') {
    if (value.trimStart().startsWith(PLACEHOLDER)) {
      d.warn(path, 'unedited-template', `${path} is still the template placeholder; write the real text and drop the "${PLACEHOLDER}" marker`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => unedited(d, item, `${path}[${i}]`));
    return;
  }
  if (isObject(value)) {
    for (const [key, v] of Object.entries(value)) unedited(d, v, path ? `${path}.${key}` : key);
  }
}

function chapterRef(d, value, path, chapterIds) {
  if (value === undefined || value === null) return;
  if (!isText(value) || !chapterIds.includes(value)) {
    d.error(path, 'unknown-chapter', `${path} must be one of the plan's chapter IDs: ${chapterIds.join(', ')}`);
  }
}

// --- plan.json -------------------------------------------------------------

/**
 * Validate a parsed plan.json value.
 * Returns { ok, errors, warnings } with paths relative to the plan root.
 */
export function validatePlan(value) {
  const d = bag();
  if (!isObject(value)) {
    d.error('', 'invalid-type', `plan.json must be a JSON object (got ${describe(value)})`);
    return d.result();
  }

  // Version first: on an unknown major version every other check is guesswork,
  // so reject loudly and stop rather than emitting misleading field errors.
  const version = value.version;
  if (!Number.isInteger(version)) {
    d.error('version', 'required', `version is required and must be an integer (this CLI writes ${PLAN_VERSION})`);
    return d.result();
  }
  if (version < 1) {
    d.error('version', 'invalid-version', `version must be >= 1 (got ${version})`);
    return d.result();
  }
  if (version > PLAN_VERSION) {
    d.error(
      'version',
      'unsupported-version',
      `plan.json declares version ${version}; this spool CLI reads plan version ${PLAN_VERSION}. ` +
        `Upgrade the CLI (npm i -g @spoolkit/cli) or re-author the plan at version ${PLAN_VERSION}.`
    );
    return d.result();
  }

  if (value.kind !== 'plan') {
    d.error('kind', 'invalid-value', `kind must be "plan" (got ${JSON.stringify(value.kind ?? null)})`);
  }

  textField(d, value, 'goal', { max: 200 });
  textField(d, value, 'outcome', { max: 300 });

  const chapterIds = validateChapters(d, value);
  validateCurrentState(d, value, chapterIds);
  validateApproach(d, value, chapterIds);
  const alternativeIds = validateAlternatives(d, value);
  stringList(d, value.assumptions, 'assumptions');

  validateRisks(d, value, chapterIds);

  validateDecision(d, value, alternativeIds);
  validateLinks(d, value);

  // Unknown top-level keys are forward-compatible, not fatal: a newer authoring
  // tool may add fields this CLI has no opinion about.
  const known = new Set([
    'version', 'kind', 'goal', 'currentState', 'outcome', 'approach', 'alternatives',
    'noAlternativesReason', 'assumptions', 'risks', 'decision', 'links', 'chapters',
  ]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) d.warn(key, 'unknown-field', `${key} is not part of plan version ${PLAN_VERSION}; it is carried through but ignored`);
  }

  unedited(d, value);
  return d.result();
}

function validateChapters(d, value) {
  if (value.chapters === undefined || value.chapters === null) return CHAPTER_IDS;
  const arr = arrayField(d, value.chapters, 'chapters', { required: false, min: 1 });
  if (!arr) return CHAPTER_IDS;
  const ids = [];
  arr.forEach((ch, i) => {
    const path = `chapters[${i}]`;
    if (!isObject(ch)) {
      d.error(path, 'invalid-type', `${path} must be an object with an id`);
      return;
    }
    if (!isText(ch.id) || !CHAPTER_IDS.includes(ch.id)) {
      d.error(`${path}.id`, 'unknown-chapter', `${path}.id must be one of: ${CHAPTER_IDS.join(', ')}`);
      return;
    }
    if (ids.includes(ch.id)) {
      d.error(`${path}.id`, 'duplicate-id', `${path}.id "${ch.id}" is declared twice`);
      return;
    }
    if (ch.title !== undefined && !isText(ch.title)) {
      d.error(`${path}.title`, 'invalid-type', `${path}.title must be a non-empty string when present`);
    }
    ids.push(ch.id);
  });
  if (!ids.includes('decision')) {
    d.error('chapters', 'missing-decision-chapter', 'chapters must include the "decision" chapter: a plan always asks for one action');
  }
  if (ids.length > 6) d.warn('chapters', 'too-many', `${ids.length} chapters; the target shape is 3 to 6`);
  return ids.length ? ids : CHAPTER_IDS;
}

function validateCurrentState(d, value, chapterIds) {
  const arr = arrayField(d, value.currentState, 'currentState', { required: false });
  if (!arr) return;
  arr.forEach((item, i) => {
    const path = `currentState[${i}]`;
    if (!isObject(item)) {
      d.error(path, 'invalid-type', `${path} must be an object with a claim`);
      return;
    }
    if (!isText(item.claim)) d.error(`${path}.claim`, 'required', `${path}.claim must be a non-empty string`);
    stringList(d, item.evidence, `${path}.evidence`);
    chapterRef(d, item.chapterId, `${path}.chapterId`, chapterIds);
  });
}

function validateApproach(d, value, chapterIds) {
  const arr = arrayField(d, value.approach, 'approach', { required: true, min: 1 });
  const ids = [];
  if (!arr) return ids;
  arr.forEach((item, i) => {
    const path = `approach[${i}]`;
    if (!isObject(item)) {
      d.error(path, 'invalid-type', `${path} must be an object with an id and a summary`);
      return;
    }
    if (!isText(item.id) || !ID_RE.test(item.id)) {
      d.error(`${path}.id`, 'invalid-id', `${path}.id must be a kebab-case id (a-z, 0-9, dashes) so questions and proofs can anchor to it`);
    } else if (ids.includes(item.id)) {
      d.error(`${path}.id`, 'duplicate-id', `${path}.id "${item.id}" is used by an earlier approach step`);
    } else {
      ids.push(item.id);
    }
    if (!isText(item.summary)) d.error(`${path}.summary`, 'required', `${path}.summary must be a non-empty string`);
    stringList(d, item.evidence, `${path}.evidence`);
    chapterRef(d, item.chapterId, `${path}.chapterId`, chapterIds);
  });
  return ids;
}

// Alternatives are optional, but their absence must be stated: a plan that
// silently omits them reads as "there was no other way", which is a claim.
function validateAlternatives(d, value) {
  const ids = [];
  const arr = value.alternatives === undefined || value.alternatives === null
    ? []
    : arrayField(d, value.alternatives, 'alternatives', { required: false }) || [];
  arr.forEach((item, i) => {
    const path = `alternatives[${i}]`;
    if (!isObject(item)) {
      d.error(path, 'invalid-type', `${path} must be an object with an id and a summary`);
      return;
    }
    if (!isText(item.id) || !ID_RE.test(item.id)) {
      d.error(`${path}.id`, 'invalid-id', `${path}.id must be a kebab-case id (a-z, 0-9, dashes)`);
    } else if (ids.includes(item.id)) {
      d.error(`${path}.id`, 'duplicate-id', `${path}.id "${item.id}" is used by an earlier alternative`);
    } else {
      ids.push(item.id);
    }
    if (!isText(item.summary)) d.error(`${path}.summary`, 'required', `${path}.summary must be a non-empty string`);
    stringList(d, item.tradeoffs, `${path}.tradeoffs`);
    stringList(d, item.evidence, `${path}.evidence`);
  });

  if (arr.length === 0) {
    if (!isText(value.noAlternativesReason)) {
      d.error(
        'noAlternativesReason',
        'required',
        'a plan with no alternatives must say so: set noAlternativesReason (for example "no credible alternative considered: the schema is fixed by the existing contract")'
      );
    }
  } else if (value.noAlternativesReason !== undefined && value.noAlternativesReason !== null) {
    d.error('noAlternativesReason', 'conflict', 'noAlternativesReason is only for plans without alternatives; remove it or remove the alternatives');
  }
  return ids;
}

// A risk is a claim like any other, so it may cite evidence. It stays writable
// as a plain string: most risks have no source to point at, and every v1 packet
// wrote strings.
function validateRisks(d, value, chapterIds) {
  const risks = arrayField(d, value.risks, 'risks', { required: true });
  if (!risks) return;
  risks.forEach((r, i) => {
    const path = `risks[${i}]`;
    if (isText(r)) return;
    if (!isObject(r)) {
      d.error(path, 'invalid-type', `${path} must be a non-empty string, or an object with a claim`);
      return;
    }
    if (!isText(r.claim)) d.error(`${path}.claim`, 'required', `${path}.claim must be a non-empty string`);
    stringList(d, r.evidence, `${path}.evidence`);
    chapterRef(d, r.chapterId, `${path}.chapterId`, chapterIds);
  });
  if (risks.length === 0) {
    d.warn('risks', 'empty', 'risks is empty; state the uncertainty a reviewer should weigh, or say why there is none');
  }
}

function validateDecision(d, value, alternativeIds) {
  const dec = value.decision;
  if (!isObject(dec)) {
    d.error('decision', 'required', 'decision is required and must be an object with type, prompt and options');
    return;
  }
  if (!isText(dec.type) || !DECISION_TYPES.includes(dec.type)) {
    d.error('decision.type', 'invalid-value', `decision.type must be one of: ${DECISION_TYPES.join(', ')}`);
  }
  textField(d, dec, 'decision.prompt', { max: 200 });
  stringList(d, dec.evidence, 'decision.evidence');

  const options = arrayField(d, dec.options, 'decision.options', { required: true, min: 1 });
  if (!options) return;
  const seen = [];
  const chosenAlternatives = [];
  options.forEach((opt, i) => {
    const path = `decision.options[${i}]`;
    if (!isText(opt)) {
      d.error(path, 'invalid-type', `${path} must be a non-empty string`);
      return;
    }
    if (seen.includes(opt)) {
      d.error(path, 'duplicate-option', `${path} "${opt}" is listed twice`);
      return;
    }
    seen.push(opt);
    const alt = opt.match(ALT_OPTION_RE);
    if (alt) {
      if (!alternativeIds.includes(alt[1])) {
        d.error(path, 'unknown-alternative', `${path} points at alternative "${alt[1]}", which is not declared in alternatives`);
      } else {
        chosenAlternatives.push(alt[1]);
      }
      return;
    }
    if (!DECISION_ACTIONS.includes(opt)) {
      d.error(path, 'invalid-value', `${path} must be one of ${DECISION_ACTIONS.join(', ')} or "alternative:<id>"`);
    }
  });

  if (dec.type === 'approval' && seen.length && !seen.includes('approve')) {
    d.error('decision.options', 'missing-approve', 'an approval decision must offer "approve"');
  }
  if (dec.type === 'selection' && seen.length && chosenAlternatives.length === 0) {
    d.error('decision.options', 'missing-alternative', 'a selection decision must offer at least one "alternative:<id>" option');
  }
}

function validateLinks(d, value) {
  const links = value.links;
  if (!isObject(links)) {
    d.error('links', 'required', 'links is required and must be an object (use null for what does not apply, e.g. {"task": null, "branch": "spl/plan", "commit": null})');
    return;
  }
  for (const [key, v] of Object.entries(links)) {
    if (v === null) continue;
    if (!isText(v)) d.error(`links.${key}`, 'invalid-type', `links.${key} must be a non-empty string or null`);
  }

  // `pr` and `issue` are the two links a tool acts on: the PR comment posts to one and
  // the reviewer follows the other. A GitHub link of the wrong kind sends both to the
  // wrong place, so it is an error; anything spool does not recognise is a warning,
  // because a project may track work where spool has no integration.
  for (const [key, expected] of [['pr', 'pull'], ['issue', 'issue']]) {
    const v = links[key];
    if (!isText(v) || v.trimStart().startsWith(PLACEHOLDER)) continue;
    const problem = checkLinkRef(v, expected, { repo: links.repo });
    if (!problem) continue;
    const at = `links.${key}`;
    const say = `${at} ${problem.message}`;
    if (problem.level === 'error') d.error(at, problem.code, say);
    else d.warn(at, problem.code, say);
  }
}

// --- evidence.json ---------------------------------------------------------

/**
 * Validate a parsed evidence.json value (the descriptor bundle).
 * Descriptors reference evidence; they never copy its content.
 */
export function validateEvidence(value) {
  const d = bag();
  if (!isObject(value)) {
    d.error('', 'invalid-type', `evidence.json must be a JSON object (got ${describe(value)})`);
    return d.result();
  }
  const version = value.version;
  if (!Number.isInteger(version)) {
    d.error('version', 'required', `version is required and must be an integer (this CLI writes ${PLAN_VERSION})`);
    return d.result();
  }
  if (version < 1) {
    d.error('version', 'invalid-version', `version must be >= 1 (got ${version})`);
    return d.result();
  }
  if (version > PLAN_VERSION) {
    d.error(
      'version',
      'unsupported-version',
      `evidence.json declares version ${version}; this spool CLI reads evidence version ${PLAN_VERSION}. Upgrade the CLI or re-author the bundle.`
    );
    return d.result();
  }
  if (value.kind !== 'evidence') {
    d.error('kind', 'invalid-value', `kind must be "evidence" (got ${JSON.stringify(value.kind ?? null)})`);
  }

  const items = arrayField(d, value.items, 'items', { required: true });
  if (!items) return d.result();
  const ids = [];
  items.forEach((item, i) => {
    const path = `items[${i}]`;
    if (!isObject(item)) {
      d.error(path, 'invalid-type', `${path} must be an evidence descriptor object`);
      return;
    }
    if (!isText(item.id) || !ID_RE.test(item.id)) {
      d.error(`${path}.id`, 'invalid-id', `${path}.id must be a kebab-case id (a-z, 0-9, dashes), e.g. "ev-diff-1"`);
    } else if (ids.includes(item.id)) {
      d.error(`${path}.id`, 'duplicate-id', `${path}.id "${item.id}" is used by an earlier descriptor`);
    } else {
      ids.push(item.id);
    }
    if (!isText(item.kind) || !EVIDENCE_KINDS.includes(item.kind)) {
      d.error(`${path}.kind`, 'invalid-value', `${path}.kind must be one of: ${EVIDENCE_KINDS.join(', ')}`);
    }
    if (!isText(item.label)) d.error(`${path}.label`, 'required', `${path}.label must be a non-empty string a reviewer can read`);
    if (!isText(item.ref)) d.error(`${path}.ref`, 'required', `${path}.ref must be a non-empty string (path, URL, SHA or command)`);
    if (item.revision !== undefined && item.revision !== null && !isText(item.revision)) {
      d.error(`${path}.revision`, 'invalid-type', `${path}.revision must be a non-empty string or null`);
    }
    const chapters = arrayField(d, item.chapterIds, `${path}.chapterIds`, { required: false }) || [];
    chapters.forEach((c, j) => chapterRef(d, c, `${path}.chapterIds[${j}]`, CHAPTER_IDS));

    const isPrivate = item.visibility === 'private';
    if (item.visibility !== undefined && item.visibility !== null && !EVIDENCE_VISIBILITIES.includes(item.visibility)) {
      d.error(`${path}.visibility`, 'invalid-value', `${path}.visibility must be one of: ${EVIDENCE_VISIBILITIES.join(', ')}`);
    }

    // Ref rules are per kind, and they are the safety boundary: a ref becomes a
    // link on a page a stranger can open. A private-shaped ref is allowed only
    // when the descriptor declares itself private, in which case the share
    // bundle withholds it instead of publishing it.
    // A ref still carrying the template marker is reported once, as the
    // unedited-template warning below: a shape error on top of it would send
    // the author to fix the example instead of replacing it.
    const isTemplateRef = isText(item.ref) && item.ref.trimStart().startsWith(PLACEHOLDER);
    if (EVIDENCE_KINDS.includes(item.kind) && isText(item.ref) && !isTemplateRef) {
      const problem = checkRef(item.kind, item.ref);
      if (problem && !(isPrivate && problem.code === 'private-ref')) {
        d.error(`${path}.ref`, problem.code, `${path}.ref: ${problem.message}`);
      }
    }

    validateSummary(d, item, path, isPrivate);
    validateExcerpt(d, item, path, isPrivate);
  });
  evidenceBudget(d, items);
  unedited(d, value);
  return d.result();
}

// A summary is the plain-language line a card shows before the excerpt. It is
// what makes "code on demand" possible, so it is bounded like every other
// published string and withheld on a private descriptor like every other one.
function validateSummary(d, item, path, isPrivate) {
  if (item.summary === undefined || item.summary === null) return;
  if (!isText(item.summary)) {
    d.error(`${path}.summary`, 'invalid-type', `${path}.summary must be a non-empty string or null`);
    return;
  }
  if (isPrivate) {
    d.error(`${path}.summary`, 'private-summary', `${path}.summary cannot be published for a private descriptor; put the plain-language line in ${path}.label instead`);
  }
  if (item.summary.length > SUMMARY_MAX_CHARS) {
    d.warn(
      `${path}.summary`,
      'too-long',
      `${path}.summary is ${item.summary.length} chars; it is published truncated to ${SUMMARY_MAX_CHARS}. Say what the source showed in one sentence and leave the detail to the excerpt.`
    );
  }
}

// Caps for the bundle, not just one descriptor. Evidence is referenced, never
// copied: a plan carrying dozens of excerpts has become a slow copy of the
// repository, and a reviewer reads none of it.
function evidenceBudget(d, items) {
  if (items.length > EVIDENCE_MAX_ITEMS) {
    d.warn(
      'items',
      'too-many-evidence',
      `evidence.json declares ${items.length} descriptors; the published cap is ${EVIDENCE_MAX_ITEMS}. Keep the ones a claim cites.`
    );
  }
  const total = items.reduce((sum, item) => {
    if (!isObject(item)) return sum;
    const text = (isText(item.summary) ? item.summary.length : 0) + (isText(item.excerpt) ? item.excerpt.length : 0);
    return sum + text;
  }, 0);
  if (total > EVIDENCE_MAX_TOTAL_CHARS) {
    d.warn(
      'items',
      'evidence-too-large',
      `the summaries and excerpts in evidence.json total ${total} chars; the published cap is ${EVIDENCE_MAX_TOTAL_CHARS}. Quote the part that carries the claim.`
    );
  }
}

// An excerpt is optional and bounded. It is a reading aid beside the ref, so a
// reviewer without repository access still learns something; it never replaces
// the ref, and it is redacted and truncated when the bundle is written.
function validateExcerpt(d, item, path, isPrivate) {
  if (item.excerpt !== undefined && item.excerpt !== null) {
    if (!isText(item.excerpt)) {
      d.error(`${path}.excerpt`, 'invalid-type', `${path}.excerpt must be a non-empty string or null`);
    } else {
      const lines = item.excerpt.split('\n').length;
      if (lines > EXCERPT_MAX_LINES || item.excerpt.length > EXCERPT_MAX_CHARS) {
        d.warn(
          `${path}.excerpt`,
          'too-long',
          `${path}.excerpt is ${lines} line(s) / ${item.excerpt.length} chars; it is published truncated to ${EXCERPT_MAX_LINES} lines and ${EXCERPT_MAX_CHARS} chars. Quote the part that carries the claim.`
        );
      }
      if (isPrivate) {
        d.error(`${path}.excerpt`, 'private-excerpt', `${path}.excerpt cannot be published for a private descriptor; remove the excerpt or drop "visibility": "private"`);
      }
    }
  }

  if (item.lines === undefined || item.lines === null) return;
  const ok = Array.isArray(item.lines)
    && item.lines.length >= 1
    && item.lines.length <= 2
    && item.lines.every((n) => Number.isInteger(n) && n >= 1)
    && (item.lines.length === 1 || item.lines[1] >= item.lines[0]);
  if (!ok) {
    d.error(`${path}.lines`, 'invalid-type', `${path}.lines must be [start] or [start, end], 1-based, with end >= start`);
  } else if (item.kind !== 'file' && item.kind !== 'image') {
    d.warn(`${path}.lines`, 'ignored-field', `${path}.lines only anchors a file or image ref; it is ignored for kind "${item.kind}"`);
  }
}

// --- packet-level checks ---------------------------------------------------

/** Collect every evidence ID a plan references, with the path that references it. */
export function planEvidenceRefs(plan) {
  const refs = [];
  if (!isObject(plan)) return refs;
  const collect = (list, path) => {
    if (!Array.isArray(list)) return;
    list.forEach((item, i) => {
      if (!isObject(item) || !Array.isArray(item.evidence)) return;
      item.evidence.forEach((id, j) => {
        if (isText(id)) refs.push({ id, path: `${path}[${i}].evidence[${j}]` });
      });
    });
  };
  collect(plan.currentState, 'currentState');
  collect(plan.approach, 'approach');
  collect(plan.risks, 'risks'); // string risks carry no evidence and are skipped
  collect(plan.alternatives, 'alternatives');
  if (isObject(plan.decision) && Array.isArray(plan.decision.evidence)) {
    plan.decision.evidence.forEach((id, j) => {
      if (isText(id)) refs.push({ id, path: `decision.evidence[${j}]` });
    });
  }
  return refs;
}

/**
 * Validate a plan together with its evidence bundle, including cross-references.
 * `evidence` may be null when the workdir has no evidence.json.
 * Returns { ok, errors, warnings } with paths prefixed by their file.
 */
export function validatePacket({ plan, evidence = null }) {
  const d = bag();
  const push = (file, res) => {
    for (const e of res.errors) d.error(`${file}:${e.path}`, e.code, e.message);
    for (const w of res.warnings) d.warn(`${file}:${w.path}`, w.code, w.message);
  };
  const planRes = validatePlan(plan);
  push('plan.json', planRes);

  let evidenceIds = null;
  if (evidence !== null) {
    const evRes = validateEvidence(evidence);
    push('evidence.json', evRes);
    if (evRes.ok) evidenceIds = (evidence.items || []).map((it) => it.id);
  }

  // A dangling evidence ID is an authoring bug, not graceful degradation: the
  // claim promises a source that the packet cannot resolve.
  if (planRes.ok) {
    const refs = planEvidenceRefs(plan);
    for (const ref of refs) {
      if (evidenceIds === null) {
        if (evidence === null) {
          d.error(
            `plan.json:${ref.path}`,
            'missing-evidence-file',
            `${ref.path} references evidence "${ref.id}" but the workdir has no evidence.json`
          );
        }
        continue;
      }
      if (!evidenceIds.includes(ref.id)) {
        d.error(
          `plan.json:${ref.path}`,
          'unknown-evidence',
          `${ref.path} references evidence "${ref.id}", which is not declared in evidence.json`
        );
      }
    }
    if (evidenceIds) {
      const used = new Set(refs.map((r) => r.id));
      // A descriptor earns its place either by backing a claim or by anchoring to
      // a chapter. Both are declarations of where it belongs; only a descriptor
      // with neither is decoration. Without the second route, a collector that
      // attaches twelve diffs would force twelve citations, and an agent that has
      // to cite everything attaches less proof — the opposite of the point.
      const items = evidence.items || [];
      for (const [i, id] of evidenceIds.entries()) {
        if (used.has(id) || items[i]?.chapterIds?.length) continue;
        d.warn(
          `evidence.json:items[${i}].id`,
          'unused-evidence',
          `evidence "${id}" is declared but no plan claim references it and it names no chapter`
        );
      }
      // The other direction, said ONCE for the whole packet: evidence is declared
      // and not one claim cites any of it. Per-descriptor pressure was relaxed above
      // on purpose, which left nothing at all asking an agent to connect a source to
      // the sentence it backs — and a packet of twelve uncited descriptors is a
      // folder of attachments, not evidence. One warning restores the pressure
      // without restoring the noise.
      if (evidenceIds.length > 0 && refs.length === 0) {
        d.warn(
          'evidence.json:items',
          'uncited-evidence',
          `evidence.json declares ${evidenceIds.length} descriptor(s) (${evidenceIds.slice(0, 3).join(', ')}${evidenceIds.length > 3 ? ', …' : ''}) and no claim cites any of them. Add the id to the currentState, approach, risk, alternative or decision it backs.`
        );
      }
      warnUnpinned(d, evidence, plan.links || {});
    }
  }
  return d.result();
}

// A file or image ref only stays true if it is pinned to a revision: `main`
// moves, and the reviewer would then read something the agent never saw. This
// warns rather than fails, because a plan can be authored before the commit
// exists; the published descriptor says "unpinned" either way.
function warnUnpinned(d, evidence, links) {
  const commit = links.commit;
  for (const [i, item] of (evidence.items || []).entries()) {
    if (item.kind !== 'file' && item.kind !== 'image') continue;
    if (item.visibility === 'private') continue;
    if (isText(item.revision) || isText(commit)) continue;
    d.warn(
      `evidence.json:items[${i}].revision`,
      'unpinned-evidence',
      `evidence "${item.id}" is not pinned: set items[${i}].revision or links.commit to a git SHA, or the published link would drift away from what you read`
    );
  }
}

/** Render diagnostics as terse, greppable lines. */
export function formatDiagnostics({ errors = [], warnings = [] }) {
  const line = (level, x) => `  ${level.padEnd(5)} ${x.path || '(root)'}  ${x.message}`;
  return [...errors.map((e) => line('error', e)), ...warnings.map((w) => line('warn', w))].join('\n');
}
