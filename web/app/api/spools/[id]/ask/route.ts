import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { sql, eq, and, ne, desc, isNotNull } from "drizzle-orm";
import { db } from "../../../../../db";
import { askUsage, spools as spoolsTable } from "../../../../../db/schema";
import { fetchSpoolJson } from "../../../../../lib/spoolAccess";
import {
  bundleTools,
  projectTools,
  buildProjectBlock,
  makeExecContext,
  messageCreateParams,
  parsePack,
  runToolLoop,
  fetchText,
  type CallModel,
  type SiblingGuide,
} from "../../../../../lib/askBundle";
import { openAIAnswer, openAIToolLoop } from "../../../../../lib/askOpenAI";
import { fetchKnowledge } from "../../../../../lib/knowledge";
import { sendOpsAlert } from "../../../../../lib/alerts";
import { srcBlobUrl } from "../../../../spool";

export const runtime = "nodejs";
export const maxDuration = 60;

// Public, unauthenticated Q&A grounded in a published PR guide. Rate limited by
// requester IP and per-spool. Two tiers: a bundle guide grounds answers in a
// tool loop over its shipped code + docs; an older guide falls back to diff-only.
const IP_CAP = Number(process.env.ASK_IP_DAILY_CAP) || 25;
const SPOOL_CAP = Number(process.env.ASK_SPOOL_DAILY_CAP) || 200;
const DIFF_BUDGET = 60_000;
const BODY_CAP = 4000;

const bad = (status: number, error: string) => Response.json({ error }, { status });

type Turn = { role: "user" | "assistant"; content: string };
type Body = { question?: string; history?: unknown };

// Split a unified diff into per-file sections keyed by their new path so we can
// prioritize the files a tour stop points at when budgeting the context.
function splitDiffByFile(patch: string): { path: string; text: string }[] {
  const parts = patch.split(/(?=^diff --git )/m).filter((s) => s.startsWith("diff --git"));
  return parts.map((text) => {
    let path = "";
    for (const line of text.split("\n")) {
      if (line.startsWith("+++ ")) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") {
          path = p.replace(/^b\//, "");
          break;
        }
      }
      if (line.startsWith("--- ") && !path) {
        const p = line.slice(4).trim();
        if (p !== "/dev/null") path = p.replace(/^a\//, "");
      }
    }
    return { path, text };
  });
}

function validateHistory(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const t of raw.slice(-6)) {
    if (!t || typeof t !== "object") continue;
    const role = (t as Turn).role;
    const content = (t as Turn).content;
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") continue;
    out.push({ role, content: content.slice(0, 2000) });
  }
  return out;
}

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return bad(400, "expected json body");
  }
  const question = (body.question || "").trim();
  if (!question) return bad(400, "missing question");
  if (question.length > 500) return bad(400, "question too long (max 500 chars)");
  const history = validateHistory(body.history);

  const spool = await fetchSpoolJson(id);
  if (!spool || !spool.pr) return bad(404, "not found");
  // Anthropic when its key exists, OpenAI otherwise; both loops share bounds + tools.
  const provider = process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENAI_API_KEY ? "openai" : null;
  if (!provider) return bad(503, "no model API key configured");

  // Reserve a daily slot per IP, then per spool, before any model work. Rejecting
  // past the cap keeps counting, which is harmless for an abuse guard.
  const fwd = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const ipHash = createHash("sha256").update((process.env.ASK_IP_SALT || "") + fwd).digest("hex");
  const day = new Date().toISOString().slice(0, 10);

  const [ipRow] = await db
    .insert(askUsage)
    .values({ spoolId: id, ipHash, day, count: 1 })
    .onConflictDoUpdate({
      target: [askUsage.spoolId, askUsage.ipHash, askUsage.day],
      set: { count: sql`${askUsage.count} + 1` },
    })
    .returning({ count: askUsage.count });
  if (ipRow.count > IP_CAP) {
    return bad(429, `daily question cap reached (${IP_CAP}/day). Try again tomorrow.`);
  }

  const [spoolRow] = await db
    .insert(askUsage)
    .values({ spoolId: id, ipHash: "*", day, count: 1 })
    .onConflictDoUpdate({
      target: [askUsage.spoolId, askUsage.ipHash, askUsage.day],
      set: { count: sql`${askUsage.count} + 1` },
    })
    .returning({ count: askUsage.count });
  if (spoolRow.count > SPOOL_CAP) {
    return bad(429, "this guide has hit its daily question limit. Try again tomorrow.");
  }
  const remainingToday = Math.max(0, IP_CAP - ipRow.count);

  // Project identity: prefer the server-stamped columns; fall back to the guide's
  // own pr.owner/repo (lowercased) for pre-migration guides so knowledge still
  // resolves. Siblings need the columns, so they are gated on repoOwner below.
  const [row] = await db
    .select({ ownerId: spoolsTable.ownerId, repoOwner: spoolsTable.repoOwner, repoName: spoolsTable.repoName })
    .from(spoolsTable)
    .where(eq(spoolsTable.id, id))
    .limit(1);
  const projOwner = (row?.repoOwner ?? spool.pr.owner ?? null)?.toLowerCase() ?? null;
  const projRepo = (row?.repoName ?? spool.pr.repo ?? null)?.toLowerCase() ?? null;

  const knowledgeP =
    row?.ownerId && projOwner && projRepo
      ? fetchKnowledge(row.ownerId, projOwner, projRepo)
      : Promise.resolve(null);
  const siblingsP =
    row?.ownerId && row?.repoOwner && row?.repoName
      ? db
          .select({ id: spoolsTable.id, prNumber: spoolsTable.prNumber, title: spoolsTable.title })
          .from(spoolsTable)
          .where(
            and(
              eq(spoolsTable.ownerId, row.ownerId),
              eq(spoolsTable.repoOwner, row.repoOwner),
              eq(spoolsTable.repoName, row.repoName),
              ne(spoolsTable.id, id),
              isNotNull(spoolsTable.prNumber)
            )
          )
          .orderBy(desc(spoolsTable.createdAt))
          .limit(10)
      : Promise.resolve([] as { id: string; prNumber: number | null; title: string | null }[]);

  // Ground the model: PR title/body, the tour stops (inline in spool.pr), the
  // step narrations, and the diff budgeted to fit prioritizing referenced files.
  // context.json (bundle tier) is optional; its absence keeps the diff-only path.
  const [prRaw, diffRaw, contextRaw, knowledge, siblingRows] = await Promise.all([
    fetchText(srcBlobUrl(id, "pr/pr.json")),
    fetchText(srcBlobUrl(id, "pr/diff.patch")),
    fetchText(srcBlobUrl(id, "pr/context.json")),
    knowledgeP,
    siblingsP,
  ]);
  const siblings: SiblingGuide[] = siblingRows
    .filter((r) => r.prNumber !== null)
    .map((r) => ({ id: r.id, pr: r.prNumber as number, title: r.title }));
  const knowledgeHasContent = !!(
    knowledge &&
    (knowledge.overview ||
      Object.keys(knowledge.subsystems).length ||
      Object.keys(knowledge.vocabulary).length ||
      Object.keys(knowledge.recording).length ||
      knowledge.decisions.length)
  );
  const hasProject = siblings.length > 0 || knowledgeHasContent;
  const projectBlock = buildProjectBlock(knowledge, siblings);
  const projectSuffix = projectBlock ? `\n\n${projectBlock}` : "";

  const pack = parsePack(contextRaw || null);
  const tier: "bundle" | "diff" = pack ? "bundle" : "diff";
  const DEFAULT_MODEL = {
    anthropic: { bundle: "claude-sonnet-5", diff: "claude-haiku-4-5" },
    openai: { bundle: "gpt-5.1", diff: "gpt-5-mini" },
  } as const;
  const model = process.env.SPOOL_ASK_MODEL || DEFAULT_MODEL[provider][tier];

  let prBody = "";
  try {
    const prJson = JSON.parse(prRaw) as { body?: string };
    prBody = (prJson.body || "").slice(0, BODY_CAP);
  } catch {
    /* body optional */
  }

  const stops = spool.pr.stops
    .map(
      (s, i) =>
        `Stop ${i + 1} [${s.id}] ${s.heading}\n${s.prose}\nFiles: ${s.files.map((f) => f.path).join(", ")}`
    )
    .join("\n\n");
  const narrations = spool.steps
    .filter((s) => s.narration)
    .map((s) => `- ${s.name}: ${s.narration}`)
    .join("\n");

  const referenced = new Set<string>();
  for (const s of spool.pr.stops) for (const f of s.files) referenced.add(f.path);
  const fileSections = splitDiffByFile(diffRaw);
  const ordered = [
    ...fileSections.filter((f) => referenced.has(f.path)),
    ...fileSections.filter((f) => !referenced.has(f.path)),
  ];
  let budget = DIFF_BUDGET;
  const chunks: string[] = [];
  for (const f of ordered) {
    if (budget <= 0) break;
    if (f.text.length <= budget) {
      chunks.push(f.text);
      budget -= f.text.length;
    } else {
      chunks.push(f.text.slice(0, budget) + "\n[... truncated]");
      budget = 0;
    }
  }
  const diffContext = chunks.join("\n");

  const context =
    `PR #${spool.pr.number}: ${spool.pr.title}\n\n` +
    (prBody ? `Description:\n${prBody}\n\n` : "") +
    `Guided tour stops:\n${stops}\n\n` +
    (narrations ? `Step narrations:\n${narrations}\n\n` : "") +
    `Diff:\n${diffContext}`;

  const systemBase =
    "You are a guide for one specific pull request. Answer questions ONLY from the provided PR " +
    "context (its diff, tour, and narration). Your tone is a comprehension guide helping a reader " +
    "understand what the change does and why. If the answer is not in the diff or context, say so " +
    "plainly. Never give a review verdict, never hunt for bugs, and do not use em dashes.";

  // Bundle tier prepends the product brief + readme and offers file-reading tools;
  // file contents are NOT inlined here, they flow through the tools on demand.
  const bundleContext =
    tier === "bundle" && pack
      ? (pack.brief ? `Product brief:\n${pack.brief}\n\n` : "") +
        (pack.readme ? `README (${pack.readme.path}):\n${pack.readme.text.slice(0, 8000)}\n\n` : "") +
        context
      : context;

  // The bundle-tier tool sentence widens to mention project knowledge + sibling
  // guides only when the guide belongs to a project; projectless guides keep the
  // original sentence (and the projectSuffix is "") so their prompt is unchanged.
  const bundleToolSentence = hasProject
    ? " You may read files from this guide's bundle, this project's shared knowledge, and sibling " +
      "guides from the same repo with the provided tools. Read at most a handful, then answer.\n\n"
    : " You may read files from this guide's bundle with the provided tools. Read at most a " +
      "handful of files, then answer.\n\n";

  const system =
    tier === "bundle"
      ? systemBase + bundleToolSentence + `PR context:\n${bundleContext}${projectSuffix}`
      : systemBase + `\n\nPR context:\n${context}${projectSuffix}`;

  const messages: Anthropic.MessageParam[] = [
    ...history.map((t) => ({ role: t.role, content: t.content })),
    { role: "user" as const, content: question },
  ];

  // Bundle tier offers the project tools alongside the bundle tools only when the
  // guide has a project; ctx carries knowledge/siblings only then too.
  const bundleToolset = hasProject ? [...bundleTools, ...projectTools] : bundleTools;
  const ctx = makeExecContext({ pack, spoolId: id, knowledge: hasProject ? knowledge : null, siblings });

  let answer: string;
  try {
    if (provider === "openai") {
      const apiKey = process.env.OPENAI_API_KEY!;
      answer =
        tier === "bundle" && pack
          ? (await openAIToolLoop({ apiKey, model, system, ctx, tools: bundleToolset, history, question })).answer
          : await openAIAnswer({ apiKey, model, system, history, question });
    } else if (tier === "bundle" && pack) {
      const client = new Anthropic();
      const callModel: CallModel = (msgs, toolChoice) =>
        client.messages.create(
          messageCreateParams({ model, system, messages: msgs, tools: bundleToolset, toolChoice })
        );
      const result = await runToolLoop({ callModel, ctx, question, initialMessages: messages });
      answer = result.answer;
    } else {
      const client = new Anthropic();
      const res = await client.messages.create(messageCreateParams({ model, system, messages }));
      answer = res.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("")
        .trim();
    }
  } catch (e) {
    await sendOpsAlert(`/api/spools/${id}/ask failed`, (e as Error).message, { key: "ask-error" });
    return bad(502, `ask failed: ${(e as Error).message}`);
  }

  return Response.json({ answer, grounding: tier, usage: { remainingToday } });
}
