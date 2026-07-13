import { put } from "@vercel/blob";
import { BLOB_BASE } from "../app/spool";
import { emptyStore, parseStore, type KnowledgeStore } from "./knowledgeOps";

// Blob storage for a project's shared knowledge store. Keyed by (publisher
// ownerId, repo owner, repo name); owner/repo are lowercased by the caller.
export const knowledgePath = (ownerId: string, owner: string, repo: string) =>
  `projects/${ownerId}/${owner}/${repo}/knowledge.json`;

export const knowledgeUrl = (ownerId: string, owner: string, repo: string) =>
  `${BLOB_BASE}/${knowledgePath(ownerId, owner, repo)}`;

// Read the current store from its public URL. Any failure (absent, network,
// malformed) degrades to an empty store so callers never throw on a miss.
export async function fetchKnowledge(ownerId: string, owner: string, repo: string): Promise<KnowledgeStore> {
  try {
    const res = await fetch(knowledgeUrl(ownerId, owner, repo), { cache: "no-store" });
    if (!res.ok) return emptyStore();
    return parseStore(await res.text());
  } catch {
    return emptyStore();
  }
}

// Overwrite the store in place. addRandomSuffix:false makes the URL deterministic
// so fetchKnowledge can read it back without SDK auth.
export async function putKnowledge(ownerId: string, owner: string, repo: string, store: KnowledgeStore) {
  await put(knowledgePath(ownerId, owner, repo), JSON.stringify(store, null, 2), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
  });
}
