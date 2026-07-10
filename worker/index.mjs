// Spool edit render worker (Fly app `spool-render`). Polls the web for edit jobs,
// re-renders the spool from its published sources with the ops applied, and
// overwrites the published artifacts in Blob. See docs/EDIT-CONTRACT.md.
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyOps } from "./ops.mjs";
import { downloadTo, uploadViaGrant } from "./blob.mjs";
import { renderSpool } from "../src/render/render.mjs";
import { shareSpool } from "../src/share/share.mjs";
import { synthesizeSegment } from "../src/vo/tts.mjs";

const SPOOL_HOST = (process.env.SPOOL_HOST || "").replace(/\/$/, "");
const SECRET = process.env.EDIT_WORKER_SECRET || "";
const BLOB_BASE = (process.env.SPOOL_BLOB_BASE || "").replace(/\/$/, "");
const POLL_MS = 5000;
const HEARTBEAT_MS = Number(process.env.WORKER_HEARTBEAT_MS || 5 * 60 * 1000); // extend the 20min lease well before it lapses
const MAX_IDLE = Number(process.env.WORKER_IDLE_EXITS || 24); // ~2min of empty polls → exit(0) → machine stops

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const oneLine = (e) => String((e && e.message) || e).split("\n")[0].slice(0, 240);
const readJson = async (p) => JSON.parse(await readFile(p, "utf8"));

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

// Ask the web for short-lived client-upload grants for the given output pathnames
// (POST /api/edit-jobs/{id}/uploads). The worker holds no standing Blob token.
async function requestGrants(id, paths, leaseToken) {
  const res = await fetch(`${SPOOL_HOST}/api/edit-jobs/${id}/uploads`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
    body: JSON.stringify({ paths, leaseToken }),
  });
  if (!res.ok) throw new Error(`uploads grant ${res.status}: ${(await res.text().catch(() => "")).slice(0, 160)}`);
  return (await res.json()).uploads || [];
}

// Download the published sources by deterministic public URL (store access: public,
// so no token). Fixed set first, then each VO segment named by the manifest.
async function downloadSources(spoolId, workdir) {
  const url = (rel) => `${BLOB_BASE}/spools/${spoolId}/src/${rel}`;
  await downloadTo(url("timeline.json"), join(workdir, "timeline.json"));
  await downloadTo(url("vo/manifest.json"), join(workdir, "vo/manifest.json"));
  await downloadTo(url("video.mp4"), join(workdir, "video.mp4"));
  await downloadTo(url("render.json"), join(workdir, "render.json")).catch(() => {}); // optional
  const manifest = await readJson(join(workdir, "vo", "manifest.json"));
  for (const seg of manifest.segments || []) {
    if (seg.wav) await downloadTo(url(seg.wav), join(workdir, seg.wav));
    if (seg.words) await downloadTo(url(seg.words), join(workdir, seg.words)).catch(() => {});
  }
}

async function processJob(job) {
  const { id, spoolId, ops, leaseToken } = job;
  console.log(`[worker] job ${id} spool ${spoolId} attempt ${job.attempts ?? "?"} (${ops.length} op[s])`);
  const workdir = await mkdtemp(join(tmpdir(), `spool-edit-${spoolId}-`));
  // Heartbeat the lease during the (potentially long) render so it isn't reclaimed.
  const hb = setInterval(() => {
    patchJob(id, { status: "running", leaseToken }).catch(() => {});
  }, HEARTBEAT_MS);
  try {
    // 1. Pull the immutable sources into a fresh workdir (public URL download).
    await downloadSources(spoolId, workdir);

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

    // 5. Overwrite the published artifacts via per-job upload grants. spool.json's
    //    bundle-relative paths are rewritten to the deterministic l/<id>/* blob URLs.
    const spool = await readJson(join(shareDir, "spool.json"));
    const lUrl = (name) => `${BLOB_BASE}/l/${spoolId}/${name}`;
    spool.video = lUrl("final.mp4");
    for (const s of spool.steps) s.frame = lUrl(`frames/step_${String(s.i).padStart(2, "0")}.png`);

    // Collect { pathname → bytes }: final.mp4 + frames + regenerated bundle files.
    const outputs = new Map();
    outputs.set(`l/${spoolId}/final.mp4`, await readFile(join(workdir, "final.mp4")));
    for (const f of await readdir(join(shareDir, "frames")).catch(() => [])) {
      outputs.set(`l/${spoolId}/frames/${f}`, await readFile(join(shareDir, "frames", f)));
    }
    outputs.set(`l/${spoolId}/spool.json`, Buffer.from(JSON.stringify(spool, null, 2)));
    for (const name of ["transcript.txt", "console.jsonl"]) {
      const p = join(shareDir, name);
      if (existsSync(p)) outputs.set(`l/${spoolId}/${name}`, await readFile(p));
    }

    const grants = await requestGrants(id, [...outputs.keys()], leaseToken);
    if (grants.length !== outputs.size) throw new Error(`grant count ${grants.length} ≠ outputs ${outputs.size}`);
    for (const g of grants) {
      const buf = outputs.get(g.pathname);
      if (!buf) throw new Error(`grant for unknown path ${g.pathname}`);
      await uploadViaGrant(buf, g);
    }
    console.log(`[worker] job ${id} done → ${lUrl("final.mp4")}`);
  } finally {
    clearInterval(hb);
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}

let stop = false;
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => { stop = true; });

async function main() {
  for (const [k, v] of [["SPOOL_HOST", SPOOL_HOST], ["EDIT_WORKER_SECRET", SECRET], ["SPOOL_BLOB_BASE", BLOB_BASE]]) {
    if (!v) throw new Error(`missing env ${k}`);
  }
  console.log(`[worker] polling ${SPOOL_HOST}/api/edit-jobs/next every ${POLL_MS / 1000}s`);
  let idle = 0;
  while (!stop) {
    let job = null;
    try {
      job = await claimNext();
    } catch (e) {
      console.warn(`[worker] poll error: ${oneLine(e)}`);
    }
    if (!job) {
      // Scale-to-zero: after a stretch of empty polls, exit(0) so the machine stops
      // (Fly restart policy = on-failure, so a clean exit is not restarted). The web
      // wakes it on the next enqueue.
      if (++idle >= MAX_IDLE) {
        console.log(`[worker] ${idle} empty polls — exiting for scale-to-zero`);
        return;
      }
      await sleep(POLL_MS);
      continue;
    }
    idle = 0;
    try {
      await processJob(job);
      await patchJob(job.id, { status: "done", leaseToken: job.leaseToken });
    } catch (e) {
      console.error(`[worker] job ${job.id} error: ${oneLine(e)}`);
      await patchJob(job.id, { status: "error", error: oneLine(e), leaseToken: job.leaseToken });
    }
  }
  console.log("[worker] stopped");
}

main().catch((e) => {
  console.error(`[worker] fatal: ${oneLine(e)}`);
  process.exit(1);
});
