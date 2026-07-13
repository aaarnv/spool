import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { sql } from "drizzle-orm";
import { db } from "../../../../../db";
import { askUsage } from "../../../../../db/schema";
import { fetchSpoolJson } from "../../../../../lib/spoolAccess";
import { srcBlobUrl } from "../../../../spool";

export const runtime = "nodejs";

// Public, unauthenticated Q&A grounded in a published PR guide. Rate limited by
// requester IP and per-spool; answers come only from the diff + tour context.
const MODEL = process.env.SPOOL_ASK_MODEL || "claude-haiku-4-5";
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

async function fetchText(url: string): Promise<string> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? await res.text() : "";
  } catch {
    return "";
  }
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
  if (!process.env.ANTHROPIC_API_KEY) return bad(503, "ANTHROPIC_API_KEY not configured");

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

  // Ground the model: PR title/body, the tour stops (inline in spool.pr), the
  // step narrations, and the diff budgeted to fit prioritizing referenced files.
  const [prRaw, diffRaw] = await Promise.all([
    fetchText(srcBlobUrl(id, "pr/pr.json")),
    fetchText(srcBlobUrl(id, "pr/diff.patch")),
  ]);

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

  const system =
    "You are a guide for one specific pull request. Answer questions ONLY from the provided PR " +
    "context (its diff, tour, and narration). Your tone is a comprehension guide helping a reader " +
    "understand what the change does and why. If the answer is not in the diff or context, say so " +
    "plainly. Never give a review verdict, never hunt for bugs, and do not use em dashes.\n\n" +
    `PR context:\n${context}`;

  const client = new Anthropic();
  let answer: string;
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system,
      messages: [
        ...history.map((t) => ({ role: t.role, content: t.content })),
        { role: "user" as const, content: question },
      ],
    });
    answer = res.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("")
      .trim();
  } catch (e) {
    return bad(502, `ask failed: ${(e as Error).message}`);
  }

  return Response.json({ answer, usage: { remainingToday } });
}
