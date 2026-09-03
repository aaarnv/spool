// The MCP server: stdio in, the platform's plan API out.
//
// Everything interesting is in tools.mjs and blocking.mjs; this file only wires them to
// the SDK and enforces the one rule stdio transport imposes — stdout belongs to the
// JSON-RPC channel and nothing else may write to it. A stray console.log here corrupts
// the protocol, so diagnostics go to stderr without exception.
//
// Each tool answers with two content blocks: a first line of prose that says what
// happened (which is what an agent actually reads), and the platform's payload verbatim
// as JSON underneath (which is what an agent branches on).

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { SERVER_NAME, SERVER_VERSION, loadConfig } from './config.mjs';
import { toolTable } from './tools.mjs';

const INSTRUCTIONS = `Spool Plan Spools: propose a plan as a watchable, decidable packet and follow what happens to it.

Two rules this API will not let you around, so read them once:

1. A COMMENT BLOCKS. While any comment on the plan's current revision is unacknowledged,
   every call that moves work forward is refused. ack_comment is the only thing that
   clears it, and acknowledging is NOT answering — the question stays open until you
   reply with answer_question.
2. You can never decide your own plan. plan.decide belongs to a signed-in human. Your
   job is to propose, to ask, and to wait with await_events.

Start with gate_check or plan_read before acting on any plan; both lead with the block
when there is one.`;

/** Turn a handler's `{ text, json }` into an MCP tool result. */
function toResult(out) {
  const content = [{ type: 'text', text: out.text ?? '' }];
  if (out.json !== undefined) content.push({ type: 'text', text: JSON.stringify(out.json, null, 2) });
  return { content, ...(out.isError ? { isError: true } : {}) };
}

/**
 * Build the server, wired to one host and token.
 *
 * The config is resolved once at startup rather than per call: a server whose
 * credentials changed underneath it would answer two tools as two different owners, and
 * the cursor on disk is keyed to exactly one pair.
 */
export async function createServer({ cfg, env = process.env } = {}) {
  const resolved = cfg ?? (await loadConfig({ env }));
  const ctx = { cfg: { ...resolved, version: SERVER_VERSION }, env };
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
  );

  for (const tool of toolTable()) {
    server.registerTool(
      tool.name,
      { title: tool.title, description: tool.description, inputSchema: tool.inputSchema },
      async (args, extra) => {
        try {
          const out = await tool.handler({ ...ctx, signal: extra?.signal }, args ?? {});
          return toResult(out);
        } catch (e) {
          // A thrown error is a fault on this side; the platform's refusals are data.
          return toResult({ isError: true, text: `${tool.name} failed: ${e?.message || e}`, json: { error: String(e?.message || e) } });
        }
      }
    );
  }

  return { server, ctx };
}

/** Serve on stdio until the client disconnects. */
export async function serve({ env = process.env } = {}) {
  const { server, ctx } = await createServer({ env });
  process.stderr.write(`[spool-mcp] serving ${ctx.cfg.host}${ctx.cfg.token ? '' : ' WITHOUT a token — most tools will refuse'}\n`);
  await server.connect(new StdioServerTransport());
  return server;
}
