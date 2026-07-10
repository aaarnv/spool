// The entire edit vocabulary (EDIT-CONTRACT.md §Ops JSON). Indices refer to the
// CURRENT step order at job creation; ops apply sequentially in array order.
export type Zoom = "none" | "auto" | { x: number; y: number };

export type Op =
  | { op: "remove_step"; i: number }
  | { op: "reorder"; order: number[] }
  | { op: "set_narration"; i: number; text: string }
  | { op: "set_title"; title: string }
  | { op: "set_zoom"; i: number; zoom: Zoom }
  | { op: "set_rate"; rate: number }
  | { op: "set_bg"; bg: BgPreset };

export const NARRATION_MAX = 600;
export const RATE_MIN = 0.75;
export const RATE_MAX = 2;

// Background presets — mirrors src/render/bg-presets.mjs BG_PRESET_NAMES (keep in
// sync). Only these repo presets are editable from the web (the render worker ships
// them); macOS wallpapers and custom image paths are CLI-only (the Linux worker
// can't resolve them, and the original canvas is preserved via src/bg.jpg).
export const BG_PRESETS = ["graphite", "paper", "indigo"] as const;
export type BgPreset = (typeof BG_PRESETS)[number];

// JSON schema handed to Claude to force structured output against the vocabulary.
export const OPS_TOOL_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ops: {
      type: "array",
      description: "The edit operations to apply, in order.",
      items: {
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["remove_step", "reorder", "set_narration", "set_title", "set_zoom", "set_rate", "set_bg"],
          },
          i: { type: "integer", description: "Step index (0-based) for remove_step/set_narration/set_zoom." },
          order: { type: "array", items: { type: "integer" }, description: "Permutation of step indices for reorder." },
          text: { type: "string", description: "New narration for set_narration (<= 600 chars)." },
          title: { type: "string", description: "New spool title for set_title." },
          zoom: { description: 'For set_zoom: "none", "auto", or {x, y}.' },
          rate: { type: "number", description: "Playback rate for set_rate (0.75-2)." },
          bg: { type: "string", enum: [...BG_PRESETS], description: "Background preset for set_bg." },
        },
        required: ["op"],
      },
    },
    summary: {
      type: "array",
      items: { type: "string" },
      description: "One short human-readable sentence per op, in the same order.",
    },
  },
  required: ["ops", "summary"],
} as const;

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

// Validate a raw ops array against the contract's rules for a spool with
// `stepCount` steps. Returns typed ops or a one-line error reason.
export function validateOps(
  raw: unknown,
  stepCount: number
): { ok: true; ops: Op[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: "at least one op required" };
  const out: Op[] = [];
  const inRange = (i: unknown) => isInt(i) && i >= 0 && i < stepCount;

  for (const [idx, r] of raw.entries()) {
    if (!r || typeof r !== "object") return { ok: false, error: `op ${idx}: not an object` };
    const op = (r as { op?: unknown }).op;
    switch (op) {
      case "remove_step": {
        const { i } = r as { i?: unknown };
        if (!inRange(i)) return { ok: false, error: `op ${idx}: step index out of range` };
        out.push({ op, i: i as number });
        break;
      }
      case "reorder": {
        const order = (r as { order?: unknown }).order;
        if (!Array.isArray(order) || order.length !== stepCount)
          return { ok: false, error: `op ${idx}: order must be a permutation of ${stepCount} indices` };
        const seen = new Set<number>();
        for (const v of order) {
          if (!inRange(v) || seen.has(v)) return { ok: false, error: `op ${idx}: order is not a permutation` };
          seen.add(v);
        }
        out.push({ op, order: order as number[] });
        break;
      }
      case "set_narration": {
        const { i, text } = r as { i?: unknown; text?: unknown };
        if (!inRange(i)) return { ok: false, error: `op ${idx}: step index out of range` };
        if (typeof text !== "string" || text.length === 0)
          return { ok: false, error: `op ${idx}: narration text required` };
        if (text.length > NARRATION_MAX)
          return { ok: false, error: `op ${idx}: narration exceeds ${NARRATION_MAX} chars` };
        out.push({ op, i: i as number, text });
        break;
      }
      case "set_title": {
        const title = (r as { title?: unknown }).title;
        if (typeof title !== "string") return { ok: false, error: `op ${idx}: title must be a string` };
        out.push({ op, title });
        break;
      }
      case "set_zoom": {
        const { i, zoom } = r as { i?: unknown; zoom?: unknown };
        if (!inRange(i)) return { ok: false, error: `op ${idx}: step index out of range` };
        let z: Zoom;
        if (zoom === "none" || zoom === "auto") z = zoom;
        else if (
          zoom &&
          typeof zoom === "object" &&
          typeof (zoom as { x?: unknown }).x === "number" &&
          typeof (zoom as { y?: unknown }).y === "number"
        )
          z = { x: (zoom as { x: number }).x, y: (zoom as { y: number }).y };
        else return { ok: false, error: `op ${idx}: zoom must be "none", "auto", or {x,y}` };
        out.push({ op, i: i as number, zoom: z });
        break;
      }
      case "set_rate": {
        const rate = (r as { rate?: unknown }).rate;
        if (typeof rate !== "number" || rate < RATE_MIN || rate > RATE_MAX)
          return { ok: false, error: `op ${idx}: rate must be within [${RATE_MIN}, ${RATE_MAX}]` };
        out.push({ op, rate });
        break;
      }
      case "set_bg": {
        const bg = (r as { bg?: unknown }).bg;
        if (typeof bg !== "string" || !BG_PRESETS.includes(bg as BgPreset))
          return { ok: false, error: `op ${idx}: bg must be one of ${BG_PRESETS.join(", ")}` };
        out.push({ op, bg: bg as BgPreset });
        break;
      }
      default:
        return { ok: false, error: `op ${idx}: unknown op "${String(op)}"` };
    }
  }
  return { ok: true, ops: out };
}
