import { eq } from "drizzle-orm";
import { db } from "./index";
import { publishTokens } from "./schema";
import { hashToken } from "./tokens";

// Legacy global env token maps to this synthetic owner; per-user spk_ tokens
// resolve via their stored SHA-256 hash.
export const LEGACY_OWNER = "aarnav-cli";

// Resolve a bearer token to its owner id, or null if it matches nothing.
export async function resolveOwner(bearer: string): Promise<string | null> {
  const legacy = process.env.SPOOL_PUBLISH_TOKEN;
  if (legacy && bearer === legacy) return LEGACY_OWNER;
  const rows = await db
    .select({ ownerId: publishTokens.ownerId })
    .from(publishTokens)
    .where(eq(publishTokens.tokenHash, hashToken(bearer)))
    .limit(1);
  return rows[0]?.ownerId ?? null;
}
