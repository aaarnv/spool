import { runCanary } from "../../../lib/canary";

export const runtime = "nodejs";

// Vercel cron (vercel.json, offset from the wake cron). Authed by CRON_SECRET when
// set (Vercel sends it as a bearer), else the worker secret; open if neither is set.
export async function GET(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const allowed = [process.env.CRON_SECRET, process.env.EDIT_WORKER_SECRET].filter(Boolean);
  if (allowed.length && !allowed.includes(bearer)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const { ok, checks } = await runCanary();
  return Response.json({ ok, checks }, { status: ok ? 200 : 500 });
}
