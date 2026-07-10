import { put } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { randomBytes } from "node:crypto";
import { BLOB_BASE, blobUrl, type Spool } from "../../spool";
import { db } from "../../../db";
import { spools as spoolsTable } from "../../../db/schema";
import { resolveOwner } from "../../../db/owner";

export const runtime = "nodejs";

// Vercel caps a function's request body at ~4.5MB, so the video (and keyframes) can't
// flow through here. Instead the CLI sends only the small metadata; this route writes
// the authoritative spool.json/transcript/console itself, then hands the CLI scoped,
// short-lived client tokens to PUT the big files straight to Blob storage. Blob URLs
// are deterministic (addRandomSuffix:false), so we can rewrite spool.json up front.
const MAX_STEPS = 200;
const UPLOAD_TTL_MS = 15 * 60 * 1000;

const bad = (status: number, error: string) =>
  new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });

// 22-char base64url id from 16 random bytes: unguessable, URL-safe, no padding.
const newId = () => randomBytes(16).toString("base64url");

// Optional render sources (EDIT-CONTRACT.md §Blob layout). Small JSON artifacts
// ride inline in this request and are written server-side; the big binaries
// (source video + per-segment wavs) get scoped client-upload grants like final.mp4.
type Sources = {
  timeline: unknown;
  render: unknown;
  vo?: { manifest: unknown; words?: Record<string, unknown> };
  segments?: number[]; // seg indices needing a seg_NN.wav upload grant
  hasVideo?: boolean; // default true — grant a src/video.mp4 upload
  hasBg?: boolean; // grant a src/bg.jpg upload (the resolved canvas image)
};

type Body = { spool: Spool; transcript?: string; console?: string; sources?: Sources; hasPreview?: boolean };

const segName = (n: number) => `seg_${String(n).padStart(2, "0")}`;

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return bad(401, "unauthorized");
  const ownerId = await resolveOwner(bearer);
  if (!ownerId) return bad(401, "unauthorized");
  if (!BLOB_BASE) return bad(500, "SPOOL_BLOB_BASE not configured");

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return bad(400, "expected json body");
  }
  const spool = body?.spool;
  if (!spool || !Array.isArray(spool.steps)) return bad(400, "missing spool");
  if (spool.steps.length > MAX_STEPS) return bad(413, "too many steps");

  const id = newId();
  const frameName = (i: number) => `frames/step_${String(i).padStart(2, "0")}.png`;

  // Rewrite bundle-relative paths to the final (deterministic) blob URLs.
  spool.video = blobUrl(id, "final.mp4");
  const grants: { pathname: string; token: string; contentType: string }[] = [
    {
      pathname: `l/${id}/final.mp4`,
      contentType: "video/mp4",
      token: await mintToken(`l/${id}/final.mp4`, "video/mp4"),
    },
  ];
  for (const step of spool.steps) {
    const rel = frameName(step.i);
    step.frame = blobUrl(id, rel);
    grants.push({
      pathname: `l/${id}/${rel}`,
      contentType: "image/png",
      token: await mintToken(`l/${id}/${rel}`, "image/png"),
    });
  }

  // preview.gif (optional; older CLIs don't send it): embeddable animated preview
  // for PR comments etc. Granted like frames; URL returned so the CLI can embed it.
  let previewUrl: string | null = null;
  if (body.hasPreview) {
    const p = `l/${id}/preview.gif`;
    grants.push({ pathname: p, contentType: "image/gif", token: await mintToken(p, "image/gif") });
    previewUrl = blobUrl(id, "preview.gif");
  }

  // Small, authoritative files written server-side (all well under the body cap).
  const write = (name: string, data: string, contentType: string) =>
    put(`l/${id}/${name}`, data, { access: "public", addRandomSuffix: false, contentType });
  const writes = [
    write("spool.json", JSON.stringify(spool, null, 2), "application/json"),
    write("transcript.txt", body.transcript ?? "", "text/plain"),
    write("console.jsonl", body.console ?? "", "application/x-ndjson"),
  ];

  // Render sources (optional): write the JSON artifacts here, grant uploads for
  // the binaries. Absence leaves this an old-style, non-editable publish.
  const src = body.sources;
  const hasSources = !!src;
  if (src) {
    const writeSrc = (name: string, data: string, contentType: string) =>
      put(`spools/${id}/src/${name}`, data, { access: "public", addRandomSuffix: false, contentType });
    writes.push(writeSrc("timeline.json", JSON.stringify(src.timeline ?? null), "application/json"));
    writes.push(writeSrc("render.json", JSON.stringify(src.render ?? null), "application/json"));
    if (src.vo) {
      writes.push(writeSrc("vo/manifest.json", JSON.stringify(src.vo.manifest ?? null), "application/json"));
      for (const [seg, words] of Object.entries(src.vo.words ?? {})) {
        writes.push(writeSrc(`vo/${segName(Number(seg))}.words.json`, JSON.stringify(words), "application/json"));
      }
    }
    if (src.hasVideo !== false) {
      const p = `spools/${id}/src/video.mp4`;
      grants.push({ pathname: p, contentType: "video/mp4", token: await mintToken(p, "video/mp4") });
    }
    if (src.hasBg) {
      const p = `spools/${id}/src/bg.jpg`;
      grants.push({ pathname: p, contentType: "image/jpeg", token: await mintToken(p, "image/jpeg") });
    }
    for (const seg of src.segments ?? []) {
      const p = `spools/${id}/src/vo/${segName(seg)}.wav`;
      grants.push({ pathname: p, contentType: "audio/wav", token: await mintToken(p, "audio/wav") });
    }
  }
  await Promise.all(writes);

  // Index the spool for its owner's dashboard.
  await db.insert(spoolsTable).values({
    id,
    ownerId,
    title: spool.title ?? null,
    duration: spool.duration ?? null,
    hasSources,
  });

  const origin = new URL(req.url).origin;
  return Response.json({ id, url: `${origin}/l/${id}`, uploads: grants, ...(previewUrl ? { previewUrl } : {}) });
}

function mintToken(pathname: string, contentType: string) {
  return generateClientTokenFromReadWriteToken({
    pathname,
    addRandomSuffix: false,
    allowedContentTypes: [contentType],
    validUntil: Date.now() + UPLOAD_TTL_MS,
  });
}
