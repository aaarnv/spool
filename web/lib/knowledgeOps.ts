// Project knowledge store + ops (see PR-GUIDE-CONTRACT.md §Project knowledge).
// Mirrors editOps.ts: pure types, caps, tolerant parse, one-line validation, and
// a pure apply that never mutates its input. Agents author ops; the server stamps
// provenance (pr + date) so guides never write pr/date themselves.

// A provenance-stamped text entry. pr/updatedAt are server-written.
export type KnowledgeEntry = { text: string; pr: number; updatedAt: string };

// An append-only decision record. pr/date are server-written.
export type Decision = { what: string; why: string; pr: number; date: string };

export type KnowledgeStore = {
  version: number;
  overview: KnowledgeEntry | null;
  subsystems: Record<string, KnowledgeEntry>;
  vocabulary: Record<string, KnowledgeEntry>;
  recording: Record<string, KnowledgeEntry>;
  decisions: Decision[];
};

export type KnowledgeOp =
  | { op: "set_overview"; text: string }
  | { op: "set_subsystem"; name: string; text: string }
  | { op: "remove_subsystem"; name: string }
  | { op: "set_term"; term: string; text: string }
  | { op: "remove_term"; term: string }
  | { op: "set_recording"; topic: string; text: string }
  | { op: "remove_recording"; topic: string }
  | { op: "add_decision"; what: string; why: string };

export const OVERVIEW_MAX = 500;
export const SUBSYSTEMS_MAX = 40;
export const SUBSYSTEM_NAME_MAX = 80;
export const SUBSYSTEM_TEXT_MAX = 1000;
export const TERMS_MAX = 60;
export const TERM_MAX = 60;
export const TERM_TEXT_MAX = 500;
export const RECORDING_MAX = 20;
export const RECORDING_TOPIC_MAX = 80;
export const RECORDING_TEXT_MAX = 1000;
export const DECISION_WHAT_MAX = 300;
export const DECISION_WHY_MAX = 500;
export const DECISIONS_MAX = 50;
export const OPS_MAX = 20;

export const STORE_VERSION = 1;

export function emptyStore(): KnowledgeStore {
  return { version: STORE_VERSION, overview: null, subsystems: {}, vocabulary: {}, recording: {}, decisions: [] };
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

// Coerce an unknown value into a KnowledgeEntry, dropping anything malformed.
function normEntry(v: unknown): KnowledgeEntry | null {
  if (!v || typeof v !== "object") return null;
  const e = v as { text?: unknown; pr?: unknown; updatedAt?: unknown };
  if (!isStr(e.text)) return null;
  return { text: e.text, pr: isInt(e.pr) ? e.pr : 0, updatedAt: isStr(e.updatedAt) ? e.updatedAt : "" };
}

function normEntries(v: unknown): Record<string, KnowledgeEntry> {
  const out: Record<string, KnowledgeEntry> = {};
  if (v && typeof v === "object") {
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      const e = normEntry(raw);
      if (e) out[k] = e;
    }
  }
  return out;
}

// Tolerant parse of a stored knowledge.json. Any malformation collapses the
// affected field to its empty shape rather than throwing, so a corrupt store
// degrades to empty instead of breaking publish or ask.
export function parseStore(raw: string | null): KnowledgeStore {
  if (!raw) return emptyStore();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (!obj || typeof obj !== "object") return emptyStore();
  const o = obj as Record<string, unknown>;
  const decisions: Decision[] = Array.isArray(o.decisions)
    ? o.decisions.flatMap((d) => {
        if (!d || typeof d !== "object") return [];
        const r = d as { what?: unknown; why?: unknown; pr?: unknown; date?: unknown };
        if (!isStr(r.what) || !isStr(r.why)) return [];
        return [{ what: r.what, why: r.why, pr: isInt(r.pr) ? r.pr : 0, date: isStr(r.date) ? r.date : "" }];
      })
    : [];
  return {
    version: isInt(o.version) ? o.version : STORE_VERSION,
    overview: normEntry(o.overview),
    subsystems: normEntries(o.subsystems),
    vocabulary: normEntries(o.vocabulary),
    recording: normEntries(o.recording),
    decisions,
  };
}

// Validate a raw ops array (agent-authored, no provenance). Returns typed ops or
// a one-line error reason, mirroring validateOps in editOps.ts.
export function validateKnowledgeOps(
  raw: unknown
): { ok: true; ops: KnowledgeOp[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "at least one op required" };
  if (raw.length > OPS_MAX) return { ok: false, error: `too many ops (max ${OPS_MAX})` };
  const out: KnowledgeOp[] = [];

  // A required, trimmed, non-empty string within a cap.
  const str = (
    v: unknown,
    max: number,
    idx: number,
    field: string
  ): { ok: true; value: string } | { ok: false; error: string } => {
    if (!isStr(v) || v.trim().length === 0) return { ok: false, error: `op ${idx}: ${field} required` };
    if (v.length > max) return { ok: false, error: `op ${idx}: ${field} exceeds ${max} chars` };
    return { ok: true, value: v };
  };

  for (const [idx, r] of raw.entries()) {
    if (!r || typeof r !== "object") return { ok: false, error: `op ${idx}: not an object` };
    const op = (r as { op?: unknown }).op;
    switch (op) {
      case "set_overview": {
        const text = str((r as { text?: unknown }).text, OVERVIEW_MAX, idx, "text");
        if (!text.ok) return text;
        out.push({ op, text: text.value });
        break;
      }
      case "set_subsystem": {
        const name = str((r as { name?: unknown }).name, SUBSYSTEM_NAME_MAX, idx, "name");
        if (!name.ok) return name;
        const text = str((r as { text?: unknown }).text, SUBSYSTEM_TEXT_MAX, idx, "text");
        if (!text.ok) return text;
        out.push({ op, name: name.value, text: text.value });
        break;
      }
      case "remove_subsystem": {
        const name = str((r as { name?: unknown }).name, SUBSYSTEM_NAME_MAX, idx, "name");
        if (!name.ok) return name;
        out.push({ op, name: name.value });
        break;
      }
      case "set_term": {
        const term = str((r as { term?: unknown }).term, TERM_MAX, idx, "term");
        if (!term.ok) return term;
        const text = str((r as { text?: unknown }).text, TERM_TEXT_MAX, idx, "text");
        if (!text.ok) return text;
        out.push({ op, term: term.value, text: text.value });
        break;
      }
      case "remove_term": {
        const term = str((r as { term?: unknown }).term, TERM_MAX, idx, "term");
        if (!term.ok) return term;
        out.push({ op, term: term.value });
        break;
      }
      case "set_recording": {
        const topic = str((r as { topic?: unknown }).topic, RECORDING_TOPIC_MAX, idx, "topic");
        if (!topic.ok) return topic;
        const text = str((r as { text?: unknown }).text, RECORDING_TEXT_MAX, idx, "text");
        if (!text.ok) return text;
        out.push({ op, topic: topic.value, text: text.value });
        break;
      }
      case "remove_recording": {
        const topic = str((r as { topic?: unknown }).topic, RECORDING_TOPIC_MAX, idx, "topic");
        if (!topic.ok) return topic;
        out.push({ op, topic: topic.value });
        break;
      }
      case "add_decision": {
        const what = str((r as { what?: unknown }).what, DECISION_WHAT_MAX, idx, "what");
        if (!what.ok) return what;
        const why = str((r as { why?: unknown }).why, DECISION_WHY_MAX, idx, "why");
        if (!why.ok) return why;
        out.push({ op, what: what.value, why: why.value });
        break;
      }
      default:
        return { ok: false, error: `op ${idx}: unknown op "${String(op)}"` };
    }
  }
  return { ok: true, ops: out };
}

// Apply validated ops to a store, returning a NEW store (input untouched).
// New keys past a section cap are skipped "cap"; existing-key updates always
// apply. Removes of missing keys are skipped "missing". Decisions truncate to
// the last DECISIONS_MAX. Publish never fails on a cap or missing key.
export function applyKnowledgeOps(
  store: KnowledgeStore,
  ops: KnowledgeOp[],
  prov: { pr: number; date: string }
): { store: KnowledgeStore; applied: number; skipped: { op: string; reason: string }[] } {
  const next: KnowledgeStore = {
    version: STORE_VERSION,
    overview: store.overview ? { ...store.overview } : null,
    subsystems: { ...store.subsystems },
    vocabulary: { ...store.vocabulary },
    recording: { ...store.recording },
    decisions: [...store.decisions],
  };
  const entry = (text: string): KnowledgeEntry => ({ text, pr: prov.pr, updatedAt: prov.date });
  const skipped: { op: string; reason: string }[] = [];
  let applied = 0;

  const setKeyed = (
    map: Record<string, KnowledgeEntry>,
    key: string,
    text: string,
    cap: number,
    op: string
  ) => {
    if (!(key in map) && Object.keys(map).length >= cap) {
      skipped.push({ op, reason: "cap" });
      return;
    }
    map[key] = entry(text);
    applied++;
  };
  const removeKeyed = (map: Record<string, KnowledgeEntry>, key: string, op: string) => {
    if (!(key in map)) {
      skipped.push({ op, reason: "missing" });
      return;
    }
    delete map[key];
    applied++;
  };

  for (const o of ops) {
    switch (o.op) {
      case "set_overview":
        next.overview = entry(o.text);
        applied++;
        break;
      case "set_subsystem":
        setKeyed(next.subsystems, o.name, o.text, SUBSYSTEMS_MAX, o.op);
        break;
      case "remove_subsystem":
        removeKeyed(next.subsystems, o.name, o.op);
        break;
      case "set_term":
        setKeyed(next.vocabulary, o.term, o.text, TERMS_MAX, o.op);
        break;
      case "remove_term":
        removeKeyed(next.vocabulary, o.term, o.op);
        break;
      case "set_recording":
        setKeyed(next.recording, o.topic, o.text, RECORDING_MAX, o.op);
        break;
      case "remove_recording":
        removeKeyed(next.recording, o.topic, o.op);
        break;
      case "add_decision":
        next.decisions.push({ what: o.what, why: o.why, pr: prov.pr, date: prov.date });
        applied++;
        break;
    }
  }
  if (next.decisions.length > DECISIONS_MAX) next.decisions = next.decisions.slice(-DECISIONS_MAX);
  return { store: next, applied, skipped };
}
