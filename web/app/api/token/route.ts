import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import { publishTokens } from "../../../db/schema";
import { hashToken, newToken } from "../../../db/tokens";

export const runtime = "nodejs";

// Generate (or regenerate) the caller's publish token. The raw token is returned
// exactly once here; only its hash is stored. Regenerating drops prior tokens.
export async function POST() {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "unauthorized" }, { status: 401 });

  await db.delete(publishTokens).where(eq(publishTokens.ownerId, userId));
  const raw = newToken();
  await db.insert(publishTokens).values({
    tokenHash: hashToken(raw),
    ownerId: userId,
    label: "dashboard",
  });

  return Response.json({ token: raw });
}
