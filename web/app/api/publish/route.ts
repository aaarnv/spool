import { put } from "@vercel/blob";
import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { randomBytes } from "node:crypto";
import { BLOB_BASE, blobUrl, type Spool } from "../../spool";

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

type Body = { spool: Spool; transcript?: string; console?: string };

export async function POST(req: Request) {
  const token = process.env.SPOOL_PUBLISH_TOKEN;
  const auth = req.headers.get("authorization") || "";
  if (!token || auth !== `Bearer ${token}`) return bad(401, "unauthorized");
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

  // Small, authoritative files written server-side (all well under the body cap).
  const write = (name: string, data: string, contentType: string) =>
    put(`l/${id}/${name}`, data, { access: "public", addRandomSuffix: false, contentType });
  await Promise.all([
    write("spool.json", JSON.stringify(spool, null, 2), "application/json"),
    write("transcript.txt", body.transcript ?? "", "text/plain"),
    write("console.jsonl", body.console ?? "", "application/x-ndjson"),
  ]);

  const origin = new URL(req.url).origin;
  return Response.json({ id, url: `${origin}/l/${id}`, uploads: grants });
}

function mintToken(pathname: string, contentType: string) {
  return generateClientTokenFromReadWriteToken({
    pathname,
    addRandomSuffix: false,
    allowedContentTypes: [contentType],
    validUntil: Date.now() + UPLOAD_TTL_MS,
  });
}
