// Cloud finish: hand a recorded take to the hosted worker, which does the VO, the
// render, the share bundle and the publish server-side and returns a watch link. The
// CLI's only local work is normalizing the capture and uploading the sources.
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveConfig } from '../publish/publish.mjs';
import { normalize } from '../render/normalize.mjs';
import { resolveRenderIntent, resolveWorkdirFormat } from '../render/render.mjs';
import { resolveBgSource } from '../render/bg-resolve.mjs';
import { resolveBgPref } from '../config/prefs.mjs';

const BLOB_API = process.env.VERCEL_BLOB_API_URL || 'https://blob.vercel-storage.com';
const POLL_MS = 5000;
const TIMEOUT_MS = 60 * 60 * 1000;
const POLL_FAILURES_MAX = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// spools/<id>/src/<rel> → <rel>: grants are named by their worker-side layout.
const srcRel = (pathname) => pathname.replace(/^spools\/[^/]+\/src\//, '');

// The workdir's authored steps, best-effort. The counter keeps the cache-buster
// unique: two imports in the same millisecond would otherwise share a URL.
let importSeq = 0;
async function authoredSteps(dir) {
  const sf = join(dir, 'steps.mjs');
  if (!existsSync(sf)) return null;
  try {
    return (await import(pathToFileURL(sf).href + `?t=${Date.now()}-${importSeq++}`)).steps || null;
  } catch {
    return null;
  }
}

// The timeline the worker narrates from: every step has to carry its own narration
// (the worker never sees steps.mjs). Live takes already do; a scripted session keeps
// its narration in steps.mjs, so fold it into a COPY; the workdir file is untouched.
async function timelineForUpload(dir) {
  const timeline = JSON.parse(await readFile(join(dir, 'timeline.json'), 'utf8'));
  const steps = timeline.steps || [];
  if (!steps.some((s) => !s.narration)) return timeline;
  const authored = await authoredSteps(dir);
  if (!authored) return timeline;
  const byName = new Map(authored.filter((s) => s && s.name).map((s) => [s.name, s]));
  return {
    ...timeline,
    steps: steps.map((s, i) => {
      if (s.narration) return s;
      const src = byName.get(s.name) || authored[i];
      return src && src.narration ? { ...s, narration: src.narration } : s;
    }),
  };
}

// The worker voices the take from the timeline alone, so an un-narrated upload renders
// silent and still spends a job. Fail before that; a partial gap only warns (the local
// path skips those steps too).
function checkNarration(dir, timeline) {
  const steps = timeline.steps || [];
  const silent = steps.filter((s) => !s.narration);
  if (!steps.length || silent.length < steps.length) {
    if (silent.length) console.error(`[cloud] ${silent.length} step(s) have no narration and will render silent: ${silent.map((s) => s.name).join(', ')}`);
    return;
  }
  console.error(`No narration in ${join(dir, 'timeline.json')}, and none in steps.mjs to fold in.`);
  console.error('A cloud render voices the take from the timeline (the worker never reads steps.mjs), so this would publish silent.');
  process.exit(1);
}

// Ship the resolved canvas only when the worker can't re-resolve it: presets round-trip
// by name through render.json, macOS wallpapers and local image paths cannot.
async function stageBg(dir, bgSpec) {
  const { source, kind } = await resolveBgSource(bgSpec);
  if (kind === 'preset' || !existsSync(source)) return false;
  await copyFile(source, join(dir, '.spool-bg.jpg'));
  return true;
}

// normalize() reports on stdout; a cloud run keeps stdout to just the watch link.
async function quietNormalize(dir) {
  const log = console.log;
  console.log = (...args) => console.error(...args);
  try {
    return await normalize(dir);
  } finally {
    console.log = log;
  }
}

async function api(host, token, path, init = {}) {
  return fetch(`${host}/api/render-jobs${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
}

const detail = async (res) => (await res.text().catch(() => '')).slice(0, 200);

// Create the job and get the upload grants back. Plan gates (402/429) print and exit
// before anything is uploaded.
async function createJob(host, token, body) {
  const res = await api(host, token, '', { method: 'POST', body: JSON.stringify(body) });
  if (res.status === 402 || res.status === 429) {
    const info = await res.json().catch(() => ({}));
    console.error(info.error || 'cloud rendering is not available on your plan right now.');
    if (info.upgradeUrl) console.error(`Upgrade: ${info.upgradeUrl}`);
    process.exit(1);
  }
  if (!res.ok) throw new Error(`cloud job create failed: ${res.status} ${await detail(res)}`);
  return res.json();
}

// Single-PUT a source to Blob with the server-minted scoped grant (the token pins the
// pathname + content type). api-version 10 is what makes x-allow-overwrite honored.
async function uploadGrant(body, { pathname, token, contentType }) {
  const res = await fetch(`${BLOB_API}/?pathname=${encodeURIComponent(pathname)}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'x-api-version': '10',
      'x-content-type': contentType,
      'x-add-random-suffix': '0',
      'x-allow-overwrite': '1',
      'x-content-length': String(body.length),
    },
    body,
  });
  if (!res.ok) throw new Error(`blob upload failed for ${pathname}: ${res.status} ${await detail(res)}`);
}

// Poll until the job lands. Transient poll failures are tolerated (a render outlives
// the odd 502); a reported error, or 60 minutes, ends it.
async function pollJob(host, token, jobId) {
  const deadline = Date.now() + TIMEOUT_MS;
  let announced = false;
  let failures = 0;
  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    let job;
    try {
      const res = await api(host, token, `/${jobId}`);
      if (!res.ok) throw new Error(`${res.status} ${await detail(res)}`);
      job = await res.json();
      failures = 0;
    } catch (e) {
      if (++failures > POLL_FAILURES_MAX) throw new Error(`cloud job poll failed: ${e.message}`);
      continue;
    }
    if (job.status === 'running' && !announced) {
      console.error('rendering...');
      announced = true;
    }
    if (job.status === 'done') return job.url;
    if (job.status === 'error') {
      console.error(job.error || 'cloud render failed');
      process.exit(1);
    }
  }
  console.error(`Timed out after 60 min waiting on job ${jobId} (it may still be running).`);
  console.error(`Pick the link up with \`spool list\`, or check ${host}/dashboard.`);
  process.exit(1);
}

/**
 * Render a recorded take in the cloud: upload the sources, start the job, wait for it,
 * and record the watch link so `spool open` in this workdir reopens it.
 *
 * The workdir needs a capture + timeline.json (see `spool live` / `spool record`); the
 * worker does the VO, so no local vo/ is required. Returns the watch URL.
 */
export async function cloudFinish(workdir, opts = {}) {
  const dir = resolve(workdir);
  const { host, token } = await resolveConfig({ host: opts.host, token: opts.token });
  if (!host || !token) {
    console.error('cloud rendering needs an account: run `spool login`');
    process.exit(1);
  }

  console.error('── spool cloud');
  const format = await resolveWorkdirFormat(dir, opts.format);
  const rate = Number(opts.rate ?? 1);
  const bgSpec = opts.bg != null ? opts.bg : await resolveBgPref();

  const timeline = await timelineForUpload(dir);
  checkNarration(dir, timeline);

  // The worker renders from video.mp4; the workdir may hold only the raw capture.
  await quietNormalize(dir);

  const intent = await resolveRenderIntent(dir, { rate, bg: bgSpec, format });
  const hasBg = await stageBg(dir, bgSpec);
  const hasConsole = existsSync(join(dir, 'console.jsonl'));

  const job = await createJob(host, token, {
    title: timeline.title || basename(dir),
    duration: null,
    payload: {
      rate,
      bg: bgSpec ?? null,
      hq: !!opts.hq,
      voice: opts.voice ?? null,
      speed: Number(opts.speed ?? 1),
      format,
    },
    sources: { hasBg, hasConsole },
  });

  const bodies = {
    'timeline.json': Buffer.from(JSON.stringify(timeline, null, 2) + '\n'),
    'render.json': Buffer.from(JSON.stringify(intent, null, 2) + '\n'),
    'video.mp4': await readFile(join(dir, 'video.mp4')),
    ...(hasBg ? { 'bg.jpg': await readFile(join(dir, '.spool-bg.jpg')) } : {}),
    ...(hasConsole ? { 'console.jsonl': await readFile(join(dir, 'console.jsonl')) } : {}),
  };

  const uploads = job.uploads || [];
  for (const grant of uploads) {
    if (!bodies[srcRel(grant.pathname)]) throw new Error(`no local source for grant ${grant.pathname}`);
  }
  const mb = uploads.reduce((n, g) => n + bodies[srcRel(g.pathname)].length, 0) / 1e6;
  console.error(`uploading sources (${uploads.length} files, ${mb.toFixed(1)} MB)...`);
  for (const grant of uploads) await uploadGrant(bodies[srcRel(grant.pathname)], grant);

  const started = await api(host, token, `/${job.jobId}/start`, { method: 'POST' });
  if (!started.ok) throw new Error(`cloud job start failed: ${started.status} ${await detail(started)}`);
  console.error('queued');

  const url = (await pollJob(host, token, job.jobId)) || job.url;

  await mkdir(join(dir, 'share'), { recursive: true }).catch(() => {});
  await writeFile(
    join(dir, 'share', 'published.json'),
    JSON.stringify({ url, id: job.id, publishedAt: new Date().toISOString() }, null, 2) + '\n'
  ).catch(() => {});

  console.error(`Done: ${url}`);
  console.log(url);
  return url;
}
