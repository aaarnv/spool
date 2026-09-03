// The implementation-status report (roadmap R5.4).
//
// A status spool is a `kind: "status"` reply: a child recording that says where the
// approved work is. The video says it; this block says it in a line a reviewer reads
// in seconds — the verdict first, then what is done, what changed, what is blocked,
// and whether the approved plan still holds.
//
// Like reply.mjs this module is dependency-free and pure. The CLI validates a report
// before a take is recorded, `spool share` publishes it inside reply.json, and the
// server checks the same rules again at publish (web/lib/planStatus.ts is its twin).
// See CONTRACTS.md "Implementation status".

/**
 * The headline, and the whole acceptance criterion: a reviewer tells on-plan from
 * changed from blocked without watching anything.
 *
 * There is no `done` verdict. Work that finished is `on_plan` with every approach step
 * in `completed`, and the recording that shows it running is a `proof` reply — one word
 * per meaning, so "the work is finished" is never two different claims.
 */
export const STATUS_VERDICTS = ['on_plan', 'changed', 'blocked'];

/**
 * Why this status exists — the cadence rule, made a field rather than a convention.
 *
 * A status spool is recorded at a material milestone, at a blocker, or when the work
 * needs a new decision. Nothing else earns a video, so a status that cannot name one of
 * the three is refused before it is recorded (`spool status` also refuses to run inside
 * a git hook, which is the noise this rule exists to prevent).
 */
export const STATUS_REASONS = ['milestone', 'blocker', 'decision'];

/** One line each, so the whole report reads on a timeline row. */
export const MAX_STATUS_TEXT = 400;
/** A status names the steps it finished, not a changelog. */
export const MAX_COMPLETED = 20;

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;
const text = (v) => (isText(v) ? v.trim() : null);

/** How each verdict reads to a human. Used by every digest, so they cannot drift. */
export const VERDICT_LABEL = {
  on_plan: 'on plan',
  changed: 'changed',
  blocked: 'blocked',
};

/** The one-line headline: the verdict, and whether the approved plan still holds. */
export function statusHeadline(report) {
  if (!isObject(report)) return 'status: unknown';
  const verdict = VERDICT_LABEL[report.verdict] ?? String(report.verdict);
  return `${verdict} · ${report.planValid ? 'the approved plan still holds' : 'the approved plan no longer holds'}`;
}

/**
 * Normalize a report from whatever a caller assembled: flags, a descriptor read off
 * disk, or a request body. Unknown fields are dropped, so a published report carries
 * exactly the contract and diffs cleanly.
 */
export function buildStatusReport(input = {}) {
  const completed = Array.isArray(input.completed) ? input.completed : [];
  const seen = new Set();
  const done = [];
  for (const id of completed) {
    const value = text(id);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    done.push(value);
  }
  return {
    verdict: isText(input.verdict) ? input.verdict.trim() : input.verdict,
    planValid: input.planValid,
    reason: isText(input.reason) ? input.reason.trim() : input.reason,
    completed: done,
    changed: text(input.changed),
    blocked: text(input.blocked),
    next: text(input.next),
  };
}

/**
 * Check a status report, against the parent packet when it is known.
 *
 * Returns { errors, warnings } in the diagnostic shape the packet validator uses, so
 * `formatDiagnostics` prints these beside the rest of a reply's problems. Paths are
 * prefixed `status.`, because the report is a block inside reply.json.
 *
 * The rules are the report's own logic, and each one exists to stop a status that reads
 * true and is not: a plan that no longer holds cannot be reported as on-plan, a change
 * with nothing said about it is a claim a reviewer cannot check, and a milestone that
 * completed nothing is the per-commit noise the roadmap refuses.
 */
export function checkStatusReport(report, parent = {}) {
  const errors = [];
  const warnings = [];
  const error = (path, code, message) => errors.push({ path: `status.${path}`, code, message });

  if (!isObject(report)) {
    errors.push({ path: 'status', code: 'required', message: 'a status reply must carry a status report: { verdict, planValid, reason }' });
    return { errors, warnings };
  }

  const verdict = report.verdict;
  if (!STATUS_VERDICTS.includes(verdict)) {
    error('verdict', 'invalid-verdict', `verdict must be one of ${STATUS_VERDICTS.join(', ')}`);
  }
  if (typeof report.planValid !== 'boolean') {
    error('planValid', 'required', 'planValid must be true or false: does the approved plan still hold?');
  }
  if (!STATUS_REASONS.includes(report.reason)) {
    error('reason', 'invalid-reason', `reason must be one of ${STATUS_REASONS.join(', ')} — a status is recorded at a material milestone, a blocker, or a request for a new decision`);
  }

  for (const field of ['changed', 'blocked', 'next']) {
    const value = report[field];
    if (value === undefined || value === null) continue;
    if (!isText(value)) error(field, 'invalid-type', `${field} must be a non-empty string or null`);
    else if (value.length > MAX_STATUS_TEXT) {
      error(field, 'too-long', `${field} is ${value.length} chars; keep it under ${MAX_STATUS_TEXT} so the status reads in seconds`);
    }
  }

  const completed = report.completed;
  if (completed !== undefined && completed !== null && !Array.isArray(completed)) {
    error('completed', 'invalid-type', 'completed must be an array of approach step ids');
  } else {
    const list = (completed ?? []).filter((id) => isText(id)).map((id) => id.trim());
    if ((completed ?? []).length > MAX_COMPLETED) {
      error('completed', 'too-many', `at most ${MAX_COMPLETED} completed steps (got ${completed.length})`);
    }
    // Only checked when the parent packet is in hand; an unknown approach is not an
    // empty one, so an offline report is never refused for a step it cannot verify.
    if (parent.approach) {
      for (const id of list) {
        if (!parent.approach.some((s) => s.id === id)) {
          error('completed', 'unknown-step', `this plan has no approach step "${id}"`);
        }
      }
    }
    if (report.verdict === 'on_plan' && report.reason === 'milestone' && list.length === 0) {
      error(
        'completed',
        'empty-milestone',
        'a milestone status names the approach steps it finished — pass --done <id>, or record a blocker or a decision request instead'
      );
    }
  }

  // The report's own logic. A status that contradicts itself is worse than none: a
  // reviewer skims the verdict and stops reading.
  if (report.verdict === 'on_plan' && report.planValid === false) {
    error('verdict', 'contradiction', 'a status cannot be on plan while the approved plan no longer holds — the verdict is "changed"');
  }
  if (report.verdict === 'changed' && !isText(report.changed)) {
    error('changed', 'required', 'a "changed" status says what departs from the approved plan — pass --changed "<what changed>"');
  }
  if (report.planValid === false && !isText(report.changed)) {
    error('changed', 'required', 'a status that says the approved plan no longer holds must say what no longer holds — pass --changed "<what changed>"');
  }
  if (report.verdict === 'blocked' && !isText(report.blocked)) {
    error('blocked', 'required', 'a "blocked" status says what stops the work — pass --blocked "<what is in the way>"');
  }
  if (report.verdict === 'blocked' && report.reason === 'milestone') {
    error('reason', 'invalid-reason', 'blocked work is a blocker or a request for a new decision, not a milestone');
  }

  // Not an error: an agent may report a blocker it is still working around. It is worth
  // saying, because the reviewer's next question is "what happens now?".
  if (report.verdict === 'blocked' && !isText(report.next) && report.reason !== 'decision') {
    warnings.push({ path: 'status.next', code: 'no-next', message: 'a blocked status usually says what would unblock it — pass --next "<what would unblock it>"' });
  }

  return { errors, warnings };
}

/**
 * The published copy of a report: the contract's fields, in the order a reader meets
 * them. Pure, so bundles diff cleanly.
 */
export function buildShareStatus(report) {
  const built = buildStatusReport(report);
  return {
    verdict: built.verdict,
    planValid: built.planValid === true,
    reason: built.reason,
    completed: built.completed,
    changed: built.changed,
    blocked: built.blocked,
    next: built.next,
  };
}

/** Human digest of a report — the verdict first, everything else under it. */
export function statusDigest(report, { indent = '  ' } = {}) {
  if (!isObject(report)) return '';
  const lines = [`${statusHeadline(report)} (${report.reason})`];
  if (report.completed?.length) lines.push(`${indent}done:     ${report.completed.join(', ')}`);
  if (report.changed) lines.push(`${indent}changed:  ${report.changed}`);
  if (report.blocked) lines.push(`${indent}blocked:  ${report.blocked}`);
  if (report.next) lines.push(`${indent}next:     ${report.next}`);
  return lines.join('\n');
}
