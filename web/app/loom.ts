// Shape of loom.json (see CONTRACTS.md "share/ bundle"). On the server we rewrite
// `video` and each step's `frame` from bundle-relative paths to blob URLs before storing.
export type LoomStep = {
  i: number;
  name: string;
  narration: string;
  start: number;
  end: number;
  clicks: { x: number; y: number; t: number }[];
  frame: string;
};

export type Loom = {
  version: number;
  kind: string;
  title: string | null;
  url: string | null;
  video: string;
  duration: number;
  rate?: number;
  voice?: { engine: string | null; voice: string | null };
  steps: LoomStep[];
  console?: { errors: number; warnings: number; log: string };
};

// Public base URL of the Blob store, e.g. https://<id>.public.blob.vercel-storage.com
// Set at deploy time; used to fetch a loom's stored artifacts by id without SDK auth.
export const BLOB_BASE = (process.env.LOOM_BLOB_BASE || "").replace(/\/$/, "");

export const blobUrl = (id: string, name: string) => `${BLOB_BASE}/l/${id}/${name}`;

export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
