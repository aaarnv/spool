import { eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { db } from "../../../../db";
import { editJobs } from "../../../../db/schema";

export const runtime = "nodejs";

// Worker completion callback. done → revalidate the watch page's cache tag so the
// re-rendered final.mp4/spool.json are served fresh; error → store the reason.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const secret = process.env.EDIT_WORKER_SECRET;
  if (!secret) return Response.json({ error: "worker secret not configured" }, { status: 500 });
  if (bearer !== secret) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: { status?: string; error?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected json body" }, { status: 400 });
  }
  if (body.status !== "done" && body.status !== "error")
    return Response.json({ error: "status must be done|error" }, { status: 400 });

  const [job] = await db
    .update(editJobs)
    .set({
      status: body.status,
      error: body.status === "error" ? (body.error || "unknown error").slice(0, 2000) : null,
      updatedAt: new Date(),
    })
    .where(eq(editJobs.id, id))
    .returning({ id: editJobs.id, spoolId: editJobs.spoolId, status: editJobs.status });

  if (!job) return Response.json({ error: "not found" }, { status: 404 });

  if (job.status === "done") revalidateTag(`spool:${job.spoolId}`);
  return Response.json({ id: job.id, status: job.status });
}
