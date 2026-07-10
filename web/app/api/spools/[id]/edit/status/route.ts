import { desc, eq } from "drizzle-orm";
import { db } from "../../../../../../db";
import { editJobs } from "../../../../../../db/schema";
import { requireOwnedSpool } from "../../../../../../lib/spoolAccess";

export const runtime = "nodejs";

// Owner-only. Latest job for this spool (or null), for the watch-page poll.
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireOwnedSpool(id);
  if ("error" in gate) return gate.error;

  const [job] = await db
    .select({ id: editJobs.id, status: editJobs.status, error: editJobs.error })
    .from(editJobs)
    .where(eq(editJobs.spoolId, id))
    .orderBy(desc(editJobs.createdAt))
    .limit(1);

  return Response.json({ job: job ?? null });
}
