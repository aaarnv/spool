// Self-observation, read back (roadmap R6.2).
//
// R6.2 was written as "interview operators, deciders and reviewers separately". Aarnav
// chose a SOLO pilot (docs/SPL-DECISIONS.md, 2026-08-15), so this is the instrument that
// replaces the interview: the watch page measures what a session did with the video and
// asks three questions the moment a decision lands (web/lib/planObservations.ts), and
// this module reads those receipts out of the event log the pilot collector already
// fetches.
//
// Pure, like chain.mjs: every number here is a function of printed values, so a test
// pins it without a server and the synthesis cannot depend on when it ran.
//
// See CONTRACTS.md "Watch observation" and docs/PILOT-OBSERVATION.md.

/** The event type an observation is written as. Matches OBSERVATION_EVENT in web/. */
export const OBSERVATION_EVENT = 'plan_observation_recorded';

/** Which hat the watcher SAID they had on. One person, so a label, never a sample. */
export const PERSPECTIVES = ['operator', 'decider', 'reviewer'];

/** Did the video change the decision, or only how the plan was presented? */
export const NOTE_EFFECTS = ['quality', 'presentation', 'neither'];

export const REQUIRE_ANSWERS = ['yes', 'no', 'unsure'];

const list = (v) => (Array.isArray(v) ? v : []);
const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const numberOr = (v, fallback = null) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/**
 * One observation row, flattened.
 *
 * The stored payload nests trace, decision and note; a row is the shape a metric reads,
 * so every field a metric needs is one lookup and a missing one is explicitly null
 * rather than an exception three levels down.
 */
function toRow(event, taskKey) {
  const p = event?.payload ?? {};
  const trace = p.trace ?? {};
  const decision = p.decision ?? null;
  const note = p.note ?? null;
  const chapters = list(trace.chapters);

  return {
    taskKey: taskKey ?? null,
    revisionId: event?.revisionId ?? null,
    at: text(event?.at),
    actorType: event?.actorType ?? null,

    videoMs: numberOr(trace.videoMs, 0),
    watchedMs: numberOr(trace.watchedMs, 0),
    watchedRatio: numberOr(trace.watchedRatio),
    reachedEnd: trace.reachedEnd === true,
    sinceFirstPlayMs: numberOr(trace.sinceFirstPlayMs),
    chapters: chapters.map((c) => ({
      id: c?.id ?? null,
      coverage: numberOr(c?.coverage, 0),
      rewatchedRatio: numberOr(c?.rewatchedRatio, 0),
      skipped: c?.skipped === true,
      rewatched: c?.rewatched === true,
    })),
    skipped: chapters.filter((c) => c?.skipped === true).map((c) => c.id),
    rewatched: chapters.filter((c) => c?.rewatched === true).map((c) => c.id),

    decisionAction: decision?.action ?? null,
    decidedBeforeEnd: decision ? decision.beforeEnd === true : null,
    decidedAtVideoMs: decision ? numberOr(decision.atVideoMs, 0) : null,
    // The session clock: first frame played to decision. The chain's own
    // `timeToFirstDecisionMs` measures publication to decision, which is a different
    // question — how long the plan waited, not how long the reviewer took.
    sessionToDecisionMs: decision ? numberOr(decision.sinceFirstPlayMs) : null,

    // A row with no note is a session that was measured and not asked. That is a
    // different fact from a note whose answers are empty, so it stays null.
    note: note
      ? {
          perspective: PERSPECTIVES.includes(note.perspective) ? note.perspective : null,
          effect: NOTE_EFFECTS.includes(note.effect) ? note.effect : null,
          wouldRequire: REQUIRE_ANSWERS.includes(note.wouldRequire) ? note.wouldRequire : null,
          faster: text(note.faster),
          distrust: text(note.distrust),
          stillNeeded: text(note.stillNeeded),
        }
      : null,
  };
}

/**
 * The observations of one plan, newest last, one per revision.
 *
 * Two receipts per session are normal: the trace posts when the decision lands so it
 * survives a closed tab, and the note posts if it is answered. Both are honest history,
 * but a metric that counted them twice would double every session that got a note. So
 * one row per revision wins, and the one with a note beats the one without.
 */
export function observationsOf(events, taskKey = null) {
  const rows = list(events)
    .filter((e) => e?.type === OBSERVATION_EVENT)
    .map((e) => toRow(e, taskKey));

  const best = new Map();
  for (const row of rows) {
    const key = row.revisionId ?? '-';
    const held = best.get(key);
    // A receipt with a note beats one without; otherwise the later receipt wins.
    if (held && held.note && !row.note) continue;
    best.set(key, row);
  }
  return [...best.values()];
}

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
};

/**
 * What the observations say, across every chain.
 *
 * Every rate names its own denominator, for the reason chain.mjs gives: "half skipped
 * the risks chapter" is a different claim over sessions than over sessions that got as
 * far as a decision, and only the stated one can be checked.
 */
export function observationSummary(rows = []) {
  const observations = list(rows);
  const decided = observations.filter((o) => o.decisionAction);
  const notes = observations.filter((o) => o.note);
  const chapters = new Map();

  for (const o of observations) {
    for (const c of o.chapters) {
      if (!c.id) continue;
      const held = chapters.get(c.id) ?? { id: c.id, seen: 0, skipped: 0, rewatched: 0 };
      held.seen += 1;
      if (c.skipped) held.skipped += 1;
      if (c.rewatched) held.rewatched += 1;
      chapters.set(c.id, held);
    }
  }

  const tally = (rowsIn, pick, values) => {
    const out = {};
    for (const value of values) out[value] = rowsIn.filter((r) => pick(r) === value).length;
    return out;
  };

  return {
    observations: observations.length,
    chains: new Set(observations.map((o) => o.taskKey).filter(Boolean)).size,
    withDecision: decided.length,
    withNote: notes.length,

    // The headline of the trace: how often the reviewer had decided before the video
    // was over. It is the closest thing the pilot has to "was the rest of it needed?".
    decidedBeforeEnd: decided.filter((o) => o.decidedBeforeEnd === true).length,
    decidedBeforeEndRate: rate(decided.filter((o) => o.decidedBeforeEnd === true).length, decided.length),
    medianSessionToDecisionMs: median(decided.map((o) => o.sessionToDecisionMs).filter((v) => typeof v === 'number')),
    medianWatchedRatio: median(observations.map((o) => o.watchedRatio).filter((v) => typeof v === 'number')),

    chapters: [...chapters.values()].map((c) => ({
      ...c,
      skipRate: rate(c.skipped, c.seen),
      rewatchRate: rate(c.rewatched, c.seen),
    })),

    // The distinction R6.2 refuses to blur: a video that changes the DECISION is a
    // different product from one that changes the PRESENTATION of the same decision.
    effect: tally(notes, (r) => r.note.effect, NOTE_EFFECTS),
    wouldRequire: tally(notes, (r) => r.note.wouldRequire, REQUIRE_ANSWERS),
    perspective: tally(notes, (r) => r.note.perspective, PERSPECTIVES),
    distrustNamed: notes.filter((r) => r.note.distrust).length,
    stillNeededNamed: notes.filter((r) => r.note.stillNeeded).length,
  };
}

/** Every non-empty answer to one note field, with the chain it came from. */
export function quotes(rows = [], field) {
  return list(rows)
    .filter((o) => o.note && o.note[field])
    .map((o) => ({ taskKey: o.taskKey, revisionId: o.revisionId, at: o.at, text: o.note[field] }));
}
