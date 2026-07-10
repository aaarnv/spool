import { sql } from "drizzle-orm";
import { db } from "../../../../db";

export const runtime = "nodejs";

const LEASE_MINUTES = 20;
const MAX_ATTEMPTS = 3;

// Worker poll. First retires jobs that have burned all attempts (a running lease
// that expired for the MAX_ATTEMPTS'th time), then atomically claims the oldest
// eligible job — queued OR a running job whose lease expired (crashed worker) —
// stamping a fresh lease so a stale worker can't clobber it. FOR UPDATE SKIP LOCKED
// keeps concurrent workers on distinct rows.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const secret = process.env.EDIT_WORKER_SECRET;
  if (!secret) return Response.json({ error: "worker secret not configured" }, { status: 500 });
  if (bearer !== secret) return Response.json({ error: "unauthorized" }, { status: 401 });

  // Retire exhausted jobs (expired lease + no attempts left).
  await db.execute(sql`
    UPDATE edit_jobs
    SET status = 'error', error = ${`render failed after ${MAX_ATTEMPTS} attempts`},
        finished_at = now(), updated_at = now()
    WHERE status = 'running' AND lease_expires_at < now() AND attempts >= ${MAX_ATTEMPTS}
  `);

  const result = await db.execute(sql`
    UPDATE edit_jobs SET
      status = 'running',
      attempts = attempts + 1,
      lease_token = gen_random_uuid(),
      lease_expires_at = now() + ${sql.raw(`interval '${LEASE_MINUTES} minutes'`)},
      started_at = COALESCE(started_at, now()),
      updated_at = now()
    WHERE id = (
      SELECT id FROM edit_jobs
      WHERE (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
        AND attempts < ${MAX_ATTEMPTS}
      ORDER BY created_at
      FOR UPDATE SKIP LOCKED
      LIMIT 1
    )
    RETURNING id, spool_id, ops, lease_token, attempts
  `);
  const rows = (result as unknown as { rows?: unknown[] }).rows ?? (result as unknown as unknown[]);
  const row = Array.isArray(rows)
    ? (rows[0] as { id: string; spool_id: string; ops: unknown; lease_token: string; attempts: number } | undefined)
    : undefined;
  if (!row) return new Response(null, { status: 204 });

  return Response.json({
    job: { id: row.id, spoolId: row.spool_id, ops: row.ops, leaseToken: row.lease_token, attempts: row.attempts },
  });
}
