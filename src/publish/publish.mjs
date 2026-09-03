import { readFile, writeFile, mkdir } from "node:fs/promises";
import { DEFAULT_HOST } from "../config/prefs.mjs";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { observe } from "../reliability/journal.mjs";
import { withRetry } from "../reliability/retry.mjs";

const run = promisify(execFile);

// Context pack caps (mirror PR-GUIDE-CONTRACT.md; also enforced at scaffold).
const CONTEXT_FILE_MAX = 100 * 1024;
const CONTEXT_PACK_MAX = 6 * 1024 * 1024;
const sliceText = (s) => (s.length > CONTEXT_FILE_MAX ? s.slice(0, CONTEXT_FILE_MAX) : s);

// Resolve host/token from explicit args, then env, then ~/.spool.json.
export async function resolveConfig({ host, token } = {}) {
  let cfg = {};
  const cfgPath = join(homedir(), ".spool.json");
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    } catch {
      /* ignore malformed config, fall through to env/args */
    }
  }
  const h = host || process.env.SPOOL_HOST || cfg.host || DEFAULT_HOST;
  const t = token || process.env.SPOOL_PUBLISH_TOKEN || cfg.token;
  return { host: h.replace(/\/$/, ""), token: t };
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
    // The resolved canvas image the render composited (preset, macOS wallpaper, or
    // custom file). Ships to spools/{id}/src/bg.jpg so the Linux worker can re-render
    // with the same canvas without the source machine's fonts/wallpapers.
    hasBg: has(".spool-bg.jpg"),
  };
}

// Read a `spool pr` scaffold from the workdir into the publish `pr` bundle. Rides
// inline in meta (sibling of sources — must not depend on editability). Null when
// the workdir is not a PR guide. When a context.json exists, fold in the authored
// brief + curated `related` files and stage the merged pack as .spool-context.json.
export async function buildPrBundle(dir) {
  const prPath = join(dir, "pr.json");
  const tourPath = join(dir, "tour.json");
  if (!existsSync(prPath) || !existsSync(tourPath)) return null;
  const base = {
    info: JSON.parse(await readFile(prPath, "utf8")),
    tour: JSON.parse(await readFile(tourPath, "utf8")),
    hasDiff: existsSync(join(dir, "diff.patch")),
  };

  // Agent-authored knowledge ops ride in meta regardless of a context pack, so fold
  // them into base BEFORE the no-context early return. Server validates; this is a
  // light shape check (non-empty array of objects each with a string `op`).
  const opsPath = join(dir, "knowledge-ops.json");
  if (existsSync(opsPath)) {
    try {
      const parsed = JSON.parse(await readFile(opsPath, "utf8"));
      const ops = parsed?.ops;
      if (Array.isArray(ops) && ops.length && ops.every((o) => o && typeof o === "object" && typeof o.op === "string")) {
        base.knowledgeOps = ops;
      }
    } catch {
      /* malformed ops file: skip; nothing durable ships */
    }
  }

  const contextPath = join(dir, "context.json");
  if (!existsSync(contextPath)) return base;

  const context = JSON.parse(await readFile(contextPath, "utf8"));
  if (!context.files) context.files = {};
  const mdPath = join(dir, "context.md");
  if (existsSync(mdPath)) {
    const md = await readFile(mdPath, "utf8");
    if (md.trim()) context.brief = md;
  }
  await resolveRelated(context);
  enforcePackCap(context);
  await writeFile(join(dir, ".spool-context.json"), JSON.stringify(context) + "\n");
  return { ...base, hasContext: true };
}

// Fetch a file body via gh api raw accept at the PR head commit (base repo).
async function ghRawFile(owner, repo, path, ref) {
  const { stdout } = await run(
    "gh",
    ["api", `repos/${owner}/${repo}/contents/${encodeURI(path)}?ref=${ref}`, "-H", "Accept: application/vnd.github.raw+json"],
    { maxBuffer: 32 * 1024 * 1024 }
  );
  return stdout;
}

// Resolve each `related` path not already in files{}: local checkout first
// (spool pr usually runs at repo root), else gh api at headRefOid. Reject path
// traversal. Failures record {omitted:"fetch-failed"} — never throw.
async function resolveRelated(context) {
  const { owner, repo, headRefOid } = context.pr || {};
  const files = context.files;
  for (const rel of context.related || []) {
    if (typeof rel !== "string" || files[rel]) continue;
    if (rel.includes("..") || rel.startsWith("/")) {
      files[rel] = { omitted: "fetch-failed" };
      continue;
    }
    const local = join(process.cwd(), rel);
    if (existsSync(local)) {
      try {
        files[rel] = { text: sliceText(await readFile(local, "utf8")) };
        continue;
      } catch {
        /* fall through to gh */
      }
    }
    if (owner && repo && headRefOid) {
      try {
        files[rel] = { text: sliceText(await ghRawFile(owner, repo, rel, headRefOid)) };
        continue;
      } catch {
        /* fall through to omitted */
      }
    }
    files[rel] = { omitted: "fetch-failed" };
  }
}

// Keep the pack under 6MB, trimming in priority order (related file texts first,
// least-valuable first: docs, then issues, then readme, then related file texts,
// then changed-file texts last. Changed files survive longest. Trimmed → too-large.
function enforcePackCap(context) {
  const size = () => Buffer.byteLength(JSON.stringify(context), "utf8");
  if (size() <= CONTEXT_PACK_MAX) return;
  if (context.docs?.length) context.docs = [];
  if (size() <= CONTEXT_PACK_MAX) return;
  if (context.issues?.length) context.issues = [];
  if (size() > CONTEXT_PACK_MAX && context.readme?.text) context.readme = null;
  const related = new Set(context.related || []);
  for (const p of related) {
    if (size() <= CONTEXT_PACK_MAX) return;
    if (context.files[p]?.text !== undefined) context.files[p] = { omitted: "too-large" };
  }
  for (const p of Object.keys(context.files)) {
    if (size() <= CONTEXT_PACK_MAX) return;
    if (!related.has(p) && context.files[p]?.text !== undefined) context.files[p] = { omitted: "too-large" };
  }
}

// Read the published Plan Spool metadata out of the share bundle: the packet
// (`share/plan.json`) and, when the workdir authored evidence, the resolved
// descriptors (`share/evidence.json`). Both ride inline in the publish request —
// they are small, and the server re-validates the packet before it stores it.
// Returns null for an ordinary walkthrough, so nothing changes for one.
export async function buildPlanBundle(shareDir, spool) {
  const planPath = join(shareDir, "plan.json");
  if (spool?.kind !== "plan" || !existsSync(planPath)) return null;
  const bundle = { plan: JSON.parse(await readFile(planPath, "utf8")) };
  const evidencePath = join(shareDir, "evidence.json");
  if (existsSync(evidencePath)) bundle.evidence = JSON.parse(await readFile(evidencePath, "utf8"));
  return bundle;
}

// Read the published reply descriptor out of the share bundle (roadmap R4.2). It
// rides inline like the plan packet, and for the same reason: the server checks the
// parent, the revision and the anchors again before it links anything.
// Returns null for a spool that replies to nothing.
export async function buildReplyBundle(shareDir, spool) {
  const replyPath = join(shareDir, "reply.json");
  if (!spool?.reply || !existsSync(replyPath)) return null;
  return { reply: JSON.parse(await readFile(replyPath, "utf8")) };
}

// Link what the media argues about, once the media is stored. A plan publish and a
// reply publish are both two calls on purpose (CONTRACTS.md "Publish"): the first
// reserves the spool and hands out upload grants, this one opens revision 1 or
// records the reply on its parent. The call is idempotent, so a retry after a
// dropped response returns the same receipt.
async function completePublish({ host, token, id }) {
  let last = "";
  const failed = (why) =>
    new Error(
      `publish did not complete: ${last || why}\n` +
        `the media uploaded but the plan linkage is not written, so nothing is watchable — re-run \`spool publish\``
    );
  // Retryable because the call is idempotent: it opens revision 1 once and returns
  // the same receipt afterwards. 409 is retried too — it means the media is still
  // landing — while any other 4xx is an answer rather than a hiccup (R6.3).
  const { value, attempts } = await withRetry(
    async () => {
      const res = await fetch(`${host}/api/publish/${id}/complete`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) last = `${res.status} ${res.statusText} ${await res.text().catch(() => "")}`.trim();
      return res;
    },
    { attempts: 3, baseMs: 500, shouldRetry: (res) => !res.ok && (res.status >= 500 || res.status === 409 || res.status === 429) }
  ).catch((e) => {
    throw failed(e.message);
  });
  if (!value.ok) throw failed(`${value.status}`);
  return { receipt: await value.json(), attempts };
}

// Map a returned upload grant to its local file. Source grants (spools/{id}/src/*)
// resolve against the workdir; published grants (l/{id}/*) against final.mp4/share.
function grantLocalPath(pathname, { dir, shareDir, finalMp4 }) {
  if (pathname.includes("/src/")) {
    const rel = pathname.replace(/^spools\/[^/]+\/src\//, "");
    // The merged pack ships from the staged .spool-context.json, not the raw workdir file.
    if (rel === "pr/context.json") return join(dir, ".spool-context.json");
    // PR guide sources live flat in the workdir (src/pr/diff.patch → diff.patch).
    if (rel.startsWith("pr/")) return join(dir, rel.slice(3));
    // src/bg.jpg is staged in the workdir as the hidden .spool-bg.jpg.
    return join(dir, rel === "bg.jpg" ? ".spool-bg.jpg" : rel);
  }
  const rel = pathname.replace(/^l\/[^/]+\//, "");
  if (rel === "final.mp4") return finalMp4;
  // layers/fg.webm sits beside final.mp4 in the workdir, not in the share bundle.
  if (rel.startsWith("layers/")) return join(dir, rel);
  return join(shareDir, rel);
}

/**
 * Publish a built spool's share bundle to the spool web app.
 * Returns the watch URL. Requires `spool share` to have run first.
 *
 * Journals the attempt (roadmap R6.3): publish is the failure point that costs the
 * most, because everything upstream of it has already been paid for. A publish
 * that only succeeded because the completing call was retried is recorded as
 * `retried`, so a host that is quietly flapping shows up before it starts losing
 * takes. See docs/PLAN-SPOOLS-RELIABILITY.md.
 */
export async function publishSpool(workdir, opts = {}) {
  return observe("publish", (ctx) => publishSpoolInner(workdir, opts, ctx), { target: workdir });
}

async function publishSpoolInner(workdir, opts = {}, ctx = { attempts: 1 }) {
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
      "not connected — run `spool login` (or set SPOOL_PUBLISH_TOKEN)"
    );
  }

  const spool = JSON.parse(await readFile(spoolJson, "utf8"));
  const transcriptPath = join(shareDir, "transcript.txt");
  const consolePath = join(shareDir, "console.jsonl");
  const sources = await buildSources(dir); // null ⇒ dry/partial session, not editable
  const prBundle = await buildPrBundle(dir); // null ⇒ ordinary (non-PR) spool
  // Plan Spool metadata (optional): the packet and the resolved evidence, written by
  // `spool share`. Both ride inline; the server re-validates and stores them, then
  // opens revision 1 once the media is uploaded.
  const planBundle = await buildPlanBundle(shareDir, spool); // null ⇒ ordinary walkthrough
  // Reply lineage (optional): what parent moment this recording answers.
  const replyBundle = await buildReplyBundle(shareDir, spool); // null ⇒ replies to nothing
  const meta = {
    spool,
    transcript: existsSync(transcriptPath) ? await readFile(transcriptPath, "utf8") : "",
    console: existsSync(consolePath) ? await readFile(consolePath, "utf8") : "",
    ...(sources ? { sources } : {}),
    ...(prBundle ? { pr: prBundle } : {}),
    ...(planBundle ?? {}),
    ...(replyBundle ?? {}),
    hasPreview: existsSync(join(shareDir, "preview.gif")),
    // The alpha foreground beside final.mp4, so a later background change is a swap.
    hasFgLayer: existsSync(join(dir, "layers", "fg.webm")),
  };

  const res = await fetch(`${host}/api/publish`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(meta),
  });
  if (!res.ok) {
    // Free-tier publish gate: print the upgrade message cleanly (no stack) and exit.
    if (res.status === 402) {
      const info = await res.json().catch(() => ({}));
      console.error(info.error || "free plan limit reached. Upgrade to keep publishing.");
      if (info.upgradeUrl) console.error(`Upgrade: ${info.upgradeUrl}`);
      process.exit(1);
    }
    throw new Error(`publish failed: ${res.status} ${res.statusText} ${await res.text().catch(() => "")}`);
  }
  const { id, url, uploads, previewUrl, knowledge, plan: planReceipt, reply: replyReceipt } = await res.json();

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

  // Project knowledge apply summary from the server (present only for PR guides with ops).
  if (knowledge && typeof knowledge.applied === "number") {
    const skipped = Array.isArray(knowledge.skipped) ? knowledge.skipped.length : Number(knowledge.skipped) || 0;
    console.error(`[publish] knowledge: ${knowledge.applied} op(s) applied${skipped > 0 ? `, ${skipped} skipped (caps)` : ""}`);
  }

  // A plan is opened, and a reply is linked, only now — after every grant uploaded:
  // a reviewer must never meet a pending decision, or an answer on a question thread,
  // on a spool whose video failed to arrive.
  if (planReceipt?.pending || replyReceipt?.pending) {
    const { receipt: done, attempts } = await completePublish({ host, token, id });
    ctx.attempts = attempts;
    // A plan spool waits on a person: say who acts next and how the agent reads back.
    if (done?.plan) {
      console.error(`[publish] plan: revision ${done.plan.revision}, ${done.plan.status} — the owner decides on the watch page`);
      console.error(`[publish] read the decision back with \`spool read --plan ${workdir} --json\``);
    }
    if (done?.reply) {
      console.error(`[publish] reply: ${done.reply.kind} on plan ${done.reply.planSpoolId} (revision ${done.reply.revision})`);
      console.error(`[publish] it opens at the moment it addresses: ${done.reply.opensAt}`);
    }
  }

  // Record the watch link so `spool open` in this workdir reopens it.
  await mkdir(shareDir, { recursive: true }).catch(() => {});
  await writeFile(join(shareDir, "published.json"), JSON.stringify({ url, id, publishedAt: new Date().toISOString() }, null, 2) + "\n").catch(() => {});

  console.log(url);

  // The spool is published and published.json is written, so a failed comment is not a
  // failed publish; print the link so it can be posted by hand (CI asserts it separately).
  if (opts.pr) {
    const viaApp = await announceViaApp({ host, token, id });
    if (viaApp?.posted || viaApp?.action === "skipped") {
      console.error(`[publish] PR comment (App): ${viaApp.action}${viaApp.url ? ` ${viaApp.url}` : ""}`);
    } else {
      if (viaApp?.reason) console.error(`[publish] PR comment: the App did not post (${viaApp.reason}) — using gh`);
      await commentOnPR(url, spool, opts.pr, previewUrl).catch((e) =>
        console.error(`[publish] PR comment failed: ${e.message}\n[publish] post it manually: ${url}`),
      );
    }
  }
  return url;
}

// Ask the platform to comment as the GitHub App. Returns what it did, or null when
// this host cannot answer (an older deployment, an unreachable one) — either way the
// caller falls back to `gh`, which is the only writer that knows the branch's PR.
export async function announceViaApp({ host, token, id }) {
  try {
    const res = await fetch(`${host}/api/publish/${id}/announce`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const { comment } = await res.json();
    return comment ?? null;
  } catch {
    return null;
  }
}

// Post the watch link as a PR comment via gh. pr === true ⇒ gh resolves the
// current branch's PR; a number/URL targets one explicitly. Never fails publish.
export async function commentOnPR(url, spool, pr, previewUrl) {
  await run("gh", ["--version"]).catch(() => {
    throw new Error("gh CLI not found on PATH");
  });

  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  // A vertical PR spool is a recap, not a guided reading; it gets its own comment.
  const body = !spool.pr
    ? walkthroughBody(url, spool, previewUrl, mmss)
    : spool.format === "vertical"
      ? recapBody(url, spool, previewUrl, mmss)
      : guideBody(url, spool, previewUrl, mmss);

  const args = ["pr", "comment"];
  if (pr !== true) args.push(String(pr));
  args.push("--body", body);
  const { stdout } = await run("gh", args);
  console.error(`[publish] PR comment: ${stdout.trim() || "posted"}`);
}

// Shared shape of every PR comment: heading, optional inline preview, watch line, a
// two-column table, footer. The variants below differ only in wording and row source.
function commentBody({ heading, previewAlt, watchLabel = "Watch", rowLabel, rows, url, previewUrl, duration, footer }) {
  return [
    `### ${heading}`,
    "",
    // GIF preview when available: GitHub renders it inline; clicking opens the watch page.
    ...(previewUrl ? [`[![${previewAlt}](${previewUrl})](${url})`, ""] : []),
    `**${watchLabel}:** ${url} (${Math.round(duration)}s, narrated)`,
    "",
    `| at | ${rowLabel} |`,
    "|---|---|",
    rows,
    "",
    `<sub>${footer}</sub>`,
  ].join("\n");
}

// Default walkthrough comment (non-PR spools): step index by start time.
function walkthroughBody(url, spool, previewUrl, mmss) {
  return commentBody({
    url,
    previewUrl,
    duration: spool.duration,
    heading: `🎬 Walkthrough: ${spool.title || "spool"}`,
    previewAlt: "watch the walkthrough",
    rowLabel: "step",
    rows: (spool.steps || []).map((s) => `| ${mmss(s.start)} | ${s.name} |`).join("\n"),
    footer: `Recorded and narrated by the agent that shipped this change, via [spool](https://spoolkit.dev). Agents can review without watching: \`spool read\` the share bundle linked on the watch page.`,
  });
}

// Tour stops as table rows, timestamped by the step each stop maps to (blank when the
// stop has no anchored step). Shared by the guide and recap comment variants.
function stopRows(spool, mmss) {
  const steps = spool.steps || [];
  return (spool.pr.stops || [])
    .map((stop) => {
      const at = typeof stop.step === "number" && steps[stop.step] ? mmss(steps[stop.step].start) : "";
      return `| ${at} | ${stop.heading || stop.id} |`;
    })
    .join("\n");
}

// Recap comment variant: a merged PR's vertical recap shows what shipped, so it reads
// as an announcement rather than a reading guide. No em dashes.
function recapBody(url, spool, previewUrl, mmss) {
  return commentBody({
    url,
    previewUrl,
    duration: spool.duration,
    heading: `🎬 Recap: ${spool.pr.title || spool.title || "what shipped"}`,
    previewAlt: "watch the recap",
    rowLabel: "stop",
    rows: stopRows(spool, mmss),
    footer: `What this change shipped, recorded and narrated by the agent that shipped it. Built via [spool](https://spoolkit.dev).`,
  });
}

// PR-guide comment variant: the tour stops are the rows, timestamped by the step
// each stop maps to (blank when the stop has no anchored step). No em dashes.
function guideBody(url, spool, previewUrl, mmss) {
  return commentBody({
    url,
    previewUrl,
    duration: spool.duration,
    heading: `🧭 PR guide: ${spool.pr.title || spool.title || "PR"}`,
    previewAlt: "watch the guided tour",
    watchLabel: "Watch the guided tour",
    rowLabel: "stop",
    rows: stopRows(spool, mmss),
    footer: `A guided reading of this change, not a review. The watch page has the tour, the full diff, and Q&A grounded in the diff. Built via [spool](https://spoolkit.dev).`,
  });
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
