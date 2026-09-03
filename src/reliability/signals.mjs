// The CLI half of the reliability contract (roadmap R6.3).
//
// This is the twin of web/lib/planReliability.ts: the same eight failure points,
// the same outcome and reason vocabulary, the same targets, the same health
// verdict. The CLI cannot import the server's TypeScript, so the vocabulary is
// written twice and a test in each package fails when the two drift
// (test/reliability.test.mjs and web/lib/planReliability.test.ts).
//
// Pure and dependency-free: no filesystem, no clock, no network. The journal
// (journal.mjs) writes these; the report (report.mjs) reads them back.

/** The eight failure points of the plan lifecycle, in lifecycle order. */
export const RELIABILITY_OPERATIONS = [
  'record',
  'render',
  'publish',
  'decision',
  'authorization',
  'agent_read',
  'stale_plan',
  'evidence_link',
];

/** `retried` means it worked, but only because a retry or replay covered for a failure. */
export const RELIABILITY_OUTCOMES = ['ok', 'retried', 'failed'];

/** Why it failed, per operation. Closed: a free-text reason cannot be grouped. */
export const FAILURE_REASONS = {
  record: ['capture_failed', 'step_failed', 'browser_unavailable', 'timeout', 'interrupted'],
  render: ['render_failed', 'missing_input', 'timeout', 'out_of_memory', 'interrupted'],
  publish: ['network', 'timeout', 'http_5xx', 'http_4xx', 'auth', 'quota', 'upload_failed', 'incomplete'],
  decision: ['already_decided', 'stale_revision', 'unexpected_status', 'option_not_offered', 'key_reused', 'wrong_state'],
  authorization: ['unauthenticated', 'forbidden', 'not_found', 'wrong_state', 'illegal_transition', 'unknown_endpoint'],
  agent_read: ['network', 'timeout', 'http_5xx', 'http_4xx', 'not_found', 'unreadable'],
  stale_plan: ['source_moved', 'unknown'],
  evidence_link: ['missing', 'private', 'unpinned', 'unreachable'],
};

export const SEVERITIES = ['page', 'ticket', 'info'];

/** Per-reason severity overrides. Anything unnamed takes the operation default. */
const REASON_SEVERITY = {
  authorization: {
    unauthenticated: 'info',
    not_found: 'info',
    forbidden: 'ticket',
    wrong_state: 'ticket',
    illegal_transition: 'ticket',
    unknown_endpoint: 'page',
  },
  decision: { key_reused: 'page', already_decided: 'info', stale_revision: 'info', wrong_state: 'ticket' },
  agent_read: { not_found: 'ticket', http_4xx: 'ticket', unreadable: 'ticket' },
  evidence_link: { unpinned: 'info', private: 'info' },
  stale_plan: { source_moved: 'info', unknown: 'info' },
};

/**
 * The reliability targets. PROVISIONAL — R6.3 lists them as human taste, and
 * these are the recommended defaults. Keep them equal to RELIABILITY_TARGETS in
 * web/lib/planReliability.ts; both test suites check that they are.
 */
export const RELIABILITY_TARGETS = {
  record: {
    operation: 'record',
    objective: 0.95,
    margin: 0.05,
    minSamples: 5,
    window: 'rolling 20 attempts, or 7 days',
    severity: 'ticket',
    runbook: 'RB-record',
    meaning: 'A recording attempt reaches a usable take.',
  },
  render: {
    operation: 'render',
    objective: 0.98,
    margin: 0.03,
    minSamples: 5,
    window: 'rolling 20 attempts, or 7 days',
    severity: 'ticket',
    runbook: 'RB-render',
    meaning: 'A render of an already-captured take produces final.mp4.',
  },
  publish: {
    operation: 'publish',
    objective: 0.99,
    margin: 0.02,
    minSamples: 5,
    window: 'rolling 20 attempts, or 7 days',
    severity: 'page',
    runbook: 'RB-publish',
    meaning: 'A built spool becomes watchable at a link, with its plan opened.',
  },
  decision: {
    operation: 'decision',
    objective: 0.98,
    margin: 0.03,
    minSamples: 10,
    window: 'rolling 7 days',
    severity: 'ticket',
    runbook: 'RB-decision',
    meaning: "A reviewer's submitted decision is recorded rather than refused.",
  },
  authorization: {
    operation: 'authorization',
    objective: 0.9,
    margin: 0.1,
    minSamples: 20,
    window: 'rolling 7 days',
    severity: 'ticket',
    runbook: 'RB-authorization',
    meaning: 'A request to a plan endpoint is allowed. Anonymous denials are counted as info, not failures.',
  },
  agent_read: {
    operation: 'agent_read',
    objective: 0.99,
    margin: 0.02,
    minSamples: 10,
    window: 'rolling 7 days',
    severity: 'page',
    runbook: 'RB-agent-read',
    meaning: 'An agent asking for a decision gets the real status rather than a fallback.',
  },
  stale_plan: {
    operation: 'stale_plan',
    objective: 0.9,
    margin: 0.1,
    minSamples: 10,
    window: 'rolling 7 days',
    severity: 'ticket',
    runbook: 'RB-stale-plan',
    meaning: 'A plan still describes the revision the branch is on.',
  },
  evidence_link: {
    operation: 'evidence_link',
    objective: 0.99,
    margin: 0.02,
    minSamples: 10,
    window: 'rolling 7 days',
    severity: 'ticket',
    runbook: 'RB-evidence-link',
    meaning: 'An evidence descriptor a reader opens still resolves.',
  },
};

export const isOperation = (v) => RELIABILITY_OPERATIONS.includes(v);

export const isFailureReason = (operation, reason) =>
  isOperation(operation) && FAILURE_REASONS[operation].includes(reason);

/** The severity of one failure: the per-reason override, else the operation default. */
export function severityOf(operation, reason = null) {
  const override = reason ? REASON_SEVERITY[operation]?.[reason] : undefined;
  return override ?? RELIABILITY_TARGETS[operation].severity;
}

/**
 * Classify a thrown error into this operation's vocabulary.
 *
 * Best effort by design: an unrecognised failure is still a failure, and it is
 * recorded with the operation's own catch-all rather than with an invented
 * reason. The message never becomes the reason — it would leak paths and be
 * ungroupable.
 */
export function classify(operation, error) {
  const reasons = FAILURE_REASONS[operation] ?? [];
  const name = error?.name || '';
  const message = String(error?.message || error || '').toLowerCase();
  const status = Number(error?.status ?? error?.statusCode ?? 0);

  const pick = (...candidates) => candidates.find((r) => reasons.includes(r)) ?? reasons[0] ?? null;

  if (name === 'AbortError' || name === 'TimeoutError' || message.includes('timeout') || message.includes('timed out')) {
    return pick('timeout', 'network');
  }
  if (status >= 500) return pick('http_5xx', 'network');
  if (status === 401 || status === 403) return pick('auth', 'http_4xx');
  if (status === 402 || status === 429) return pick('quota', 'http_4xx');
  if (status >= 400) return pick('http_4xx', 'unreadable');
  if (message.includes('econnrefused') || message.includes('enotfound') || message.includes('fetch failed') || message.includes('unreachable')) {
    return pick('network');
  }
  if (message.includes('enoent') || message.includes('no such file') || message.includes('missing')) {
    return pick('missing_input', 'unreadable', 'missing');
  }
  if (name === 'SIGINT' || message.includes('sigint') || message.includes('interrupt')) return pick('interrupted');
  return pick(...reasons);
}

export const HEALTH_VERDICTS = ['met', 'at_risk', 'breached', 'unknown'];

/**
 * The verdict for one operation, from its counts. Same function as
 * `operationHealth` in web/lib/planReliability.ts, so the CLI report and the
 * hosted dashboard cannot disagree about whether a number is acceptable.
 */
export function operationHealth(operation, counts = {}) {
  const target = RELIABILITY_TARGETS[operation];
  const ok = Math.max(0, counts.ok ?? 0);
  const retried = Math.max(0, counts.retried ?? 0);
  const failed = Math.max(0, counts.failed ?? 0);
  const attempts = ok + retried + failed;
  const rate = attempts === 0 ? null : (ok + retried) / attempts;
  let verdict;
  if (attempts < target.minSamples) verdict = 'unknown';
  else if (rate >= target.objective) verdict = 'met';
  else if (rate >= target.objective - target.margin) verdict = 'at_risk';
  else verdict = 'breached';
  return { operation, verdict, rate, attempts, ok, retried, failed, target };
}

/** The worst verdict in a report. `unknown` never outranks a real one. */
export function worstVerdict(healths) {
  const rank = { met: 0, unknown: 1, at_risk: 2, breached: 3 };
  return healths.reduce((worst, h) => (rank[h.verdict] > rank[worst] ? h.verdict : worst), 'met');
}
