// Shape of spool.json (see CONTRACTS.md "share/ bundle"). On the server we rewrite
// `video` and each step's `frame` from bundle-relative paths to blob URLs before storing.
export type SpoolStep = {
  i: number;
  name: string;
  narration: string;
  start: number;
  end: number;
  clicks: { x: number; y: number; t: number }[];
  frame: string;
};

// A single tour stop of a PR guide. `step` indexes into Spool.steps (the video
// anchor) or is null when the stop is prose+diff only; `hunks` are positional
// indices within this file's section of the snapshotted diff.patch.
export type TourStop = {
  id: string;
  heading: string;
  prose: string;
  files: { path: string; hunks?: number[] }[];
  step: number | null;
};

export type SpoolPr = {
  number: number;
  url: string;
  title: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  mode: string | null;
  stops: TourStop[];
};

export type Spool = {
  version: number;
  kind: string;
  title: string | null;
  url: string | null;
  video: string;
  duration: number;
  rate?: number;
  voice?: { engine: string | null; voice: string | null };
  steps: SpoolStep[];
  console?: { errors: number; warnings: number; log: string };
  pr?: SpoolPr;
};

// Public base URL of the Blob store, e.g. https://<id>.public.blob.vercel-storage.com
// Set at deploy time; used to fetch a spool's stored artifacts by id without SDK auth.
export const BLOB_BASE = (process.env.SPOOL_BLOB_BASE || "").replace(/\/$/, "");

export const blobUrl = (id: string, name: string) => `${BLOB_BASE}/l/${id}/${name}`;

// PR-guide source artifacts (diff.patch, pr.json, tour.json) live under a flat
// src/ prefix, separate from the public l/{id}/ watch artifacts.
export const srcBlobUrl = (id: string, name: string) => `${BLOB_BASE}/spools/${id}/src/${name}`;

export function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
