import { sql } from "drizzle-orm";
import { put, del } from "@vercel/blob";
import { db } from "../db";
import { sendOpsAlert } from "./alerts";

// Uptime + publish-path canary. Each check catches its own errors and reports a
// short status string; a failure alerts (throttled per check) and fails the whole.
const TIMEOUT_MS = 5000;

function withTimeout<T>(p: Promise<T>, ms = TIMEOUT_MS): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
  ]);
}

async function checkDb(): Promise<string> {
  try {
    await withTimeout(db.execute(sql`select 1`));
    return "ok";
  } catch (e) {
    return `fail: ${(e as Error).message}`;
  }
}

async function checkBlob(): Promise<string> {
  if (!process.env.BLOB_READ_WRITE_TOKEN) return "skipped";
  try {
    const { url } = await withTimeout(
      put("canary/ping.txt", `canary ${Date.now()}`, { access: "public", addRandomSuffix: false })
    );
    const res = await withTimeout(fetch(url, { cache: "no-store" }));
    if (!res.ok) throw new Error(`fetch ${res.status}`);
    await withTimeout(del(url));
    return "ok";
  } catch (e) {
    return `fail: ${(e as Error).message}`;
  }
}

async function httpCheck(url: string): Promise<string> {
  try {
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok ? "ok" : `fail: status ${res.status}`;
  } catch (e) {
    return `fail: ${(e as Error).message}`;
  }
}

export async function runCanary(): Promise<{ ok: boolean; checks: Record<string, string> }> {
  const slug = process.env.CANARY_WATCH_SLUG || "q8wrobTGa5JW8wBpggaQLA";
  const checks: Record<string, string> = {
    db: await checkDb(),
    blob: await checkBlob(),
    site: await httpCheck("https://spoolkit.dev/"),
    watch: await httpCheck(`https://spoolkit.dev/l/${slug}`),
  };

  let ok = true;
  for (const [name, status] of Object.entries(checks)) {
    if (status.startsWith("fail")) {
      ok = false;
      await sendOpsAlert(`canary: ${name} check failed`, status, { key: `canary:${name}` });
    }
  }
  return { ok, checks };
}
