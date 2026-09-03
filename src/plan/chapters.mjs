// The join between a plan packet and its recording.
//
// `plan.json` names chapters by stable ID (`context`, `outcome`, `approach`,
// `risks`, `decision`). `timeline.json` stays the recording-clock source of
// truth and carries `chapterId` as an additive field on a step record. Nothing
// stores a chapter's time range: it is derived from the steps that carry the
// ID, so the packet and the video can never drift.
//
// See CONTRACTS.md "timeline.json" and "Plan Spools" → "Chapter mapping".

import { CHAPTER_IDS } from './schema.mjs';

export { CHAPTER_IDS };

/** True for a chapter ID a plan packet is allowed to declare. */
export function isChapterId(value) {
  return typeof value === 'string' && CHAPTER_IDS.includes(value);
}

/** The chapter a step belongs to, or null when it names none. */
export function chapterIdOf(step) {
  return isChapterId(step?.chapterId) ? step.chapterId : null;
}

/**
 * The additive `chapterId` field for a step record, spread into the record by
 * every writer. An unmapped step spreads nothing, so a non-plan timeline keeps
 * the exact shape it had before Plan Spools existed.
 */
export function chapterField(step) {
  const id = chapterIdOf(step);
  return id ? { chapterId: id } : {};
}

/**
 * Time range per chapter, derived from step records on ONE clock (recording for
 * timeline.json steps, output for share/spool.json steps — never mixed).
 * Returns [{ id, start, end, steps }] ordered by start; steps with no chapter,
 * and every step of an old timeline, are simply absent.
 *
 * A chapter recorded as several steps spans from the first step's start to the
 * last step's end, so a seek lands on the chapter's first frame either way.
 */
export function chapterRanges(steps) {
  const byId = new Map();
  (steps || []).forEach((s, idx) => {
    const id = chapterIdOf(s);
    if (!id || typeof s.start !== 'number' || typeof s.end !== 'number') return;
    const i = typeof s.i === 'number' ? s.i : idx;
    const cur = byId.get(id);
    if (!cur) byId.set(id, { id, start: s.start, end: s.end, steps: [i] });
    else {
      cur.start = Math.min(cur.start, s.start);
      cur.end = Math.max(cur.end, s.end);
      cur.steps.push(i);
    }
  });
  return [...byId.values()].sort((a, b) => a.start - b.start);
}
