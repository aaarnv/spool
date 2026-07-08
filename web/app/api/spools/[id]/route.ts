import { auth } from "@clerk/nextjs/server";
import { del, list } from "@vercel/blob";
import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { db } from "../../../../db";
import { spools as spoolsTable } from "../../../../db/schema";

export const runtime = "nodejs";

// Delete one of the caller's spools: verify ownership, remove every blob under
// l/<id>/, then drop the index row. 404 if it isn't the caller's spool.
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const rows = await db
    .select({ id: spoolsTable.id })
    .from(spoolsTable)
    .where(and(eq(spoolsTable.id, id), eq(spoolsTable.ownerId, userId)))
    .limit(1);
  if (!rows.length) return Response.json({ error: "not found" }, { status: 404 });

  const { blobs } = await list({ prefix: `l/${id}/` });
  if (blobs.length) await del(blobs.map((b) => b.url));
  await db.delete(spoolsTable).where(eq(spoolsTable.id, id));

  // The watch page force-caches spool.json; drop its cached render so /l/<id> 404s.
  revalidatePath(`/l/${id}`);
  return Response.json({ ok: true });
}
