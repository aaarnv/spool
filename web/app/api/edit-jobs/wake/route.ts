import { sql } from "drizzle-orm";
import { db } from "../../../../db";
import { wakeWorker } from "../../../../lib/flyWake";

export const runtime = "nodejs";

// Safety net (vercel.json cron, every 10min): if a job has sat queued > 60s the
// confirm-time wake was missed or the worker died mid-idle — nudge it. Authed by
// Vercel's CRON_SECRET when set (Vercel sends it as a bearer), else the worker
// secret; open only if neither is configured.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const allowed = [process.env.CRON_SECRET, process.env.EDIT_WORKER_SECRET].filter(Boolean);
  if (allowed.length && !allowed.includes(bearer)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const r = await db.execute(sql`
    SELECT count(*)::int AS n FROM edit_jobs
    WHERE status = 'queued' AND created_at < now() - interval '60 seconds'
  `);
  const rows = ((r as unknown as { rows?: unknown[] }).rows ?? (r as unknown as unknown[])) as { n: number }[];
  const stale = rows[0]?.n ?? 0;
  if (stale > 0) await wakeWorker();
  return Response.json({ stale, woke: stale > 0 });
}
