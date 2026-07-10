import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../../../../db";
import { editJobs } from "../../../../../../db/schema";
import { validateOps } from "../../../../../../lib/editOps";
import { requireOwnedSpool, fetchSpoolJson, jsonError } from "../../../../../../lib/spoolAccess";
import { wakeWorker } from "../../../../../../lib/flyWake";

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

  // The pre-check races with a concurrent confirm; the partial unique index
  // (edit_jobs_one_active_per_spool) is the real guard — the loser hits 23505.
  let job: { id: string; status: string };
  try {
    [job] = await db
      .insert(editJobs)
      .values({
        spoolId: id,
        status: "queued",
        instruction: (body.instruction || "").slice(0, 2000),
        ops: valid.ops,
      })
      .returning({ id: editJobs.id, status: editJobs.status });
  } catch (e) {
    const code = (e as { code?: string; cause?: { code?: string } })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
    if (code === "23505") return jsonError(409, "an edit is already in progress for this spool");
    throw e;
  }

  await wakeWorker(); // nudge the (possibly stopped) Fly machine to start polling

  return Response.json({ id: job.id, status: job.status });
}
