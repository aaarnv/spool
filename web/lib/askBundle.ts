import type Anthropic from "@anthropic-ai/sdk";

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

// Execute one tool call. Read misses are logged here (they are the App tripwire)
// and reported via `miss` so the loop can flag a possibly-unanswerable answer.
export function execTool(
  pack: ContextPack,
  name: string,
  input: unknown,
  spoolId: string
): { content: string; miss: boolean } {
  if (name === "list_files") return { content: listFiles(pack), miss: false };
  if (name === "read_file") {
    const path = typeof (input as { path?: unknown })?.path === "string" ? (input as { path: string }).path : "";
    const text = readFileFromPack(pack, path);
    if (text === null) {
      console.log("[ask] bundle-miss", JSON.stringify({ spoolId, path }));
      return { content: UNAVAILABLE, miss: true };
    }
    return { content: text, miss: false };
  }
  return { content: UNAVAILABLE, miss: false };
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
  pack: ContextPack;
  spoolId: string;
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
  const absorbTurn = (res: Anthropic.Message) => {
    messages.push({ role: "assistant", content: res.content as Anthropic.ContentBlockParam[] });
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of res.content) {
      if (block.type !== "tool_use") continue;
      const { content, miss } = execTool(opts.pack, block.name, block.input, opts.spoolId);
      if (miss) misses++;
      results.push({ type: "tool_result", tool_use_id: block.id, content });
    }
    messages.push({ role: "user", content: results });
  };

  let res = await opts.callModel(messages, { type: "auto" });
  while (res.stop_reason === "tool_use") {
    const bound = rounds >= maxRounds || now() - t0 >= timeBudgetMs;
    absorbTurn(res);
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
      JSON.stringify({ spoolId: opts.spoolId, question: opts.question.slice(0, 200) })
    );
  }
  return { answer, rounds, misses };
}
