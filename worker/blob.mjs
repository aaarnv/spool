// Minimal Vercel Blob REST client (no SDK dep — mirrors src/publish/publish.mjs's
// hand-rolled PUT). The worker holds a real read-write token, so it lists/downloads
// sources and overwrites the published final.mp4/spool.json/frames directly.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const API = process.env.VERCEL_BLOB_API_URL || "https://blob.vercel-storage.com";
const API_VERSION = "9"; // matches publish.mjs's PUT calls

// Enumerate every blob under a prefix. Returns [{ url, downloadUrl, pathname, size }].
export async function listBlobs(prefix, token) {
  const out = [];
  let cursor;
  do {
    const qs = new URLSearchParams({ prefix, limit: "1000" });
    if (cursor) qs.set("cursor", cursor);
    const res = await fetch(`${API}/?${qs}`, {
      headers: { authorization: `Bearer ${token}`, "x-api-version": API_VERSION },
    });
    if (!res.ok) throw new Error(`blob list ${res.status}: ${await res.text().catch(() => "")}`);
    const j = await res.json();
    out.push(...(j.blobs || []));
    cursor = j.hasMore ? j.cursor : null;
  } while (cursor);
  return out;
}

// Fetch a public blob URL to a local path (creates parent dirs).
export async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blob download ${res.status} for ${url}`);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// Overwrite a blob at a fixed pathname (addRandomSuffix off ⇒ deterministic URL).
export async function putBlob(pathname, buf, { token, contentType }) {
  const res = await fetch(`${API}/?pathname=${encodeURIComponent(pathname)}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "x-api-version": API_VERSION,
      "x-content-type": contentType,
      "x-add-random-suffix": "0",
      "x-content-length": String(buf.length),
    },
    body: buf,
  });
  if (!res.ok) throw new Error(`blob put ${pathname} ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json().catch(() => ({}));
}
