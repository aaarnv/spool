// The pull-request DESCRIPTION, written from the change record the agent saved on its
// spool. A port of web/lib/prBody.ts: same fence, same preserved original, same lines,
// so the App's merge-time write and this one produce the same body for the same record.

export const BODY_START = "<!-- spool:pr-body -->";
export const BODY_END = "<!-- spool:pr-body:end -->";
export const ORIGINAL_START = "<!-- spool:original -->";
export const ORIGINAL_END = "<!-- spool:original:end -->";
export const BODY_MAX = 65536;
const CHAPTER_ROWS = 12;

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

/** Only a claim nobody stood behind gets a word; a verified one reads as plain fact. */
const STATUS_SUFFIX = { partial: " (partial)", unmet: " (not done)", unchecked: " (not verified)" };

/** The opening paragraph: the ask in its own words, else what the agent set out to do. */
function whyParagraph(change) {
  const r = change.intent?.request;
  const request = r && r.source !== "pr" ? clean(r.text).replace(/\n+/g, " ") : "";
  if (request) return r.source === "user" ? `> ${request}` : request;
  return clean(change.intent?.interpretation?.outcome ?? "");
}

function outcomeLine(o, card) {
  const link = o.step && typeof o.start === "number" ? ` [${mmss(o.start)}](${watchAt(card.url, o.start)})` : "";
  return `- ${clean(o.claim)}${STATUS_SUFFIX[o.status] ?? ""}${link}`;
}

function preservedShort(original) {
  if (!original) return [];
  return ["<details>", "<summary>Original description</summary>", "", ORIGINAL_START, original, ORIGINAL_END, "", "</details>"];
}

/** The before/after pairs a served change record carries. Only URL halves count. */
export function pairsOf(change) {
  return (change?.evidence || [])
    .filter((e) => e.type === "compare" && /^https?:\/\//.test(e.before || "") && /^https?:\/\//.test(e.after || ""))
    .map((e) => ({ label: e.label, before: e.before, after: e.after }));
}

/** The region written from the change record: why, changes, screenshots, testing. */
export function recordRegion({ change, card, original }) {
  const why = whyParagraph(change);
  const outcomes = change.result?.outcomes || [];
  const summary = clean(change.result?.summary ?? "");
  const changes = outcomes.length ? outcomes.map((o) => outcomeLine(o, card)) : summary ? [summary] : [];
  const tests = (change.evidence || []).filter((e) => e.type === "test").map((e) => `- ${clean(e.detail || e.label)}`);
  const deviations = (change.result?.deviations || []).map((d) => `- ${clean(d.note)}`);
  const unknowns = (change.result?.unknowns || []).map((u) => `- ${clean(u)}`);
  const pairRows = card.pairs.flatMap((p) => [
    ...(card.pairs.length > 1 ? [`**${clean(p.label)}**`, ""] : []),
    "| Before | After |",
    "|---|---|",
    `| ![${clean(p.label)}, before](${p.before}) | ![${clean(p.label)}, after](${p.after}) |`,
    "",
  ]);
  const runtime = card.duration && card.duration > 0 ? `, ${mmss(card.duration)}` : "";
  const chapters = card.chapters.slice(0, CHAPTER_ROWS).map((c) => `[${c.name}](${watchAt(card.url, c.start)})`);
  const walkthrough = [`[Walkthrough${runtime}](${card.url})`, ...chapters].join(" · ");

  const lines = [
    BODY_START,
    ...(why ? [why, ""] : []),
    ...(changes.length ? ["### Changes", "", ...changes, ""] : []),
    ...(pairRows.length ? ["### Before / after", "", ...pairRows] : []),
    ...(tests.length ? ["### Testing", "", ...tests, ""] : []),
    ...(deviations.length ? ["### Deviations", "", ...deviations, ""] : []),
    ...(unknowns.length ? ["### Not verified", "", ...unknowns, ""] : []),
    walkthrough,
    "",
    ...preservedShort(original),
    BODY_END,
  ];
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** The finished body: the record region spliced into what is already there. */
export function composeRecordBody({ current, change, card }) {
  return spliceRegion(current, recordRegion({ change, card, original: readOriginal(current) }));
}
