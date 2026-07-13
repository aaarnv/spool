import { resolveOwner } from "../../../../db/owner";
import { fetchKnowledge } from "../../../../lib/knowledge";

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
