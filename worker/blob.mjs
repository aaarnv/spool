// Blob I/O for the worker. Sources are public (store access: public) so we GET them
// by deterministic URL — no token. Outputs are written with per-job client-upload
// grants minted by the web (Authorization: Bearer <clientToken>), mirroring the
// CLI publish PUT in src/publish/publish.mjs. The worker holds no standing Blob token.
import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const API = process.env.VERCEL_BLOB_API_URL || "https://blob.vercel-storage.com";
const API_VERSION = "9"; // matches publish.mjs's PUT calls

// Fetch a public blob URL to a local path (creates parent dirs).
export async function downloadTo(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`blob download ${res.status} for ${url}`);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, Buffer.from(await res.arrayBuffer()));
}

// Single-PUT a buffer to Blob with a server-minted scoped client token (pins the
// pathname + content type; deterministic URL via addRandomSuffix off).
export async function uploadViaGrant(buf, { pathname, token, contentType }) {
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
