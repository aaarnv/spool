import { sql } from "drizzle-orm";
import { db } from "../../../../db";

export const runtime = "nodejs";

// Worker poll. Atomically claims the oldest queued job (flips it to running) and
// returns it, or 204 when the queue is empty. A single UPDATE…RETURNING with a
// FOR UPDATE SKIP LOCKED subselect makes concurrent workers claim distinct rows.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const secret = process.env.EDIT_WORKER_SECRET;
  if (!secret) return Response.json({ error: "worker secret not configured" }, { status: 500 });
  if (bearer !== secret) return Response.json({ error: "unauthorized" }, { status: 401 });

  const result = await db.execute(sql`
    UPDATE edit_jobs SET status = 'running', updated_at = now()
    WHERE id = (
      SELECT id FROM edit_jobs
      WHERE status = 'queued'
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, spool_id, ops
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const row = Array.isArray(rows) ? (rows[0] as { id: string; spool_id: string; ops: unknown } | undefined) : undefined;
  if (!row) return new Response(null, { status: 204 });

  return Response.json({ job: { id: row.id, spoolId: row.spool_id, ops: row.ops } });
}
