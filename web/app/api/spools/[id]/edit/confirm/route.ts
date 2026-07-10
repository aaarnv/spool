import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../../../../db";
import { editJobs } from "../../../../../../db/schema";
import { validateOps } from "../../../../../../lib/editOps";
import { requireOwnedSpool, fetchSpoolJson, jsonError } from "../../../../../../lib/spoolAccess";

export const runtime = "nodejs";

// Owner-only. Re-validates the ops against the CURRENT step count and enqueues a
// job. One active (queued|running) job per spool — 409 otherwise.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwnedSpool(id);
  if ("error" in gate) return gate.error;
  if (!gate.row.hasSources) return jsonError(400, "spool has no sources; re-publish to enable editing");

  let body: { ops?: unknown; instruction?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError(400, "expected json body");
  }

  const spool = await fetchSpoolJson(id);
  if (!spool) return jsonError(404, "spool data unavailable");

  const valid = validateOps(body.ops, spool.steps.length);
  if (!valid.ok) return jsonError(400, valid.error);

  const active = await db
    .select({ id: editJobs.id })
    .from(editJobs)
    .where(and(eq(editJobs.spoolId, id), inArray(editJobs.status, ["queued", "running"])))
    .limit(1);
  if (active.length) return jsonError(409, "an edit is already in progress for this spool");

  const [job] = await db
    .insert(editJobs)
    .values({
      spoolId: id,
      status: "queued",
      instruction: (body.instruction || "").slice(0, 2000),
      ops: valid.ops,
    })
    .returning({ id: editJobs.id, status: editJobs.status });

  return Response.json({ id: job.id, status: job.status });
}
