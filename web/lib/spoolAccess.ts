import { auth } from "@clerk/nextjs/server";
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { spools as spoolsTable } from "../db/schema";
import { blobUrl, type Spool } from "../app/spool";

export const jsonError = (status: number, error: string) =>
  Response.json({ error }, { status });

// Resolve the caller's Clerk session to one of their spools. 401 when signed
// out, 404 when the spool isn't theirs (don't leak existence).
export async function requireOwnedSpool(
  id: string
): Promise<{ userId: string; row: typeof spoolsTable.$inferSelect } | { error: Response }> {
  const { userId } = await auth();
  if (!userId) return { error: jsonError(401, "unauthorized") };
  const rows = await db
    .select()
    .from(spoolsTable)
    .where(and(eq(spoolsTable.id, id), eq(spoolsTable.ownerId, userId)))
    .limit(1);
  if (!rows.length) return { error: jsonError(404, "not found") };
  return { userId, row: rows[0] };
}

// Blob content is immutable per id; the spool.json holds the authoritative steps.
export async function fetchSpoolJson(id: string): Promise<Spool | null> {
  try {
    const res = await fetch(blobUrl(id, "spool.json"), { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as Spool;
  } catch {
    return null;
  }
}
