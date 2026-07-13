import type Anthropic from "@anthropic-ai/sdk";
import { execTool, type ExecContext } from "./askBundle";

// OpenAI chat-completions provider for the ask route, used when only
// OPENAI_API_KEY is configured. Mirrors the Anthropic loop's bounds exactly.
const MAX_ROUNDS = 6;
const TIME_BUDGET_MS = 25_000;

type OpenAIMessage =
  | { role: "system" | "user" | "assistant"; content: string }
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };

type OpenAITool = { type: "function"; function: { name: string; description?: string; parameters: unknown } };

type Choice = {
  finish_reason: string;
  message: { content: string | null; tool_calls?: ToolCall[] };
};

// Re-shape Anthropic tool defs into chat-completions function tools so both
// loops share one source of truth for the tool vocabulary.
export function toOpenAITools(tools: Anthropic.Tool[]): OpenAITool[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

async function chatComplete(o: {
  apiKey: string;
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  toolChoice?: "auto" | "none";
}): Promise<Choice> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${o.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: o.model,
      messages: o.messages,
      max_completion_tokens: 1024,
      ...(o.tools ? { tools: o.tools, tool_choice: o.toolChoice ?? "auto" } : {}),
    }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { choices: Choice[] };
  return json.choices[0];
}

export async function openAIAnswer(o: {
  apiKey: string;
  model: string;
  system: string;
  history: { role: "user" | "assistant"; content: string }[];
  question: string;
}): Promise<string> {
  const choice = await chatComplete({
    apiKey: o.apiKey,
    model: o.model,
    messages: [{ role: "system", content: o.system }, ...o.history, { role: "user", content: o.question }],
  });
  return (choice.message.content ?? "").trim();
}

export async function openAIToolLoop(o: {
  apiKey: string;
  model: string;
  system: string;
  ctx: ExecContext;
  tools: Anthropic.Tool[];
  history: { role: "user" | "assistant"; content: string }[];
  question: string;
  now?: () => number;
}): Promise<{ answer: string; rounds: number; misses: number }> {
  const now = o.now ?? Date.now;
  const tools = toOpenAITools(o.tools);
  const messages: OpenAIMessage[] = [
    { role: "system", content: o.system },
    ...o.history,
    { role: "user", content: o.question },
  ];
  const t0 = now();
  let rounds = 0;
  let misses = 0;

  let choice = await chatComplete({ apiKey: o.apiKey, model: o.model, messages, tools });
  while (choice.finish_reason === "tool_calls" && choice.message.tool_calls?.length) {
    const bound = rounds >= MAX_ROUNDS || now() - t0 >= TIME_BUDGET_MS;
    messages.push({ role: "assistant", content: choice.message.content, tool_calls: choice.message.tool_calls });
    for (const call of choice.message.tool_calls) {
      let input: unknown = {};
      try {
        input = JSON.parse(call.function.arguments || "{}");
      } catch {
        /* malformed arguments read as empty input */
      }
      const { content, miss } = await execTool(o.ctx, call.function.name, input);
      if (miss) misses++;
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    rounds++;
    if (bound) {
      choice = await chatComplete({ apiKey: o.apiKey, model: o.model, messages, tools, toolChoice: "none" });
      break;
    }
    choice = await chatComplete({ apiKey: o.apiKey, model: o.model, messages, tools });
  }

  const answer = (choice.message.content ?? "").trim();
  if (misses > 0) {
    console.log("[ask] possibly-unanswerable", JSON.stringify({ spoolId: o.ctx.spoolId, question: o.question.slice(0, 200) }));
  }
  return { answer, rounds, misses };
}
