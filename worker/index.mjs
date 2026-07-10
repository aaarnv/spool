// Spool edit render worker (Fly app `spool-render`). Polls the web for edit jobs,
// re-renders the spool from its published sources with the ops applied, and
// overwrites the published artifacts in Blob. See docs/EDIT-CONTRACT.md.
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps } from "./ops.mjs";
import { listBlobs, downloadTo, putBlob } from "./blob.mjs";
import { renderSpool } from "../src/render/render.mjs";
import { shareSpool } from "../src/share/share.mjs";
import { synthesizeSegment } from "../src/vo/tts.mjs";

const SPOOL_HOST = (process.env.SPOOL_HOST || "").replace(/\/$/, "");
const SECRET = process.env.EDIT_WORKER_SECRET || "";
const BLOB_TOKEN = process.env.BLOB_READ_WRITE_TOKEN || "";
const POLL_MS = 5000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 240);
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

const CT = { ".mp4": "video/mp4", ".png": "image/png", ".json": "application/json", ".txt": "text/plain", ".jsonl": "application/x-ndjson" };
const ctFor = (name) => CT[name.slice(name.lastIndexOf("."))] || "application/octet-stream";

// GET /api/edit-jobs/next → { job: { id, spoolId, ops } } | 204. Survives the
// web not being deployed yet (any non-200 ⇒ no job, keep polling).
async function claimNext() {
  const res = await fetch(`${SPOOL_HOST}/api/edit-jobs/next`, {
    headers: { authorization: `Bearer ${SECRET}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) {
    console.warn(`[worker] next → ${res.status} (${(await res.text().catch(() => "")).slice(0, 120)})`);
    return null;
  }
  const j = await res.json().catch(() => ({}));
  return j.job || (j.id ? j : null);
}

async function patchJob(id, body) {
  const res = await fetch(`${SPOOL_HOST}/api/edit-jobs/${id}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.warn(`[worker] patch ${id} ${body.status} → ${res.status}`);
}

async function processJob(job) {
  const { id, spoolId, ops } = job;
  console.log(`[worker] job ${id} spool ${spoolId} (${ops.length} op[s])`);
  const workdir = await mkdtemp(join(tmpdir(), `spool-edit-${spoolId}-`));
  try {
    // 1. Pull the immutable sources into a fresh workdir. The public blob origin is
    //    read off the source URLs so we can address the l/<id>/* published paths.
    const blobs = await listBlobs(`spools/${spoolId}/src/`, BLOB_TOKEN);
    if (!blobs.length) throw new Error(`no sources at spools/${spoolId}/src/`);
    const blobBase = new URL(blobs[0].url).origin;
    for (const b of blobs) {
      const rel = b.pathname.replace(`spools/${spoolId}/src/`, "");
      await downloadTo(b.downloadUrl || b.url, join(workdir, rel));
    }

    // 2. Apply ops to the loaded timeline + manifest.
    const timeline = await readJson(join(workdir, "timeline.json"));
    const manifest = await readJson(join(workdir, "vo", "manifest.json"));
    const publishedRate = existsSync(join(workdir, "render.json")) ? (await readJson(join(workdir, "render.json"))).rate ?? 1 : 1;
    const edited = applyOps({ timeline, manifest, ops });

    // 3. Re-TTS only the changed segments, then patch their fresh durations back in.
    for (const seg of edited.retts) {
      const fresh = await synthesizeSegment({ workdir, i: seg.i, name: seg.name, narration: seg.narration });
      const m = edited.manifest.segments.find((s) => s.i === seg.i);
      if (m) Object.assign(m, { wav: fresh.wav, words: fresh.words, duration: fresh.duration });
    }
    await writeFile(join(workdir, "timeline.json"), JSON.stringify(edited.timeline, null, 2));
    await writeFile(join(workdir, "vo", "manifest.json"), JSON.stringify(edited.manifest, null, 2));

    // 4. Re-render (windows recompute from the edited timeline+manifest) + re-share.
    const rate = edited.rate ?? publishedRate;
    await renderSpool({ workdir, rate });
    const shareDir = await shareSpool(workdir);

    // 5. Overwrite the published artifacts. spool.json's bundle-relative paths are
    //    rewritten to the deterministic l/<id>/* blob URLs (matching the publish route).
    const spool = await readJson(join(shareDir, "spool.json"));
    const lUrl = (name) => `${blobBase}/l/${spoolId}/${name}`;
    spool.video = lUrl("final.mp4");
    for (const s of spool.steps) s.frame = lUrl(`frames/step_${String(s.i).padStart(2, "0")}.png`);

    await putBlob(`l/${spoolId}/final.mp4`, await readFile(join(workdir, "final.mp4")), { token: BLOB_TOKEN, contentType: "video/mp4" });
    for (const f of await readdir(join(shareDir, "frames")).catch(() => [])) {
      await putBlob(`l/${spoolId}/frames/${f}`, await readFile(join(shareDir, "frames", f)), { token: BLOB_TOKEN, contentType: ctFor(f) });
    }
    await putBlob(`l/${spoolId}/spool.json`, Buffer.from(JSON.stringify(spool, null, 2)), { token: BLOB_TOKEN, contentType: "application/json" });
    for (const name of ["transcript.txt", "console.jsonl"]) {
      const p = join(shareDir, name);
      if (existsSync(p)) await putBlob(`l/${spoolId}/${name}`, await readFile(p), { token: BLOB_TOKEN, contentType: ctFor(name) });
    }
    console.log(`[worker] job ${id} done → ${lUrl("final.mp4")}`);
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

let stop = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stop = true; });

async function main() {
  for (const [k, v] of [["SPOOL_HOST", SPOOL_HOST], ["EDIT_WORKER_SECRET", SECRET], ["BLOB_READ_WRITE_TOKEN", BLOB_TOKEN]]) {
    if (!v) throw new Error(`missing env ${k}`);
  }
  console.log(`[worker] polling ${SPOOL_HOST}/api/edit-jobs/next every ${POLL_MS / 1000}s`);
  while (!stop) {
    let job = null;
    try {
      job = await claimNext();
    } catch (e) {
      console.warn(`[worker] poll error: ${oneLine(e)}`);
    }
    if (!job) {
      await sleep(POLL_MS);
      continue;
    }
    try {
      await processJob(job);
      await patchJob(job.id, { status: "done" });
    } catch (e) {
      console.error(`[worker] job ${job.id} error: ${oneLine(e)}`);
      await patchJob(job.id, { status: "error", error: oneLine(e) });
    }
  }
  console.log("[worker] stopped");
}

main().catch((e) => {
  console.error(`[worker] fatal: ${oneLine(e)}`);
  process.exit(1);
});
