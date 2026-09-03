// reply.json — the Plan Spool reply contract (roadmap R4.2).
//
// A reply is a child spool that addresses ONE moment of a parent Plan Spool. The
// video says the thing; this descriptor says what it is about, so the answer lands
// back on the moment it answers instead of arriving as a second, unrelated link.
//
// Like schema.mjs this module is dependency-free and pure: the CLI validates a
// descriptor before recording, `spool share` publishes it, and the server checks the
// same rules again at publish. See CONTRACTS.md "Replies".

export const REPLY_VERSION = 1;
export const REPLY_FILE = 'reply.json';

/**
 * What a reply is for. Each kind answers a different question the parent left open,
 * so each is legal only while the parent is in a state where that question stands.
 */
export const REPLY_KINDS = ['answer', 'revision', 'status', 'proof'];

/**
 * The parent states each kind may reply to. This is the "validated against the
 * parent's state" rule: a proof for a plan nobody approved, or a revision of a plan
 * that was never sent back, is a mistake the CLI catches before a take is recorded.
 *
 * `superseded` is absent everywhere: a replaced revision takes no new replies, by the
 * same rule that stops it taking new questions.
 */
export const REPLY_KIND_STATES = {
  // Answering is taking part in the discussion, so it follows the discussable states.
  answer: ['published', 'awaiting_decision', 'approved', 'redirected', 'needs_input', 'revised', 'implementing', 'proved'],
  // A revision is recorded after the plan came back and before it publishes again.
  revision: ['redirected', 'needs_input', 'revised'],
  // Progress on work that was approved.
  status: ['approved', 'implementing'],
  // The close of the loop: the work running, against the plan that approved it.
  proof: ['approved', 'implementing', 'proved'],
};

/**
 * What a reply may point at. The first four are the question anchors (CONTRACTS.md
 * "Timestamped questions"), because a reply lands on the same moments a question can;
 * `question` is the fifth, and is what makes an answer an answer.
 */
export const REPLY_ANCHOR_TYPES = ['question', 'chapter', 'range', 'evidence', 'approach'];

/** A reply addresses a moment, not a plan: a handful of anchors is already generous. */
export const MAX_ANCHORS = 4;
/** One line, so it reads on a timeline row beside the video it introduces. */
export const MAX_SUMMARY = 300;
/** Same bound the question anchors use, so a range means the same thing on both. */
export const MAX_RANGE_SECONDS = 600;
const MAX_CLOCK_SECONDS = 24 * 60 * 60;

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
// The chapter ids a reply may anchor to. Duplicated from schema.mjs deliberately:
// this module is the one a consumer imports for reply rules, and CHAPTER_IDS is the
// packet's vocabulary, not the reply's.
import { CHAPTER_IDS } from './schema.mjs';
// What a proof CLAIMS (roadmap R5.1). A proof is a reply, so the block rides on this
// descriptor; the rules it must satisfy are their own module.
import { buildProof, proofAllowedIn, proofDigest, validateProof } from './proof.mjs';
// A `status` reply carries one more block than the others: the report a reviewer skims
// instead of watching (roadmap R5.4). Its rules live in status.mjs; this module only
// says which kind must carry it.
import { buildShareStatus, checkStatusReport, statusDigest } from './status.mjs';

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

function seconds(v) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > MAX_CLOCK_SECONDS) return null;
  return Math.round(n * 1000) / 1000;
}

/**
 * The parent facts a reply is checked against, as `spool reply` reads them out of the
 * agent read payload. Everything is optional: an offline caller can still check the
 * descriptor's shape, it just cannot check that the anchors point at anything real.
 *
 * @typedef {{ spoolId?: string, revisionId?: string, status?: string,
 *             approach?: {id: string}[], evidence?: {id: string}[],
 *             questionIds?: string[] }} ParentFacts
 */

/**
 * Check one anchor, against the parent's packet when it is known.
 * Returns { ok: true, anchor } or { ok: false, error }.
 */
export function checkReplyAnchor(input, parent = {}) {
  const no = (error) => ({ ok: false, error });
  if (!isObject(input)) return no('an anchor must be an object');
  const type = input.type;
  if (!REPLY_ANCHOR_TYPES.includes(type)) return no(`anchor.type must be one of ${REPLY_ANCHOR_TYPES.join(', ')}`);

  if (type === 'question') {
    if (!isText(input.questionId) || !ID_RE.test(input.questionId.trim())) return no('anchor.questionId is required');
    const id = input.questionId.trim();
    // Only checked when the caller could read the discussion; an unknown list is not
    // an empty one, so a reply is never refused for a question it cannot see.
    if (parent.questionIds && !parent.questionIds.includes(id)) return no(`this plan has no live question "${id}"`);
    return { ok: true, anchor: { type, questionId: id } };
  }
  if (type === 'chapter') {
    if (!CHAPTER_IDS.includes(input.chapterId)) return no(`anchor.chapterId must be one of ${CHAPTER_IDS.join(', ')}`);
    return { ok: true, anchor: { type, chapterId: input.chapterId } };
  }
  if (type === 'range') {
    const start = seconds(input.start);
    const end = seconds(input.end);
    if (start === null || end === null) return no('anchor.start and anchor.end must be seconds on the video clock');
    if (end <= start) return no('anchor.end must be after anchor.start');
    if (end - start > MAX_RANGE_SECONDS) return no(`a range anchor must be at most ${MAX_RANGE_SECONDS} seconds`);
    return { ok: true, anchor: { type, start, end } };
  }
  if (type === 'evidence') {
    if (!isText(input.evidenceId)) return no('anchor.evidenceId is required');
    const id = input.evidenceId.trim();
    if (parent.evidence && !parent.evidence.some((e) => e.id === id)) return no(`this plan has no evidence "${id}"`);
    return { ok: true, anchor: { type, evidenceId: id } };
  }
  if (!isText(input.approachId)) return no('anchor.approachId is required');
  const id = input.approachId.trim();
  if (parent.approach && !parent.approach.some((s) => s.id === id)) return no(`this plan has no approach step "${id}"`);
  return { ok: true, anchor: { type, approachId: id } };
}

/** Is `kind` a reply the parent's current state can still take? */
export function kindAllowedIn(kind, status) {
  const states = REPLY_KIND_STATES[kind];
  if (!states) return false;
  // An unknown status (offline read) cannot refuse a reply: the server checks again.
  if (!status || status === 'unknown') return true;
  return states.includes(status);
}

/**
 * Validate a reply descriptor, optionally against the parent it names.
 * Returns { ok, errors, warnings } in the same shape as the packet validator, so
 * `formatDiagnostics` prints both.
 */
export function validateReply(value, parent = {}) {
  const errors = [];
  const warnings = [];
  const error = (path, code, message) => errors.push({ path, code, message });

  if (!isObject(value)) {
    error('reply', 'invalid-type', 'reply.json must be a JSON object');
    return { ok: false, errors, warnings };
  }
  if (value.version !== REPLY_VERSION) {
    error('version', 'invalid-version', `version must be ${REPLY_VERSION} (got ${JSON.stringify(value.version)})`);
  }
  if (value.kind !== 'reply') error('kind', 'invalid-kind', 'kind must be "reply"');

  if (!REPLY_KINDS.includes(value.replyKind)) {
    error('replyKind', 'invalid-kind', `replyKind must be one of ${REPLY_KINDS.join(', ')}`);
  }

  // The lineage ids are the whole point: without them a reply is an orphan video.
  const p = isObject(value.parent) ? value.parent : null;
  if (!p) {
    error('parent', 'required', 'parent must name the plan being replied to: { spoolId, revisionId }');
  } else {
    if (!isText(p.spoolId)) error('parent.spoolId', 'required', 'parent.spoolId is required (the published plan this answers)');
    if (!isText(p.revisionId)) error('parent.revisionId', 'required', 'parent.revisionId is required (the revision this answers)');
    // A descriptor that names a different plan than the one it was checked against is
    // a cross-plan reply — the exact mistake the parent lookup exists to catch.
    if (parent.spoolId && isText(p.spoolId) && p.spoolId !== parent.spoolId) {
      error('parent.spoolId', 'cross-plan', `this descriptor names plan ${p.spoolId}, but the parent read is ${parent.spoolId}`);
    }
    if (parent.revisionId && isText(p.revisionId) && p.revisionId !== parent.revisionId) {
      error('parent.revisionId', 'stale-revision', `revision ${p.revisionId} is not the plan's active revision (${parent.revisionId})`);
    }
  }

  // A proof is the one kind that can talk its way past the state rule, because R5.1
  // says so: a proof against a plan nobody approved is refused UNLESS the proof
  // acknowledges it. Every other kind has no such escape hatch.
  const stateOk =
    value.replyKind === 'proof'
      ? proofAllowedIn(parent.status, value.proof)
      : kindAllowedIn(value.replyKind, parent.status);
  if (REPLY_KINDS.includes(value.replyKind) && !stateOk) {
    error(
      'replyKind',
      'wrong-state',
      value.replyKind === 'proof'
        ? `a proof needs the plan to be ${REPLY_KIND_STATES.proof.join(', ')} — it is ${parent.status}. ` +
          'Pass --override unapproved --override-reason "…" to prove work nobody approved.'
        : `a "${value.replyKind}" reply needs the plan to be ${REPLY_KIND_STATES[value.replyKind].join(', ')} — it is ${parent.status}`
    );
  }

  const anchors = value.anchors;
  if (anchors !== undefined && !Array.isArray(anchors)) {
    error('anchors', 'invalid-type', 'anchors must be an array');
  } else {
    const list = anchors ?? [];
    if (list.length > MAX_ANCHORS) error('anchors', 'too-many', `at most ${MAX_ANCHORS} anchors (got ${list.length})`);
    list.forEach((a, i) => {
      const res = checkReplyAnchor(a, parent);
      if (!res.ok) error(`anchors[${i}]`, 'invalid-anchor', res.error);
    });
    // An answer that does not say what it answers is a video somebody has to watch to
    // place. Every other kind is about the plan as a whole, so an anchor is optional.
    if (value.replyKind === 'answer' && !list.some((a) => isObject(a) && a.type === 'question')) {
      warnings.push({
        path: 'anchors',
        code: 'unanchored-answer',
        message: 'an answer with no question anchor cannot open on the question it answers — pass --question <id>',
      });
    }
  }

  // Exactly one kind carries a report, and it always carries one: a status spool with
  // no verdict is a video somebody has to watch to learn whether the work is on plan,
  // which is the thing R5.4 exists to remove.
  if (value.replyKind === 'status') {
    const report = checkStatusReport(value.status, parent);
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  } else if (value.status !== undefined && value.status !== null) {
    error('status', 'unexpected', `only a "status" reply carries a status report (this is a "${value.replyKind}")`);
  }

  if (value.summary !== undefined && value.summary !== null) {
    if (!isText(value.summary)) error('summary', 'invalid-type', 'summary must be a non-empty string');
    else if (value.summary.length > MAX_SUMMARY) {
      error('summary', 'too-long', `summary is ${value.summary.length} chars; keep it under ${MAX_SUMMARY} so it reads on a timeline row`);
    }
  }

  // The proof block belongs to exactly one kind. On a proof it is required — a proof
  // that enumerates nothing is the "buried in narration" failure R5.1 exists to stop.
  // On any other kind it is a mistake worth naming rather than dropping in silence.
  if (value.replyKind === 'proof') {
    const report = validateProof(value.proof, parent);
    errors.push(...report.errors);
    warnings.push(...report.warnings);
  } else if (value.proof !== undefined && value.proof !== null) {
    error('proof', 'wrong-kind', `a "proof" block belongs to a proof reply; this is a "${value.replyKind}"`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * The published copy of a descriptor: the lineage, the kind, the anchors and the
 * summary, and nothing a consumer has to guess at. Pure, so bundles diff cleanly.
 */
export function buildShareReply(reply) {
  return {
    version: REPLY_VERSION,
    kind: 'reply',
    replyKind: reply.replyKind,
    parent: {
      spoolId: reply.parent.spoolId,
      revisionId: reply.parent.revisionId,
      ...(Number.isInteger(reply.parent.revision) ? { revision: reply.parent.revision } : {}),
      ...(isText(reply.parent.watch) ? { watch: reply.parent.watch } : {}),
    },
    anchors: (reply.anchors ?? []).map((a) => checkReplyAnchor(a).anchor).filter(Boolean),
    summary: isText(reply.summary) ? reply.summary.trim() : null,
    // Only a proof carries one, and by the time a descriptor is built it has been
    // validated, so the block is there and normalizing it cannot throw.
    ...(reply.replyKind === 'proof' ? { proof: buildProof(reply.proof) } : {}),
    ...(reply.replyKind === 'status' ? { status: buildShareStatus(reply.status) } : {}),
  };
}

/**
 * The block `spool share` stamps into spool.json, and therefore what the watch page
 * and `/api/publish` read. Identical to the published copy minus the file pointer,
 * which is added by the caller that knows the bundle layout.
 */
export function replySummary(shareReply) {
  return { file: REPLY_FILE, ...shareReply };
}

// ---------------------------------------------------------------------------
// Workdir I/O
// ---------------------------------------------------------------------------

/** True when the workdir carries a reply descriptor. Ordinary spools are untouched. */
export function hasReply(workdir) {
  return existsSync(join(resolve(workdir), REPLY_FILE));
}

/**
 * Read and validate the descriptor in a workdir.
 * Returns { present, ok, reply, errors, warnings }; a workdir with no reply.json
 * returns { present: false, ok: true } so every caller can gate on it unconditionally.
 *
 * The parent is NOT re-read here: `spool reply` checked it when the descriptor was
 * written, and the server checks it again at publish. A share run offline still
 * produces a bundle a reader can follow.
 */
export async function readReplyPacket(workdir) {
  const path = join(resolve(workdir), REPLY_FILE);
  if (!existsSync(path)) return { present: false, ok: true, reply: null, errors: [], warnings: [] };
  let reply;
  try {
    reply = JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    return {
      present: true,
      ok: false,
      reply: null,
      errors: [{ path: REPLY_FILE, code: 'invalid-json', message: `${REPLY_FILE} is not valid JSON: ${e.message}` }],
      warnings: [],
    };
  }
  const res = validateReply(reply);
  return { present: true, ok: res.ok, reply, errors: res.errors, warnings: res.warnings };
}

/**
 * Write share/reply.json for a validated descriptor. Returns the block spool.json
 * points at, or null when the workdir carries no reply. Throws on an invalid one:
 * a published reply that names no parent is an orphan video, which is worse than a
 * plain spool.
 */
export async function writeShareReply(workdir, shareDir) {
  const packet = await readReplyPacket(workdir);
  if (!packet.present) return null;
  if (!packet.ok) {
    const detail = packet.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n');
    throw new Error(`share: ${join(workdir, REPLY_FILE)} is invalid, so the published reply would be an orphan:\n${detail}`);
  }
  const shareReply = buildShareReply(packet.reply);
  await writeFile(join(shareDir, REPLY_FILE), JSON.stringify(shareReply, null, 2) + '\n');
  return replySummary(shareReply);
}

/** One-line human digest of a reply, for `spool read`. */
export function replyDigest(shareReply) {
  const lines = [`reply:    ${shareReply.replyKind} to plan ${shareReply.parent.spoolId}`];
  // The verdict comes before everything else a status says, because it is the only
  // line a reviewer is guaranteed to read.
  if (shareReply.replyKind === 'status' && shareReply.status) {
    lines.push(`  work:     ${statusDigest(shareReply.status, { indent: '    ' })}`);
  }
  lines.push(`  revision: ${shareReply.parent.revisionId}`);
  if (shareReply.parent.watch) lines.push(`  parent:   ${shareReply.parent.watch}`);
  for (const a of shareReply.anchors ?? []) {
    const target =
      a.type === 'question' ? a.questionId
      : a.type === 'chapter' ? a.chapterId
      : a.type === 'range' ? `${a.start}s–${a.end}s`
      : a.type === 'evidence' ? a.evidenceId
      : a.approachId;
    lines.push(`  about:    ${a.type} ${target}`);
  }
  if (shareReply.summary) lines.push(`  says:     ${shareReply.summary}`);
  if (shareReply.proof) lines.push(proofDigest(shareReply.proof));
  return lines.join('\n');
}
