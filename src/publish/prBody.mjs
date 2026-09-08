// The pull-request DESCRIPTION, written from the change record the agent saved on its
// spool. A port of web/lib/prBody.ts: same fence, same preserved original, same lines,
// so the App's merge-time write and this one produce the same body for the same record.

export const BODY_START = "<!-- spool:pr-body -->";
export const BODY_END = "<!-- spool:pr-body:end -->";
export const ORIGINAL_START = "<!-- spool:original -->";
export const ORIGINAL_END = "<!-- spool:original:end -->";
export const BODY_MAX = 65536;
const CHAPTER_ROWS = 12;
const RECORD_ATTRIBUTION = "Description by [Spool](https://spoolkit.dev), from the change record the agent saved on its spool.";

const clean = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim();
const mmss = (sec) => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
export const watchAt = (url, seconds) => `${url}#t=${Math.max(0, Math.round(seconds))}`;

/** The description a human wrote, wherever it currently lives. */
export function readOriginal(body) {
  const text = clean(body);
  if (!text) return "";
  const start = text.indexOf(BODY_START);
  const end = text.lastIndexOf(BODY_END);
  if (start === -1 || end === -1 || end < start) return text;
  const region = text.slice(start, end);
  const o = region.indexOf(ORIGINAL_START);
  const oEnd = region.lastIndexOf(ORIGINAL_END);
  if (o === -1 || oEnd === -1 || oEnd < o) return "";
  return clean(region.slice(o + ORIGINAL_START.length, oEnd));
}

/** Put `region` where spool's region goes, leaving every other character alone. */
export function spliceRegion(body, region) {
  const text = clean(body);
  const start = text.indexOf(BODY_START);
  const end = text.lastIndexOf(BODY_END);
  if (start === -1 || end === -1 || end < start) return region.slice(0, BODY_MAX);
  const before = text.slice(0, start).replace(/\s+$/, "");
  const after = text.slice(end + BODY_END.length).replace(/^\s+/, "");
  return [before, region, after].filter(Boolean).join("\n\n").slice(0, BODY_MAX);
}

function preserved(original) {
  if (!original) return [];
  return ["<details>", "<summary>The description this pull request opened with</summary>", "", ORIGINAL_START, original, ORIGINAL_END, "", "</details>"];
}

function requestLines(change) {
  const r = change.intent?.request;
  if (!r || r.source === "pr") return [];
  const text = clean(r.text);
  if (!text) return [];
  if (r.source === "user") return [`> ${text.replace(/\n+/g, " ")}`];
  if (r.source === "issue") return [`From the issue: ${text}`];
  return [`Inferred by the agent: ${text}`];
}

function outcomeLine(o, change, card) {
  const labels = new Map((change.evidence || []).map((e) => [e.id, e.label]));
  const parts = [clean(o.claim), o.status];
  if (o.step && typeof o.start === "number") parts.push(`[${mmss(o.start)}](${watchAt(card.url, o.start)})`);
  const cited = (o.evidence || []).map((id) => labels.get(id)).filter(Boolean);
  if (cited.length) parts.push(cited.join(", "));
  return `- ${parts.join(" · ")}`;
}

/** The before/after pairs a served change record carries. Only URL halves count. */
export function pairsOf(change) {
  return (change?.evidence || [])
    .filter((e) => e.type === "compare" && /^https?:\/\//.test(e.before || "") && /^https?:\/\//.test(e.after || ""))
    .map((e) => ({ label: e.label, before: e.before, after: e.after }));
}

/** The region written from the change record. `card` is the published spool. */
export function recordRegion({ change, card, original }) {
  const why = [...requestLines(change), clean(change.intent?.interpretation?.outcome ?? "")].filter(Boolean);
  const summary = clean(change.result?.summary ?? "");
  const outcomes = change.result?.outcomes || [];
  const worth = [
    ...(change.result?.deviations || []).map((d) => `- Done differently: ${clean(d.note)}`),
    ...(change.result?.unknowns || []).map((u) => `- Not checked: ${clean(u)}`),
  ];
  const runtime = card.duration && card.duration > 0 ? ` · ${mmss(card.duration)}, narrated` : "";
  const chapterRows = card.chapters.length
    ? [
        "",
        "<details>",
        `<summary>Chapters (${card.chapters.length})</summary>`,
        "",
        ...card.chapters.slice(0, CHAPTER_ROWS).map((c) => `- [${mmss(c.start)}](${watchAt(card.url, c.start)}) ${c.name}`),
        "",
        "</details>",
      ]
    : [];
  const pairRows = card.pairs.length
    ? [
        "### Before / after",
        "",
        ...card.pairs.flatMap((p) => [
          `**${clean(p.label)}**`,
          "",
          "| Before | After |",
          "|---|---|",
          `| ![${clean(p.label)}, before](${p.before}) | ![${clean(p.label)}, after](${p.after}) |`,
          "",
        ]),
      ]
    : [];
  const lines = [
    BODY_START,
    ...(card.poster ? [`[![${card.title}](${card.poster})](${card.url})`, ""] : []),
    `**[Watch: ${card.title}](${card.url})**${runtime}`,
    ...chapterRows,
    "",
    ...(why.length ? ["### Why", "", why.join("\n\n"), ""] : []),
    ...(summary || outcomes.length
      ? ["### What changed", "", ...(summary ? [summary, ""] : []), ...outcomes.map((o) => outcomeLine(o, change, card)), ""]
      : []),
    ...pairRows,
    ...(worth.length ? ["### Worth knowing", "", ...worth, ""] : []),
    ...preserved(original),
    "",
    `<sub>${RECORD_ATTRIBUTION}</sub>`,
    BODY_END,
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The finished body: the record region spliced into what is already there. */
export function composeRecordBody({ current, change, card }) {
  return spliceRegion(current, recordRegion({ change, card, original: readOriginal(current) }));
}
