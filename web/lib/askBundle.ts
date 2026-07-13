import type Anthropic from "@anthropic-ai/sdk";
import { srcBlobUrl } from "../app/spool";
import type { KnowledgeStore } from "./knowledgeOps";

// The context pack the CLI publishes to spools/{id}/src/pr/context.json. Only the
// fields the ask loop reads are typed; unknown extras are ignored.
export type PackFile = { text: string } | { omitted: string };

export type ContextPack = {
  version?: number;
  brief?: string | null;
  pr?: { owner?: string; repo?: string; headRefOid?: string; isCrossRepository?: boolean } | null;
  readme?: { path: string; text: string } | null;
  docs?: { path: string; text: string }[];
  files?: Record<string, PackFile>;
  related?: string[];
  commits?: { sha: string; message: string }[];
  issues?: { number: number; title: string; body: string }[];
};

// Returned verbatim as tool_result content when a requested path is not readable.
// Tool results never throw, so this string is how the model learns of a gap.
export const UNAVAILABLE = "file not available in this guide's bundle";

const MAX_ROUNDS = 6;
const TIME_BUDGET_MS = 25_000;

export function parsePack(raw: string | null): ContextPack | null {
  if (!raw) return null;
  try {
    const pack = JSON.parse(raw) as ContextPack;
    return pack && typeof pack === "object" ? pack : null;
  } catch {
    return null;
  }
}

// The two bundle tools. list_files takes no input; read_file takes a required path.
export const listFilesTool: Anthropic.Tool = {
  name: "list_files",
  description: "List every file path readable from this guide's bundle.",
  input_schema: { type: "object", properties: {} },
};

export const readFileTool: Anthropic.Tool = {
  name: "read_file",
  description:
    "Read the post-change contents of one file from this guide's bundle by its exact path.",
  input_schema: {
    type: "object",
    properties: { path: { type: "string", description: "Exact path as shown by list_files." } },
    required: ["path"],
  },
};

export const bundleTools: Anthropic.Tool[] = [listFilesTool, readFileTool];

// Project tools (offered only when the guide belongs to a project with shared
// knowledge or sibling guides). read_knowledge reads one keyed entry; read_guide
// reads another PR's guide from the same repo.
export const readKnowledgeTool: Anthropic.Tool = {
  name: "read_knowledge",
  description:
    'Read one entry from this project\'s shared knowledge. key is one of: "overview", ' +
    '"decisions", "subsystems/<name>", "vocabulary/<term>", "recording/<topic>". An unknown ' +
    "key returns the list of valid keys.",
  input_schema: {
    type: "object",
    properties: { key: { type: "string", description: "overview | decisions | subsystems/<name> | vocabulary/<term> | recording/<topic>" } },
    required: ["key"],
  },
};

export const readGuideTool: Anthropic.Tool = {
  name: "read_guide",
  description: "Read another guide from this repo by its PR number: its tour prose and product brief.",
  input_schema: {
    type: "object",
    properties: { pr: { type: "integer", description: "The PR number of the sibling guide." } },
    required: ["pr"],
  },
};

export const projectTools: Anthropic.Tool[] = [readKnowledgeTool, readGuideTool];

// Deduped list of every path a reader can request: changed/related files, docs,
// and the readme. Related paths whose contents live in files{} are included once.
export function listFiles(pack: ContextPack): string {
  const paths: string[] = [
    ...Object.keys(pack.files ?? {}),
    ...(pack.related ?? []),
    ...(pack.docs ?? []).map((d) => d.path),
    ...(pack.readme ? [pack.readme.path] : []),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join("\n");
}

// Look a path up across files{} (omitted markers count as absent), docs, then
// readme. null means the path is not readable and the caller should log a miss.
export function readFileFromPack(pack: ContextPack, path: string): string | null {
  const f = pack.files?.[path];
  if (f && "text" in f) return f.text;
  if (f && "omitted" in f) return null;
  const doc = (pack.docs ?? []).find((d) => d.path === path);
  if (doc) return doc.text;
  if (pack.readme && pack.readme.path === path) return pack.readme.text;
  return null;
}

// A sibling guide (another PR's guide in the same project), surfaced to the model
// as an index entry and readable in full via read_guide.
export type SiblingGuide = { id: string; pr: number; title: string | null };

// Everything a tool call needs, with the two fetchers injected so the loop runs
// under test without network. pack is null for a projectless or diff-tier guide.
export type ExecContext = {
  pack: ContextPack | null;
  spoolId: string;
  knowledge: KnowledgeStore | null;
  siblings: SiblingGuide[];
  srcUrl: (id: string, name: string) => string;
  fetchText: (url: string) => Promise<string>;
};

// Fetch a blob's text, degrading any failure to "" (tool results never throw).
export async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
}

export function makeExecContext(o: {
  pack: ContextPack | null;
  spoolId: string;
  knowledge?: KnowledgeStore | null;
  siblings?: SiblingGuide[];
  srcUrl?: (id: string, name: string) => string;
  fetchText?: (url: string) => Promise<string>;
}): ExecContext {
  return {
    pack: o.pack,
    spoolId: o.spoolId,
    knowledge: o.knowledge ?? null,
    siblings: o.siblings ?? [],
    srcUrl: o.srcUrl ?? srcBlobUrl,
    fetchText: o.fetchText ?? fetchText,
  };
}

const GUIDE_CAP = 8000;

const provLine = (pr: number, updatedAt: string) => `(from PR #${pr}, updated ${updatedAt})`;

// The valid-key listing returned when read_knowledge gets an unknown/absent key.
// Self-correcting, not a miss: it shows the model exactly what it can read.
function knowledgeKeys(k: KnowledgeStore): string {
  const subs = Object.keys(k.subsystems);
  const terms = Object.keys(k.vocabulary);
  const topics = Object.keys(k.recording);
  return (
    "Valid keys: overview, decisions" +
    (subs.length ? `\nsubsystems/: ${subs.join(", ")}` : "") +
    (terms.length ? `\nvocabulary/: ${terms.join(", ")}` : "") +
    (topics.length ? `\nrecording/: ${topics.join(", ")}` : "")
  );
}

function readKnowledge(k: KnowledgeStore | null, key: string): string {
  if (!k) return "no project knowledge for this guide";
  if (key === "overview") {
    if (!k.overview) return knowledgeKeys(k);
    return `${k.overview.text}\n${provLine(k.overview.pr, k.overview.updatedAt)}`;
  }
  if (key === "decisions") {
    if (k.decisions.length === 0) return "no decisions recorded";
    return k.decisions.map((d) => `- ${d.what}: ${d.why} (PR #${d.pr}, ${d.date})`).join("\n");
  }
  const slash = key.indexOf("/");
  if (slash > 0) {
    const section = key.slice(0, slash);
    const name = key.slice(slash + 1);
    const map =
      section === "subsystems" ? k.subsystems : section === "vocabulary" ? k.vocabulary : section === "recording" ? k.recording : null;
    const entry = map?.[name];
    if (entry) return `${entry.text}\n${provLine(entry.pr, entry.updatedAt)}`;
  }
  return knowledgeKeys(k);
}

// Read a sibling guide's tour prose + product brief. Tolerant of both shapes for
// tour.json (a bare stops array or {stops}). Capped so one sibling can't blow the
// context budget.
async function readGuide(ctx: ExecContext, pr: number): Promise<{ content: string; miss: boolean }> {
  const sib = ctx.siblings.find((s) => s.pr === pr);
  if (!sib) {
    console.log("[ask] guide-miss", JSON.stringify({ spoolId: ctx.spoolId, pr }));
    return { content: `no other guide for PR #${pr} in this project`, miss: true };
  }
  const [tourRaw, contextRaw] = await Promise.all([
    ctx.fetchText(ctx.srcUrl(sib.id, "pr/tour.json")),
    ctx.fetchText(ctx.srcUrl(sib.id, "pr/context.json")),
  ]);
  const lines: string[] = [`PR #${pr}: ${sib.title ?? "(untitled)"}`];
  try {
    const parsed = JSON.parse(tourRaw) as unknown;
    const stops = Array.isArray(parsed) ? parsed : (parsed as { stops?: unknown })?.stops;
    if (Array.isArray(stops)) {
      for (const s of stops) {
        const stop = s as { heading?: unknown; prose?: unknown };
        if (typeof stop?.heading === "string" && typeof stop?.prose === "string")
          lines.push(`\n${stop.heading}\n${stop.prose}`);
      }
    }
  } catch {
    /* tour optional */
  }
  const pack = parsePack(contextRaw || null);
  if (pack?.brief) lines.push(`\nBrief:\n${pack.brief}`);
  let content = lines.join("\n");
  if (content.length > GUIDE_CAP) content = content.slice(0, GUIDE_CAP) + "\n[... truncated]";
  return { content, miss: false };
}

// Execute one tool call. Read misses are logged here (they are the App tripwire)
// and reported via `miss` so the loop can flag a possibly-unanswerable answer.
export async function execTool(
  ctx: ExecContext,
  name: string,
  input: unknown
): Promise<{ content: string; miss: boolean }> {
  if (name === "list_files") return { content: ctx.pack ? listFiles(ctx.pack) : UNAVAILABLE, miss: false };
  if (name === "read_file") {
    if (!ctx.pack) return { content: UNAVAILABLE, miss: false };
    const path = typeof (input as { path?: unknown })?.path === "string" ? (input as { path: string }).path : "";
    const text = readFileFromPack(ctx.pack, path);
    if (text === null) {
      console.log("[ask] bundle-miss", JSON.stringify({ spoolId: ctx.spoolId, path }));
      return { content: UNAVAILABLE, miss: true };
    }
    return { content: text, miss: false };
  }
  if (name === "read_knowledge") {
    const key = typeof (input as { key?: unknown })?.key === "string" ? (input as { key: string }).key : "";
    return { content: readKnowledge(ctx.knowledge, key), miss: false };
  }
  if (name === "read_guide") {
    const pr = (input as { pr?: unknown })?.pr;
    if (!Number.isInteger(pr)) return { content: "read_guide requires a PR number", miss: false };
    return readGuide(ctx, pr as number);
  }
  return { content: UNAVAILABLE, miss: false };
}

// Compact inline index appended to the system prompt when a guide belongs to a
// project. Lists overview text, subsystem names, vocabulary terms, the last 5
// decisions, and sibling guides. Recording topics are deliberately excluded
// (operational memory for the authoring agent, not reader comprehension).
// Returns "" when there is nothing to show so projectless prompts stay identical.
export function buildProjectBlock(knowledge: KnowledgeStore | null, siblings: SiblingGuide[]): string {
  const k = knowledge;
  const subs = k ? Object.keys(k.subsystems) : [];
  const terms = k ? Object.keys(k.vocabulary) : [];
  const decisions = k ? k.decisions : [];
  const hasIndex = !!(k && (k.overview || subs.length || terms.length || decisions.length));
  if (!hasIndex && siblings.length === 0) return "";

  const parts: string[] = ["Project knowledge (shared across this repo's guides):"];
  if (k?.overview) parts.push(`Overview: ${k.overview.text}`);
  if (subs.length) parts.push(`Subsystems: ${subs.join(", ")}`);
  if (terms.length) parts.push(`Vocabulary: ${terms.join(", ")}`);
  if (decisions.length) {
    const recent = decisions.slice(-5).map((d) => `- ${d.what}: ${d.why} (PR #${d.pr}, ${d.date})`);
    parts.push(`Recent decisions:\n${recent.join("\n")}`);
  }
  if (siblings.length) {
    const list = siblings.map((s) => `- PR #${s.pr}: ${s.title ?? "(untitled)"}`);
    parts.push(`Other guides in this project:\n${list.join("\n")}`);
  }
  return parts.join("\n");
}

// Build the messages.create params. Diff tier passes no tools, so no `tools` key
// appears, keeping that request byte-identical to phase 1.
export function messageCreateParams(o: {
  model: string;
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
}): Anthropic.MessageCreateParamsNonStreaming {
  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model: o.model,
    max_tokens: 1024,
    system: o.system,
    messages: o.messages,
  };
  if (o.tools) {
    params.tools = o.tools;
    params.tool_choice = o.toolChoice ?? { type: "auto" };
  }
  return params;
}

function extractText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();
}

export type CallModel = (
  messages: Anthropic.MessageParam[],
  toolChoice: Anthropic.ToolChoice
) => Promise<Anthropic.Message>;

// The bundle tool loop. Re-calls with tool_choice auto while the model keeps
// asking for tools, bounded by round + wall-clock caps; on a bound it answers the
// outstanding tool_use blocks then forces text with tool_choice none. callModel is
// injected so the loop runs under test without a real key.
export async function runToolLoop(opts: {
  callModel: CallModel;
  ctx: ExecContext;
  question: string;
  initialMessages: Anthropic.MessageParam[];
  now?: () => number;
  maxRounds?: number;
  timeBudgetMs?: number;
}): Promise<{ answer: string; rounds: number; misses: number }> {
  const now = opts.now ?? Date.now;
  const maxRounds = opts.maxRounds ?? MAX_ROUNDS;
  const timeBudgetMs = opts.timeBudgetMs ?? TIME_BUDGET_MS;
  const messages = [...opts.initialMessages];
  const t0 = now();
  let rounds = 0;
  let misses = 0;

  // Answer every tool_use block in `res`, appending the assistant turn and the
  // matching tool_result user turn so prior tool_use blocks stay valid.
  const absorbTurn = async (res: Anthropic.Message) => {
    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const { content, miss } = await execTool(opts.ctx, block.name, block.input);
      if (miss) misses++;
      results.push({ type: "tool_result", tool_use_id: block.id, content });
    }
    messages.push({ role: "user", content: results });
  };

  let res = await opts.callModel(messages, { type: "auto" });
  while (res.stop_reason === "tool_use") {
    const bound = rounds >= maxRounds || now() - t0 >= timeBudgetMs;
    await absorbTurn(res);
    rounds++;
    if (bound) {
      res = await opts.callModel(messages, { type: "none" });
      break;
    }
    res = await opts.callModel(messages, { type: "auto" });
  }

  const answer = extractText(res);
  if (misses > 0) {
    console.log(
      "[ask] possibly-unanswerable",
      JSON.stringify({ spoolId: opts.ctx.spoolId, question: opts.question.slice(0, 200) })
    );
  }
  return { answer, rounds, misses };
}
