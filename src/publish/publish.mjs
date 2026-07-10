import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

// Resolve host/token from explicit args, then env, then ~/.spool.json.
async function resolveConfig({ host, token } = {}) {
  let cfg = {};
  const cfgPath = join(homedir(), ".spool.json");
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    } catch {
      /* ignore malformed config, fall through to env/args */
    }
  }
  const h = host || process.env.SPOOL_HOST || cfg.host;
  const t = token || process.env.SPOOL_PUBLISH_TOKEN || cfg.token;
  return { host: h && h.replace(/\/$/, ""), token: t };
}

// Single-PUT a local file straight to Blob storage with a server-minted scoped token.
// Bypasses the Vercel function body cap; the token pins pathname + content type.
async function uploadFile(path, { pathname, token, contentType }) {
  const bytes = await readFile(path);
  const res = await fetch(
    `https://blob.vercel-storage.com/?pathname=${encodeURIComponent(pathname)}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-version": "9",
        "x-content-type": contentType,
        "x-add-random-suffix": "0",
        "x-content-length": String(bytes.length),
      },
      body: bytes,
    }
  );
  if (!res.ok) {
    throw new Error(`blob upload failed for ${pathname}: ${res.status} ${await res.text().catch(() => "")}`);
  }
}

// Build the editable-source payload for the publish request (see EDIT-CONTRACT
// "Blob layout"). Small JSON artifacts (timeline/render/manifest/word-times) ride
// inline — the web writes them to spools/{id}/src/*; the big binaries (video.mp4,
// seg wavs) come back as client-upload grants. Returns null for dry/partial sessions
// (no editable set) so publishing never breaks — the spool is simply not editable.
async function buildSources(dir) {
  const has = (rel) => existsSync(join(dir, rel));
  if (!(has("video.mp4") && has("timeline.json") && has("vo/manifest.json"))) return null;
  const rj = async (rel) => JSON.parse(await readFile(join(dir, rel), "utf8"));
  const manifest = await rj("vo/manifest.json");
  const words = {};
  const segments = [];
  for (const seg of manifest.segments || []) {
    const nn = String(seg.i).padStart(2, "0");
    if (has(`vo/seg_${nn}.wav`)) segments.push(seg.i);
    if (has(`vo/seg_${nn}.words.json`)) words[String(seg.i)] = await rj(`vo/seg_${nn}.words.json`);
  }
  return {
    timeline: await rj("timeline.json"),
    render: has("render.json") ? await rj("render.json") : { rate: 1 },
    vo: { manifest, words },
    segments,
    hasVideo: true,
  };
}

// Map a returned upload grant to its local file. Source grants (spools/{id}/src/*)
// resolve against the workdir; published grants (l/{id}/*) against final.mp4/share.
function grantLocalPath(pathname, { dir, shareDir, finalMp4 }) {
  if (pathname.includes("/src/")) return join(dir, pathname.replace(/^spools\/[^/]+\/src\//, ""));
  const rel = pathname.replace(/^l\/[^/]+\//, "");
  return rel === "final.mp4" ? finalMp4 : join(shareDir, rel);
}

/**
 * Publish a built spool's share bundle to the spool web app.
 * Returns the watch URL. Requires `spool share` to have run first.
 */
export async function publishSpool(workdir, opts = {}) {
  const dir = resolve(workdir);
  const shareDir = join(dir, "share");
  const spoolJson = join(shareDir, "spool.json");
  const finalMp4 = join(dir, "final.mp4");

  if (!existsSync(spoolJson)) {
    throw new Error(`no share bundle at ${shareDir} — run \`spool share ${workdir}\` first`);
  }
  if (!existsSync(finalMp4)) {
    throw new Error(`no final.mp4 in ${dir} — run \`spool render\` first`);
  }

  const { host, token } = await resolveConfig(opts);
  if (!host || !token) {
    throw new Error(
      "missing host/token — set SPOOL_HOST + SPOOL_PUBLISH_TOKEN (env), pass { host, token }, or write ~/.spool.json"
    );
  }

  const spool = JSON.parse(await readFile(spoolJson, "utf8"));
  const transcriptPath = join(shareDir, "transcript.txt");
  const consolePath = join(shareDir, "console.jsonl");
  const sources = await buildSources(dir); // null ⇒ dry/partial session, not editable
  const meta = {
    spool,
    transcript: existsSync(transcriptPath) ? await readFile(transcriptPath, "utf8") : "",
    console: existsSync(consolePath) ? await readFile(consolePath, "utf8") : "",
    ...(sources ? { sources } : {}),
  };

  const res = await fetch(`${host}/api/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (!res.ok) {
    throw new Error(`publish failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`);
  }
  const { url, uploads } = await res.json();

  // One grant per big binary: published final.mp4/frames (l/<id>/*) plus source
  // video.mp4 + seg wavs (spools/<id>/src/*) when the spool was published editable.
  let sourceGrants = 0;
  for (const grant of uploads) {
    const path = grantLocalPath(grant.pathname, { dir, shareDir, finalMp4 });
    if (!existsSync(path)) throw new Error(`missing local file for ${grant.pathname} (${path})`);
    await uploadFile(path, grant);
    if (grant.pathname.includes("/src/")) sourceGrants++;
  }
  if (sources) console.error(`[publish] editable: uploaded sources (${sources.segments.length} vo seg[s], ${sourceGrants} binary grant[s])`);

  console.log(url);
  return url;
}

// Direct CLI: node src/publish/publish.mjs --workdir <dir> [--host <h>] [--token <t>]
const isMain = resolve(process.argv[1] || "") === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const val = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const workdir = val("--workdir") || args.find((a) => !a.startsWith("--"));
  if (!workdir) {
    console.error("usage: node src/publish/publish.mjs --workdir <dir> [--host <h>] [--token <t>]");
    process.exit(1);
  }
  publishSpool(workdir, { host: val("--host"), token: val("--token") })
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[publish] failed:", err.message);
      process.exit(1);
    });
}
