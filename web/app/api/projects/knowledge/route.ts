import { auth } from "@clerk/nextjs/server";
import { resolveOwner } from "../../../../db/owner";
import { fetchKnowledge, putKnowledge } from "../../../../lib/knowledge";
import { validateKnowledgeOps, applyKnowledgeOps } from "../../../../lib/knowledgeOps";

export const runtime = "nodejs";

// Read a project's shared knowledge store. The CLI authenticates with its spk
// token; the server resolves ownerId (the CLI never learns it) and returns the
// store (empty when absent). owner/repo come from the client but only scope a
// read within the authenticated owner's namespace.
const bad = (status: number, error: string) => Response.json({ error }, { status });
const SEG = /^[A-Za-z0-9._-]{1,100}$/;

export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return bad(401, "unauthorized");
  const ownerId = await resolveOwner(bearer);
  if (!ownerId) return bad(401, "unauthorized");

  const url = new URL(req.url);
  const owner = url.searchParams.get("owner") || "";
  const repo = url.searchParams.get("repo") || "";
  if (!SEG.test(owner) || owner === ".." || !SEG.test(repo) || repo === "..")
    return bad(400, "invalid owner or repo");

  const knowledge = await fetchKnowledge(ownerId, owner.toLowerCase(), repo.toLowerCase());
  return Response.json({ knowledge });
}

// Owner-authenticated store mutation from the dashboard project page. Clerk-authed
// (not spk token): a project only exists under the caller's own userId namespace,
// so scoping to userId is the ownership check. Ops carry pr:0 (manual-edit sentinel).
export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return bad(401, "unauthorized");

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return bad(400, "invalid json");
  }
  const { owner, repo, ops } = (body ?? {}) as { owner?: unknown; repo?: unknown; ops?: unknown };
  if (typeof owner !== "string" || !SEG.test(owner) || owner === ".." || typeof repo !== "string" || !SEG.test(repo) || repo === "..")
    return bad(400, "invalid owner or repo");

  const parsed = validateKnowledgeOps(ops);
  if (!parsed.ok) return bad(400, parsed.error);

  const lowerOwner = owner.toLowerCase();
  const lowerRepo = repo.toLowerCase();
  const store = await fetchKnowledge(userId, lowerOwner, lowerRepo);
  const date = new Date().toISOString().slice(0, 10);
  const { store: next, applied, skipped } = applyKnowledgeOps(store, parsed.ops, { pr: 0, date });
  await putKnowledge(userId, lowerOwner, lowerRepo, next);
  return Response.json({ knowledge: next, applied, skipped: skipped.length });
}
