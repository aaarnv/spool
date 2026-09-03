// One pilot chain, and the numbers a chain answers (roadmap R6.1).
//
// A chain is plan → decision → proof for ONE task. Every fact in it already exists:
// the read payload (CONTRACTS.md "Agent read payload"), the append-only event log
// (`GET /api/plans/{id}/events`) and the revision lineage. This module invents no
// event and writes nothing — it JOINS what the product already records into the row
// the pilot measures, so instrumenting the pilot cannot change what the pilot measures.
//
// Pure on purpose, like schema.mjs: the reads live in collect.mjs, so every number
// here is a function of printed values and a test can pin it without a server.
//
// See CONTRACTS.md "Pilot dataset".

import { observationSummary, observationsOf } from './observe.mjs';

/** Bumped only for a breaking change; new fields are additive. */
export const DATASET_VERSION = 1;

/** The north-star window (R0.3): an approved plan that reaches a proof inside it. */
export const CLOSE_WITHIN_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * What a chain came to. Deliberately three words, not the seven lifecycle states:
 * the pilot asks "did this reach a decision and then an end?", and the state is
 * carried beside it for anyone who wants the detail.
 *
 * `stopped` is the one an agent cannot derive. The lifecycle has no abandoned state —
 * a redirected plan is a plan somebody may still revise — so an explicit stop is
 * declared in the roster by the person who stopped it (see scenarios.mjs).
 */
export const CHAIN_OUTCOMES = ['proved', 'stopped', 'open'];

const ms = (iso) => {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? t : null;
};
const iso = (v) => (typeof v === 'string' && v.trim() ? v : null);
const list = (v) => (Array.isArray(v) ? v : []);

/** Events of one type, oldest first. An absent log reads as no events, never as zero. */
const of = (events, type) => list(events).filter((e) => e?.type === type);

/**
 * When each revision became readable. The lineage is authoritative (it carries every
 * revision's `createdAt`); the event log is the fallback for a reader without it.
 */
function publishTimes(events, revisions) {
  const at = new Map();
  for (const r of list(revisions)) {
    if (r?.revisionId && iso(r.createdAt)) at.set(r.revisionId, r.createdAt);
  }
  for (const e of list(events)) {
    if (e.type !== 'plan_published' && e.type !== 'plan_revision_created') continue;
    if (e.revisionId && !at.has(e.revisionId)) at.set(e.revisionId, iso(e.at));
  }
  return at;
}

/**
 * The decisions somebody recorded, oldest first.
 *
 * `sincePublishMs` is time-to-decision for THAT revision: the reviewer met revision N
 * when it published, so a redirect on revision 1 and an approval on revision 2 are two
 * measurements, not one long wait. Null when the revision's publish time is unknown.
 */
function decisions(events, at, payload) {
  const rows = of(events, 'plan_decision_submitted').map((e) => ({
    revisionId: e.revisionId ?? null,
    action: e.payload?.action ?? null,
    type: e.payload?.type ?? null,
    optionId: e.payload?.optionId ?? null,
    at: iso(e.at),
    sincePublishMs: span(at.get(e.revisionId), e.at),
  }));
  if (rows.length) return rows;

  // No event log (an anonymous read, or an offline one). The payload still carries the
  // decision on the CURRENT revision, which is one row rather than the history.
  const d = payload?.decision;
  if (!d?.at) return [];
  return [
    {
      revisionId: payload.revisionId ?? null,
      action: d.action ?? null,
      type: d.type ?? d.action ?? null,
      optionId: d.optionId ?? null,
      at: iso(d.at),
      sincePublishMs: span(at.get(payload.revisionId), d.at),
    },
  ];
}

const span = (from, to) => {
  const a = ms(from);
  const b = ms(to);
  return a !== null && b !== null && b >= a ? b - a : null;
};

/**
 * The proofs on this plan. `proof_published` is the funnel's own receipt (R0.3 event
 * 11) and carries both the block and the time, so it is preferred; the read payload is
 * the fallback and has no clock, which is why an unlinked proof reports `at: null`
 * instead of a guessed date.
 */
function proofs(events, payload) {
  const fromEvents = of(events, 'proof_published').map((e) => ({
    spoolId: e.payload?.spoolId ?? null,
    revisionId: e.revisionId ?? null,
    at: iso(e.at),
    mode: e.payload?.proof?.mode ?? 'video',
    outcome: e.payload?.proof?.outcome?.status ?? null,
    deviations: list(e.payload?.proof?.deviations).length,
    proved: e.payload?.proved === true,
  }));
  if (fromEvents.length) return fromEvents;

  return list(payload?.proofs).map((p) => ({
    spoolId: p.spoolId ?? null,
    revisionId: null,
    at: null,
    mode: p.proof?.mode ?? null,
    outcome: p.proof?.outcome?.status ?? null,
    deviations: list(p.deviations).length,
    proved: p.current === true,
  }));
}

/** Where the approved work went, when an agent said so (R4.3 gate, R5.4 status). */
function implementation(events, payload) {
  const started = [...of(events, 'implementation_started'), ...of(events, 'implementation_bypassed')].sort(
    (a, b) => (ms(a.at) ?? 0) - (ms(b.at) ?? 0)
  )[0];
  const report = payload?.implementation ?? null;
  if (!started && !report) return null;
  return {
    startedAt: started ? iso(started.at) : null,
    bypassed: started ? started.type === 'implementation_bypassed' : null,
    policy: started?.payload?.policy ?? null,
    // The latest status spool's verdict, when the agent recorded one (R5.4).
    verdict: report?.verdict ?? null,
    planValid: typeof report?.planValid === 'boolean' ? report.planValid : null,
  };
}

/**
 * Join one roster entry with what the host knows about its plan.
 *
 * `payload` is the agent read payload (hosted or the offline bundle), `events` the
 * append-only log when the reader may see it, `revisions` the lineage. Every one of
 * them may be null: a chain with a packet and nothing else is still a row, it just
 * carries fewer numbers and says so in `notes`.
 */
export function chainRecord({
  entry = {},
  payload = null,
  events = null,
  revisions = null,
  closeWithinDays = CLOSE_WITHIN_DAYS,
} = {}) {
  const notes = [];
  if (!payload) notes.push('no plan read: this chain has a roster entry and nothing published yet');
  if (payload && !events) notes.push('no event log: timings come from the read payload, so only the current revision is timed');

  const at = publishTimes(events, revisions);
  const decided = decisions(events, at, payload);
  const proofRows = proofs(events, payload);
  const revisionRows = list(revisions);
  // A packet nobody published has no revisions: revision 1 exists only once the server
  // opened it. Counting a draft as one revision would put an unpublished plan into the
  // rework denominator and report a publish date of null beside a count of 1.
  const published = !!(payload?.spoolId && payload.status !== 'draft');
  const revisionCount = revisionRows.length || payload?.revision || (published ? 1 : 0);

  const publishedAt =
    (revisionRows.find((r) => r.revision === 1)?.createdAt ?? null) ||
    (of(events, 'plan_published')[0]?.at ?? null) ||
    null;

  const firstDecision = decided[0] ?? null;
  const approval = decided.find((d) => d.action === 'approve') ?? null;
  const redirects = decided.filter((d) => d.action === 'redirect' || d.action === 'needs_input').length;

  // The proof that closed the loop, else the newest one recorded.
  const proof = proofRows.find((p) => p.proved) ?? proofRows[proofRows.length - 1] ?? null;
  // The north star measures from the APPROVAL, not from publication: the clock a team
  // cares about starts when somebody said yes.
  const closeMs = approval && proof ? span(approval.at, proof.at) : null;

  // What the watcher's own session did with the video, and what they said about it
  // straight afterwards (roadmap R6.2). Read out of the same event log as everything
  // else here, so a chain either carries its observations or plainly has none.
  const observed = observationsOf(events, entry.taskKey ?? null);

  const stop = entry.stop ?? null;
  const outcome = stop ? 'stopped' : proof ? 'proved' : 'open';

  return {
    taskKey: entry.taskKey ?? payload?.links?.task ?? null,
    scenario: entry.scenario ?? null,
    title: entry.title ?? payload?.goal ?? null,
    spoolId: payload?.spoolId ?? entry.spoolId ?? null,
    dir: entry.dir ?? null,
    watch: payload?.links?.watch ?? null,
    status: payload?.status ?? null,
    outcome,
    stopReason: stop?.reason ?? null,
    stoppedAt: stop ? iso(stop.at) : null,

    publishedAt,
    revisions: revisionCount,
    // Rework is revisions beyond the first: a plan re-argued because a reviewer sent it
    // back. It is the pilot's rework measure, and it is a count, never an opinion.
    rework: Math.max(0, revisionCount - 1),
    redirects,
    questions: of(events, 'plan_question_created').length,

    decisions: decided,
    firstDecisionAt: firstDecision?.at ?? null,
    // Time-to-decision, the headline number: publication of revision 1 to the first
    // decision anybody recorded on this plan.
    timeToFirstDecisionMs: span(publishedAt, firstDecision?.at),
    decision: decided[decided.length - 1] ?? null,
    approvedAt: approval?.at ?? null,

    observations: observed,
    // The session clock beside the chain clock: how long the reviewer took once the
    // video started, as opposed to how long the plan waited to be looked at.
    sessionToDecisionMs: observed.find((o) => typeof o.sessionToDecisionMs === 'number')?.sessionToDecisionMs ?? null,
    decidedBeforeEnd: observed.find((o) => o.decidedBeforeEnd !== null)?.decidedBeforeEnd ?? null,

    implementation: implementation(events, payload),
    proofs: proofRows,
    proof,
    proofAt: proof?.at ?? null,
    deviations: proof ? proof.deviations : null,
    timeToProofMs: closeMs,
    // The north-star test for this chain: approved, proved, and inside the window.
    closedInWindow: closeMs === null ? null : closeMs <= closeWithinDays * DAY_MS,

    notes,
  };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

const quantile = (xs, q) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/**
 * The dashboard, as numbers.
 *
 * Every rate names its denominator in its own key, because a proof rate over "every
 * chain" and a proof rate over "every approved chain" are different claims and the
 * second is the only honest one.
 */
export function summarize(chains, { closeWithinDays = CLOSE_WITHIN_DAYS } = {}) {
  const rows = list(chains);
  const published = rows.filter((c) => c.publishedAt || c.spoolId);
  const decided = rows.filter((c) => c.firstDecisionAt);
  const approved = rows.filter((c) => c.approvedAt);
  const times = decided.map((c) => c.timeToFirstDecisionMs).filter((v) => typeof v === 'number');
  const closed = approved.filter((c) => c.closedInWindow === true);

  const by = (key) => {
    const out = {};
    for (const c of rows) {
      const k = c[key] ?? 'unassigned';
      out[k] = (out[k] ?? 0) + 1;
    }
    return out;
  };

  return {
    chains: rows.length,
    published: published.length,
    decided: decided.length,
    approved: approved.length,
    proved: rows.filter((c) => c.outcome === 'proved').length,
    stopped: rows.filter((c) => c.outcome === 'stopped').length,
    open: rows.filter((c) => c.outcome === 'open').length,
    byScenario: by('scenario'),
    byStatus: by('status'),

    timeToDecisionMs: {
      n: times.length,
      median: median(times),
      p90: quantile(times, 0.9),
      min: times.length ? Math.min(...times) : null,
      max: times.length ? Math.max(...times) : null,
    },

    // Rework: how often a decision sent a plan back, and how many revisions it cost.
    reworkChains: decided.filter((c) => c.rework > 0).length,
    reworkRate: rate(decided.filter((c) => c.rework > 0).length, decided.length),
    revisionsTotal: rows.reduce((n, c) => n + c.rework, 0),
    redirectRate: rate(decided.filter((c) => c.redirects > 0).length, decided.length),

    proofRate: rate(approved.filter((c) => c.proof).length, approved.length),
    deviationsStated: rows.reduce((n, c) => n + (c.deviations ?? 0), 0),
    chainsStatingDeviations: rows.filter((c) => (c.deviations ?? 0) > 0).length,
    bypassed: rows.filter((c) => c.implementation?.bypassed === true).length,

    // R6.2 self-observation: what the watching sessions themselves recorded. Reported
    // beside the lifecycle numbers rather than in place of them — a chain is a fact
    // about the product, an observation is a fact about one person using it.
    observation: observationSummary(rows.flatMap((c) => c.observations ?? [])),

    // The north star (R0.3): approved plans that reached a linked proof in the window.
    northStar: {
      window: `${closeWithinDays}d`,
      approved: approved.length,
      closedInWindow: closed.length,
      rate: rate(closed.length, approved.length),
    },
  };
}
