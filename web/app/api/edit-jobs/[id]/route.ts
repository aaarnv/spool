import { sql } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { db } from "../../../../db";
import { sendOpsAlert } from "../../../../lib/alerts";

export const runtime = "nodejs";

const LEASE_MINUTES = 20;

// Extract the claim's lease token from body or header. NULL (legacy jobs claimed
// before leases existed) is accepted for finalize so an in-flight pre-lease job
// can still complete.
function leaseOf(body: { leaseToken?: unknown }, req: Request): string | null {
  const b = typeof body.leaseToken === "string" ? body.leaseToken : null;
  return b || req.headers.get("x-lease-token") || null;
}

// Worker callback. status:running = heartbeat (extend the lease during a long
// render); done|error = finalize. All require the current lease token — a stale
// worker (whose job was reclaimed under a new token) gets 409. On done, revalidate
// the watch page cache tag.
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    return await finalize(req, id);
  } catch (e) {
    await sendOpsAlert("edit-job route failed", `job=${id} ${(e as Error).message}`, {
      key: `edit-job:${id}`,
    });
    return Response.json({ error: "internal error" }, { status: 500 });
  }
}

async function finalize(req: Request, id: string) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const secret = process.env.EDIT_WORKER_SECRET;
  if (!secret) return Response.json({ error: "worker secret not configured" }, { status: 500 });
  if (bearer !== secret) return Response.json({ error: "unauthorized" }, { status: 401 });

  let body: { status?: string; error?: string; leaseToken?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected json body" }, { status: 400 });
  }
  const lease = leaseOf(body, req);

  // Heartbeat: extend the lease, strict token match (only live workers heartbeat).
  if (body.status === "running") {
    const r = await db.execute(sql`
      UPDATE edit_jobs
      SET lease_expires_at = now() + ${sql.raw(`interval '${LEASE_MINUTES} minutes'`)}, updated_at = now()
      WHERE id = ${id} AND status = 'running' AND lease_token = ${lease}
      RETURNING id
    `);
    const n = ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as unknown[];
    if (!n.length) return Response.json({ error: "lease lost" }, { status: 409 });
    return Response.json({ ok: true });
  }

  if (body.status !== "done" && body.status !== "error")
    return Response.json({ error: "status must be running|done|error" }, { status: 400 });

  // Finalize: token match OR a legacy NULL lease (pre-lease in-flight job).
  const r = await db.execute(sql`
    UPDATE edit_jobs
    SET status = ${body.status},
        error = ${body.status === "error" ? (body.error || "unknown error").slice(0, 2000) : null},
        finished_at = now(), updated_at = now()
    WHERE id = ${id} AND status = 'running' AND (lease_token = ${lease} OR lease_token IS NULL)
    RETURNING spool_id
  `);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as { spool_id: string }[];
  if (!rows.length) return Response.json({ error: "job not running or lease lost" }, { status: 409 });

  if (body.status === "error") {
    await sendOpsAlert("edit job failed", `job=${id} ${body.error || "unknown error"}`, {
      key: `edit-job:${id}`,
    });
  }
  if (body.status === "done") revalidateTag(`spool:${rows[0].spool_id}`);
  return Response.json({ id, status: body.status });
}
