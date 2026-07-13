import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { projectKnowledge } from "../db/schema";
import { emptyStore, parseStore, type KnowledgeStore } from "./knowledgeOps";

// The project knowledge store lives in Postgres (project_knowledge, composite
// PK ownerId+repoOwner+repoName). It is mutable read-modify-write state, so it
// cannot live behind Blob's CDN: in-place overwrites serve stale reads and the
// public URLs reject cache-busting query params. owner/repo lowercased by callers.

// Read the current store. Any failure (absent row, malformed jsonb) degrades to
// an empty store so callers never throw on a miss.
export async function fetchKnowledge(ownerId: string, owner: string, repo: string): Promise<KnowledgeStore> {
  try {
    const [row] = await db
      .select({ store: projectKnowledge.store })
      .from(projectKnowledge)
      .where(
        and(
          eq(projectKnowledge.ownerId, ownerId),
          eq(projectKnowledge.repoOwner, owner),
          eq(projectKnowledge.repoName, repo)
        )
      )
      .limit(1);
    if (!row) return emptyStore();
    return parseStore(JSON.stringify(row.store));
  } catch {
    return emptyStore();
  }
}

export async function putKnowledge(ownerId: string, owner: string, repo: string, store: KnowledgeStore) {
  await db
    .insert(projectKnowledge)
    .values({ ownerId, repoOwner: owner, repoName: repo, store, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [projectKnowledge.ownerId, projectKnowledge.repoOwner, projectKnowledge.repoName],
      set: { store, updatedAt: new Date() },
    });
}

// Server-authoritative project identity: parse owner/repo/pr out of the PR url
// (never trust client-computed fields). null on any miss. owner/repo lowercased.
export function parseProjectRef(info: unknown): { owner: string; repo: string; pr: number } | null {
  const url = (info as { url?: unknown })?.url;
  if (typeof url !== "string") return null;
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!m) return null;
  const num = (info as { number?: unknown })?.number;
  const pr = Number.isInteger(num) ? (num as number) : Number(m[3]);
  if (!Number.isInteger(pr) || pr <= 0) return null;
  return { owner: m[1].toLowerCase(), repo: m[2].toLowerCase(), pr };
}
