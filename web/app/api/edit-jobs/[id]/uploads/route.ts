import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { eq } from "drizzle-orm";
import { db } from "../../../../../db";
import { editJobs } from "../../../../../db/schema";

export const runtime = "nodejs";

// Worker output-upload grants. The Fly render worker holds no standing Blob token;
// after a re-render it asks here for short-lived client tokens to overwrite THIS
// spool's published artifacts, then PUTs them straight to Blob (bypassing the body
// cap, exactly like the CLI publish flow). Auth is the same worker secret as
// next/PATCH; paths are pinned to the running job's published spool prefix.
const UPLOAD_TTL_MS = 15 * 60 * 1000;
const MAX_PATHS = 300;

const contentTypeFor = (p: string) =>
  p.endsWith(".mp4") ? "video/mp4"
  : p.endsWith(".png") ? "image/png"
  : p.endsWith(".jsonl") ? "application/x-ndjson"
  : p.endsWith(".json") ? "application/json"
  : p.endsWith(".txt") ? "text/plain"
  : "application/octet-stream";

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const secret = process.env.EDIT_WORKER_SECRET;
  if (!secret) return Response.json({ error: "worker secret not configured" }, { status: 500 });
  if (bearer !== secret) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  let body: { paths?: unknown };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "expected json body" }, { status: 400 });
  }
  const paths = Array.isArray(body.paths) ? body.paths.filter((p): p is string => typeof p === "string") : null;
  if (!paths || paths.length === 0) return Response.json({ error: "paths required" }, { status: 400 });
  if (paths.length > MAX_PATHS) return Response.json({ error: "too many paths" }, { status: 413 });

  const [job] = await db
    .select({ spoolId: editJobs.spoolId, status: editJobs.status })
    .from(editJobs)
    .where(eq(editJobs.id, id));
  if (!job) return Response.json({ error: "not found" }, { status: 404 });
  if (job.status !== "running") return Response.json({ error: "job not running" }, { status: 409 });

  // Published artifacts live under l/{spoolId}/ (see app/spool.ts blobUrl). Pin every
  // grant there so a job can only overwrite its own spool's files.
  const prefix = `l/${job.spoolId}/`;
  for (const p of paths) {
    if (!p.startsWith(prefix) || p.includes("..")) {
      return Response.json({ error: `path outside spool prefix: ${p}` }, { status: 403 });
    }
  }

  const uploads = await Promise.all(
    paths.map(async (pathname) => {
      const contentType = contentTypeFor(pathname);
      const token = await generateClientTokenFromReadWriteToken({
        pathname,
        addRandomSuffix: false,
        allowedContentTypes: [contentType],
        validUntil: Date.now() + UPLOAD_TTL_MS,
      });
      return { pathname, contentType, token };
    })
  );
  return Response.json({ uploads });
}
