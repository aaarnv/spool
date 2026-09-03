// The proof block — what a proof spool CLAIMS (roadmap R5.1).
//
// A proof is already a reply: `spool reply <plan> --kind proof` names the parent plan
// and the revision it proves, and R4.2 built the lineage that carries it. What R4.2
// does not say is what the proof actually verified. A video that says "here it is
// working" leaves a reviewer to watch the whole recording and compare it against the
// proposal in their head — and leaves every deviation buried in narration, where no
// reader can find it and no agent can read it.
//
// So a proof enumerates. Every approach step of the parent revision, plus the outcome,
// gets one verdict; anything that is not `verified` must be named by a deviation. That
// is the R5.1 non-functional requirement stated as a validation rule: a deviation is a
// field, not a sentence somebody said at 0:48.
//
// Dependency-free and pure, like schema.mjs and reply.mjs: the CLI checks a proof
// before a take is recorded, `spool share` publishes it, and web/lib/planProof.ts
// checks the same rules again at publish, against the database.
//
// See CONTRACTS.md "Proof linkage".

/**
 * Whether the claim rests on a recording or on the evidence beside it.
 *
 * PROVISIONAL (roadmap R5.1 human taste, recommended default): video for UI and
 * behavioural work, where seeing it run IS the proof; `evidence` for low-visibility
 * infrastructure work, where a migration log or a test run says more than a screen.
 * The mode is declared rather than inferred, so a reviewer meeting an `evidence` proof
 * knows there is no walkthrough to watch before they press play.
 */
export const PROOF_MODES = ['video', 'evidence'];

/**
 * One verdict per planned item. Three words, used the same way for the outcome and for
 * an approach step:
 *
 * - `verified` — this proof shows it done, as planned.
 * - `partial`  — done, but not the whole of what was proposed.
 * - `unmet`    — not done, or done differently enough that the plan no longer describes it.
 *
 * `partial` and `unmet` are deviations by definition, so both demand one.
 */
export const PROOF_STATUSES = ['verified', 'partial', 'unmet'];

/** What a deviation is a deviation FROM. `plan` is the catch-all: the work as a whole. */
export const DEVIATION_SOURCES = ['outcome', 'approach', 'plan'];

/** A plan with more steps than this is not a plan a 90-second video can prove. */
export const MAX_ITEMS = 50;
/** Deviations are the exceptions. A proof that has 25 of them is a redirect. */
export const MAX_DEVIATIONS = 25;
/** One line each, so the lineage card reads without scrolling. */
export const MAX_NOTE = 300;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const text = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * Does this proof acknowledge landing on a parent it normally could not?
 *
 * Returns the two acknowledgements as booleans. Absent, empty, or all-false reads as
 * "no override was asked for", so a caller never has to distinguish those three.
 */
export function proofOverride(proof) {
  const o = isObject(proof) && isObject(proof.override) ? proof.override : null;
  return {
    unapproved: o?.unapproved === true,
    superseded: o?.superseded === true,
    reason: o && isText(o.reason) ? o.reason.trim() : null,
  };
}

/** True when either acknowledgement is set, i.e. the reason is required and shown. */
export const hasOverride = (proof) => {
  const o = proofOverride(proof);
  return o.unapproved || o.superseded;
};

/**
 * Validate a proof block, optionally against the parent revision it proves.
 *
 * Returns { ok, errors, warnings } in the packet validator's shape, so
 * `formatDiagnostics` prints it. `path` is rooted at `proof`, because this block is
 * always nested inside reply.json.
 *
 * @param {unknown} value the `proof` block
 * @param {{approach?: {id: string}[], status?: string}} parent the parent facts, when known
 */
export function validateProof(value, parent = {}) {
  const errors = [];
  const warnings = [];
  const error = (path, code, message) => errors.push({ path, code, message });

  if (!isObject(value)) {
    error('proof', 'required', 'a proof reply must carry a "proof" block saying what it verifies');
    return { ok: false, errors, warnings };
  }

  if (value.mode !== undefined && !PROOF_MODES.includes(value.mode)) {
    error('proof.mode', 'invalid-mode', `proof.mode must be one of ${PROOF_MODES.join(', ')} (default video)`);
  }

  // ---- the outcome verdict -------------------------------------------------
  const outcome = value.outcome;
  if (!isObject(outcome)) {
    error(
      'proof.outcome',
      'required',
      'proof.outcome must say whether the planned outcome is verified, partial or unmet — pass --verifies outcome'
    );
  } else if (!PROOF_STATUSES.includes(outcome.status)) {
    error('proof.outcome.status', 'invalid-status', `proof.outcome.status must be one of ${PROOF_STATUSES.join(', ')}`);
  }
  checkNote(outcome?.note, 'proof.outcome.note', error);

  // ---- the approach enumeration -------------------------------------------
  const steps = value.approach;
  const seen = new Map();
  if (!Array.isArray(steps)) {
    error('proof.approach', 'required', 'proof.approach must list one verdict per approach step of the plan');
  } else if (steps.length > MAX_ITEMS) {
    error('proof.approach', 'too-many', `at most ${MAX_ITEMS} steps (got ${steps.length})`);
  } else {
    steps.forEach((s, i) => {
      if (!isObject(s)) return error(`proof.approach[${i}]`, 'invalid-type', 'each entry must be an object');
      const id = text(s.id);
      if (!id) return error(`proof.approach[${i}].id`, 'required', 'each entry must name the approach step it verifies');
      if (seen.has(id)) error(`proof.approach[${i}].id`, 'duplicate', `approach step "${id}" is claimed twice`);
      else seen.set(id, s.status);
      if (!PROOF_STATUSES.includes(s.status)) {
        error(`proof.approach[${i}].status`, 'invalid-status', `status must be one of ${PROOF_STATUSES.join(', ')}`);
      }
      checkNote(s.note, `proof.approach[${i}].note`, error);
    });

    // Enumeration is the whole point: a step left out of the list is a step nobody
    // said anything about, which reads on the card exactly like a step that passed.
    // Only checkable when the parent's packet is in hand — offline, the server checks.
    if (Array.isArray(parent.approach) && parent.approach.length) {
      const planned = parent.approach.map((s) => s.id);
      const missing = planned.filter((id) => !seen.has(id));
      if (missing.length) {
        error(
          'proof.approach',
          'incomplete',
          `every approach step of the plan needs a verdict; missing: ${missing.join(', ')}`
        );
      }
      for (const [id] of seen) {
        if (!planned.includes(id)) error('proof.approach', 'unknown-step', `this plan has no approach step "${id}"`);
      }
    }
  }

  // ---- deviations ----------------------------------------------------------
  const deviations = value.deviations;
  const covered = { outcome: false, plan: false, approach: new Set() };
  if (deviations !== undefined && deviations !== null && !Array.isArray(deviations)) {
    error('proof.deviations', 'invalid-type', 'proof.deviations must be an array');
  } else {
    const list = Array.isArray(deviations) ? deviations : [];
    if (list.length > MAX_DEVIATIONS) {
      error('proof.deviations', 'too-many', `at most ${MAX_DEVIATIONS} deviations (got ${list.length})`);
    }
    list.forEach((d, i) => {
      if (!isObject(d)) return error(`proof.deviations[${i}]`, 'invalid-type', 'each deviation must be an object');
      if (!DEVIATION_SOURCES.includes(d.from)) {
        return error(`proof.deviations[${i}].from`, 'invalid-source', `from must be one of ${DEVIATION_SOURCES.join(', ')}`);
      }
      if (!isText(d.summary)) {
        error(`proof.deviations[${i}].summary`, 'required', 'a deviation must say what was done differently');
      } else if (d.summary.length > MAX_NOTE) {
        error(`proof.deviations[${i}].summary`, 'too-long', `keep a deviation under ${MAX_NOTE} chars; the detail belongs in the video`);
      }
      if (d.from === 'approach') {
        const id = text(d.id);
        if (!id) return error(`proof.deviations[${i}].id`, 'required', 'a deviation from an approach step must name the step');
        if (seen.size && !seen.has(id)) {
          error(`proof.deviations[${i}].id`, 'unknown-step', `this proof claims no approach step "${id}"`);
        }
        covered.approach.add(id);
      } else {
        covered[d.from] = true;
      }
    });
  }

  // ---- the rule the whole block exists for --------------------------------
  // A verdict that is not `verified` and has no deviation beside it is a deviation
  // buried in narration: the card would show "partial" with nothing saying why.
  if (isObject(outcome) && PROOF_STATUSES.includes(outcome.status) && outcome.status !== 'verified' && !covered.outcome) {
    error(
      'proof.deviations',
      'unstated-deviation',
      `the outcome is "${outcome.status}", so a deviation must state what differs — add { "from": "outcome", "summary": "…" }`
    );
  }
  for (const [id, status] of seen) {
    if (status === 'verified' || !PROOF_STATUSES.includes(status)) continue;
    if (covered.approach.has(id)) continue;
    error(
      'proof.deviations',
      'unstated-deviation',
      `approach step "${id}" is "${status}", so a deviation must state what differs — add { "from": "approach", "id": "${id}", "summary": "…" }`
    );
  }

  // A proof that verifies nothing is a status spool wearing the wrong kind.
  const anyVerified =
    (isObject(outcome) && outcome.status === 'verified') || [...seen.values()].some((s) => s === 'verified');
  if (!anyVerified && !errors.some((e) => e.code === 'required')) {
    error(
      'proof',
      'nothing-verified',
      'a proof must verify at least the outcome or one approach step — publish a "status" reply instead'
    );
  }

  // ---- the override --------------------------------------------------------
  const o = proofOverride(value);
  if (isObject(value.override)) {
    for (const key of Object.keys(value.override)) {
      if (!['unapproved', 'superseded', 'reason'].includes(key)) {
        warnings.push({ path: `proof.override.${key}`, code: 'unknown-field', message: 'unknown override field, ignored' });
      }
    }
  }
  if ((o.unapproved || o.superseded) && !o.reason) {
    error('proof.override.reason', 'required', 'an override must say why — the reason is shown to the reviewer beside the proof');
  }
  if (o.reason && o.reason.length > MAX_NOTE) {
    error('proof.override.reason', 'too-long', `keep the reason under ${MAX_NOTE} chars`);
  }
  // An override nobody needed is noise on the card, and it hides the day one IS needed.
  if (o.unapproved && parent.status && APPROVED_STATES.includes(parent.status)) {
    warnings.push({
      path: 'proof.override.unapproved',
      code: 'needless-override',
      message: `the plan is ${parent.status}, so this proof needs no unapproved override`,
    });
  }

  return { ok: errors.length === 0, errors, warnings };
}

function checkNote(note, path, error) {
  if (note === undefined || note === null) return;
  if (typeof note !== 'string') return error(path, 'invalid-type', 'a note must be a string');
  if (note.length > MAX_NOTE) error(path, 'too-long', `keep a note under ${MAX_NOTE} chars; the detail belongs in the video`);
}

/**
 * The parent states a proof may land on without an override. Narrower than
 * REPLY_KIND_STATES.proof by nothing — it IS that list, restated here because the
 * override reasons about approval, not about reply kinds.
 */
export const APPROVED_STATES = ['approved', 'implementing', 'proved'];

/**
 * May a proof land on a parent in this state? The R5.1 validation rule: a proof against
 * a plan nobody approved is refused UNLESS the proof says so out loud.
 */
export function proofAllowedIn(status, proof) {
  if (!status || status === 'unknown') return true;
  if (APPROVED_STATES.includes(status)) return true;
  return proofOverride(proof).unapproved;
}

/**
 * The published copy: normalized, defaulted, and stripped of anything nobody declared.
 * Pure, so bundles diff cleanly and the server can compare what it stored.
 */
export function buildProof(proof) {
  const o = proofOverride(proof);
  const out = {
    mode: PROOF_MODES.includes(proof.mode) ? proof.mode : 'video',
    outcome: {
      status: proof.outcome.status,
      note: isText(proof.outcome.note) ? proof.outcome.note.trim() : null,
    },
    approach: (proof.approach ?? []).map((s) => ({
      id: text(s.id),
      status: s.status,
      note: isText(s.note) ? s.note.trim() : null,
    })),
    deviations: (proof.deviations ?? []).map((d) => ({
      from: d.from,
      ...(d.from === 'approach' ? { id: text(d.id) } : {}),
      summary: text(d.summary),
    })),
  };
  // Absent unless one was asked for: an empty override object on every proof would
  // train a reader to skip the field on the proof that has one.
  if (o.unapproved || o.superseded) {
    out.override = { unapproved: o.unapproved, superseded: o.superseded, reason: o.reason };
  }
  return out;
}

// ---------------------------------------------------------------------------
// Authoring
// ---------------------------------------------------------------------------

/**
 * Build a proof block from the `spool reply --kind proof` flags.
 *
 * The flag grammar is one repeatable `--verifies`, because the alternative — a flag per
 * verdict — makes the common case ("everything shipped as planned") three flags long:
 *
 *   --verifies all                       every step and the outcome, verified
 *   --verifies outcome                   the outcome, verified
 *   --verifies data,api                  those two steps, verified
 *   --verifies ui:partial=the empty state is unstyled
 *   --verifies cache:unmet=dropped for now
 *
 * Throws on a spec it cannot read: a proof built from a typo would claim a verdict the
 * caller did not give.
 *
 * @param {string[]} specs   --verifies values, in order
 * @param {string[]} devs    --deviation values, "<from>[:<id>]=<summary>"
 * @param {{approach?: {id: string}[]}} parent
 */
export function proofFromOptions(specs, devs, opts = {}, parent = {}) {
  // No default verdict. A proof scaffolded with "everything passed" already in it is a
  // claim nobody made, and the reviewer cannot tell it apart from one somebody checked.
  if (!specs?.length) {
    throw new Error(
      'a proof must say what it verifies — pass --verifies all, or name each item: ' +
        '--verifies outcome --verifies data --verifies ui:partial="the empty state is unstyled"'
    );
  }
  const planned = (parent.approach ?? []).map((s) => s.id);
  let outcome = null;
  const steps = new Map();

  for (const raw of specs ?? []) {
    for (const part of splitSpecs(String(raw))) {
      const { id, status, note } = parseSpec(part);
      if (id === 'all') {
        if (note) throw new Error('--verifies all takes no note');
        outcome = { status, note: null };
        for (const p of planned) steps.set(p, { id: p, status, note: null });
        continue;
      }
      if (id === 'outcome') {
        outcome = { status, note };
        continue;
      }
      steps.set(id, { id, status, note });
    }
  }

  const deviations = (devs ?? []).map((raw) => parseDeviation(String(raw)));

  const proof = {
    mode: opts.mode ?? 'video',
    // Left out on purpose when no --verifies named it: the validator then says the
    // outcome is missing, rather than the CLI inventing a verdict for it.
    ...(outcome ? { outcome } : {}),
    // Planned order, so the card reads down the plan; anything the caller named that
    // the plan does not have is kept and refused by the validator, with its own message.
    approach: [
      ...planned.filter((id) => steps.has(id)).map((id) => steps.get(id)),
      ...[...steps.values()].filter((s) => !planned.includes(s.id)),
    ],
    deviations,
  };
  if (opts.override?.length) {
    const flags = { unapproved: false, superseded: false };
    for (const which of opts.override) {
      if (!(which in flags)) throw new Error(`--override must be "unapproved" or "superseded" (got "${which}")`);
      flags[which] = true;
    }
    proof.override = { ...flags, reason: opts.overrideReason ? String(opts.overrideReason).trim() : null };
  }
  return proof;
}

// A single --verifies value may carry a comma list, but only of bare ids: a note can
// contain a comma, so `ui:partial=a, b` must stay one spec.
function splitSpecs(raw) {
  return raw.includes('=') ? [raw] : raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function parseSpec(spec) {
  const eq = spec.indexOf('=');
  const head = eq === -1 ? spec : spec.slice(0, eq);
  const note = eq === -1 ? null : spec.slice(eq + 1).trim() || null;
  const [id, status = 'verified'] = head.split(':').map((s) => s.trim());
  if (!id) throw new Error(`--verifies needs an approach step id, "outcome", or "all" (got "${spec}")`);
  if (!PROOF_STATUSES.includes(status)) {
    throw new Error(`--verifies ${id}: status must be one of ${PROOF_STATUSES.join(', ')} (got "${status}")`);
  }
  return { id, status, note };
}

function parseDeviation(raw) {
  const eq = raw.indexOf('=');
  if (eq === -1) throw new Error(`--deviation must be "<outcome|plan|approach:<id>>=<what differs>" (got "${raw}")`);
  const summary = raw.slice(eq + 1).trim();
  const [from, id] = raw.slice(0, eq).split(':').map((s) => s.trim());
  if (!DEVIATION_SOURCES.includes(from)) {
    throw new Error(`--deviation source must be one of ${DEVIATION_SOURCES.join(', ')} (got "${from}")`);
  }
  if (from === 'approach' && !id) throw new Error('--deviation approach:<id>=… must name the approach step');
  if (!summary) throw new Error(`--deviation "${raw}" says nothing about what differs`);
  return from === 'approach' ? { from, id, summary } : { from, summary };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const MARK = { verified: '✓', partial: '~', unmet: '✗' };

/** The proof block as `spool read` prints it, under the reply digest. */
export function proofDigest(proof) {
  const lines = [`  proves:   outcome ${MARK[proof.outcome.status] ?? '?'} ${proof.outcome.status}${proof.outcome.note ? ` (${proof.outcome.note})` : ''}`];
  for (const s of proof.approach ?? []) {
    lines.push(`            ${s.id} ${MARK[s.status] ?? '?'} ${s.status}${s.note ? ` (${s.note})` : ''}`);
  }
  for (const d of proof.deviations ?? []) {
    lines.push(`  deviation: ${d.from}${d.id ? ` ${d.id}` : ''} — ${d.summary}`);
  }
  if (proof.mode === 'evidence') lines.push('  mode:     evidence-only (the evidence carries the claim, not the recording)');
  if (proof.override) {
    const which = [proof.override.unapproved && 'unapproved', proof.override.superseded && 'superseded'].filter(Boolean);
    lines.push(`  override: ${which.join(' + ')} — ${proof.override.reason}`);
  }
  return lines.join('\n');
}
