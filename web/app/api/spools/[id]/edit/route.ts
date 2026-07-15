import { OPS_TOOL_SCHEMA } from "../../../../../lib/editOps";
import { requireOwnedSpool, fetchSpoolJson, jsonError } from "../../../../../lib/spoolAccess";

export const runtime = "nodejs";

// Owner-only edit-intent parser. Turns a natural-language ask into the contract's
// ops vocabulary via a tool-forced OpenAI call. Side-effect free — no DB writes.
const MODEL = process.env.SPOOL_EDIT_MODEL || "gpt-5-mini";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwnedSpool(id);
  if ("error" in gate) return gate.error;
  if (!gate.row.hasSources) return jsonError(400, "spool has no sources; re-publish to enable editing");
  if (!process.env.OPENAI_API_KEY) return jsonError(500, "OPENAI_API_KEY not configured");

  let body: { instruction?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "expected json body");
  }
  const instruction = (body.instruction || "").trim();
  if (!instruction) return jsonError(400, "missing instruction");
  if (instruction.length > 2000) return jsonError(413, "instruction too long");

  const spool = await fetchSpoolJson(id);
  if (!spool) return jsonError(404, "spool data unavailable");

  // Give the model the current step order/narrations/title as ground truth.
  const steps = spool.steps.map((s) => ({ i: s.i, name: s.name, narration: s.narration }));
  const context = JSON.stringify({ title: spool.title, rate: spool.rate ?? 1, steps }, null, 2);
  const system =
    "You translate a user's plain-language editing request for a screen-recording walkthrough " +
    "into a structured list of edit operations. Only use the provided ops vocabulary. Step indices " +
    "are 0-based and refer to the CURRENT step order shown in the context. Operations apply in array " +
    "order (remove_step and reorder shift later indices). Keep narration edits under 600 characters and " +
    "playback rate within 0.75-2. For set_bg (the canvas behind the recording), bg must be one of: " +
    "graphite (dark neutral), paper (light warm), or indigo (brand gradient, the default). " +
    "Emit only ops the user actually asked for; if none apply, return an " +
    "empty ops array. In `summary`, write one short human-readable sentence per op, in the same order.\n\n" +
    `Spool context:\n${context}`;

  let toolInput: { ops?: unknown; summary?: unknown };
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: "system", content: system },
          { role: "user", content: instruction },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "propose_edits",
              description: "Return the edit operations and a per-op summary.",
              parameters: OPS_TOOL_SCHEMA,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "propose_edits" } },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return jsonError(502, `edit parsing failed: openai ${res.status} ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { tool_calls?: { function?: { arguments?: string } }[] } }[];
    };
    const args = data.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) return jsonError(502, "model returned no ops");
    toolInput = JSON.parse(args) as { ops?: unknown; summary?: unknown };
  } catch (e) {
    return jsonError(502, `edit parsing failed: ${(e as Error).message}`);
  }

  const ops = Array.isArray(toolInput.ops) ? toolInput.ops : [];
  const summary = Array.isArray(toolInput.summary) ? toolInput.summary : [];
  return Response.json({ ops, summary });
}
