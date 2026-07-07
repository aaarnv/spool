import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, copyFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";

const exec = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

async function readJson(p) {
  return JSON.parse(await readFile(p, "utf8"));
}

async function duration(file) {
  const { stdout } = await exec(FFPROBE, [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    file,
  ]);
  return parseFloat(stdout.trim());
}

function mmss(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

// url lives in steps.mjs config, not timeline.json (see contract note). Prefer a
// url baked into timeline.json if the record layer ever adds one, else import the
// authored steps.mjs and read config.url. Never throws — falls back to null.
async function resolveUrl(workdir, timeline) {
  if (timeline?.url) return timeline.url;
  const stepsPath = join(workdir, "steps.mjs");
  if (!existsSync(stepsPath)) return null;
  try {
    const mod = await import(pathToFileURL(stepsPath).href);
    return mod?.config?.url ?? null;
  } catch {
    return null;
  }
}

// Parse console.jsonl (tolerant of blank/garbled lines). Errors = console errors +
// page errors + failed requests; warnings = console warnings.
function tallyConsole(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const entries = [];
  for (const l of lines) {
    try {
      entries.push(JSON.parse(l));
    } catch {
      /* skip non-JSON lines */
    }
  }
  const isError = (e) =>
    e.kind === "pageerror" ||
    e.kind === "requestfailed" ||
    (e.kind === "console" && e.level === "error");
  const errors = entries.filter(isError);
  const warnings = entries.filter(
    (e) => e.kind === "console" && e.level === "warning"
  );
  return { entries, errors, warnings };
}

// Frame time for a step: just after the first click when it has clicks (so the UI
// has reacted), otherwise the step midpoint. Clamped inside the video.
function frameTime(step, videoDur) {
  const clicks = step.clicks || [];
  const t = clicks.length ? clicks[0].t + 0.3 : (step.start + step.end) / 2;
  return Math.min(Math.max(t, 0), Math.max(0, videoDur - 0.05));
}

/**
 * Write the agent-consumable share/ bundle for a loom workdir.
 * See CONTRACTS.md "share/ bundle".
 */
export async function shareLoom(workdir) {
  const dir = resolve(workdir);
  const timeline = await readJson(join(dir, "timeline.json"));
  const manifest = await readJson(join(dir, "vo", "manifest.json"));
  const narrationByIndex = new Map(
    (manifest.segments || []).map((s) => [s.i, s.narration])
  );

  // Frames come from the pre-speed normalize output (video.mp4), whose clock
  // matches timeline.json — final.mp4 is time-compressed by `rate`, so pulling
  // frames from it would land on the wrong moments. Duration, though, is read
  // from the actual deliverable (final.mp4) so loom.json reports true runtime.
  const first = (names) => names.find((n) => existsSync(join(dir, n)));
  const frameName = first(["video.mp4", "video.webm", "final.mp4"]);
  if (!frameName) throw new Error(`share: no source video in ${dir} (need video.mp4/video.webm/final.mp4)`);
  const videoPath = join(dir, frameName);

  const durName = first(["final.mp4", "video.mp4", "video.webm"]);
  const videoDur = await duration(join(dir, durName));

  // Rate the render layer applied (final.mp4 is video.mp4's clock ÷ rate).
  let rate = 1;
  if (existsSync(join(dir, "render.json"))) {
    try {
      rate = (await readJson(join(dir, "render.json"))).rate ?? 1;
    } catch {
      /* keep default */
    }
  }
  const deliverable = existsSync(join(dir, "final.mp4")) ? "final.mp4" : durName;

  const shareDir = join(dir, "share");
  const framesDir = join(shareDir, "frames");
  await mkdir(framesDir, { recursive: true });

  // console.jsonl: copy from workdir if present, else create an empty one so the
  // bundle is self-contained and consumers can always rely on its presence.
  const srcConsole = join(dir, "console.jsonl");
  const destConsole = join(shareDir, "console.jsonl");
  let consoleText = "";
  if (existsSync(srcConsole)) {
    consoleText = await readFile(srcConsole, "utf8");
    await copyFile(srcConsole, destConsole);
  } else {
    await writeFile(destConsole, "");
  }
  const { errors, warnings } = tallyConsole(consoleText);

  // Clamp frame times against the FRAME video's own (natural-clock) duration,
  // which differs from the sped-up final.mp4 duration used for loom.json.
  const frameDur = frameName === durName ? videoDur : await duration(videoPath);

  // One keyframe per step.
  const steps = [];
  for (const step of timeline.steps || []) {
    const nn = String(step.i).padStart(2, "0");
    const rel = `frames/step_${nn}.png`;
    const out = join(shareDir, rel);
    const t = frameTime(step, frameDur);
    await exec(FFMPEG, [
      "-y",
      "-ss",
      String(t),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-update",
      "1",
      "-vf",
      "scale=1280:-2",
      out,
    ]);
    steps.push({
      i: step.i,
      name: step.name,
      narration: narrationByIndex.get(step.i) ?? step.narration ?? "",
      start: step.start,
      end: step.end,
      clicks: step.clicks || [],
      frame: rel,
    });
  }

  const loom = {
    version: 1,
    kind: "agent-loom",
    title: timeline.title || manifest.title || null,
    url: await resolveUrl(dir, timeline),
    video: `../${deliverable}`,
    duration: Math.round(videoDur * 10) / 10,
    rate,
    voice: { engine: manifest.engine ?? null, voice: manifest.voice ?? null },
    steps,
    console: {
      errors: errors.length,
      warnings: warnings.length,
      log: "console.jsonl",
    },
  };
  await writeFile(join(shareDir, "loom.json"), JSON.stringify(loom, null, 2) + "\n");

  // transcript.txt: "[mm:ss] narration" per narrated step, at the step start.
  const transcript = steps
    .filter((s) => s.narration)
    .map((s) => `[${mmss(s.start)}] ${s.narration}`)
    .join("\n");
  await writeFile(join(shareDir, "transcript.txt"), transcript + (transcript ? "\n" : ""));

  console.log(`[share] wrote ${shareDir} (${steps.length} steps, ${errors.length} console errors)`);
  return shareDir;
}

// Resolve a workdir OR a share dir to the directory that holds loom.json.
function findShareDir(input) {
  const d = resolve(input);
  if (existsSync(join(d, "loom.json"))) return d;
  if (existsSync(join(d, "share", "loom.json"))) return join(d, "share");
  return null;
}

/**
 * Read a built share bundle and return an agent-oriented digest string.
 * Accepts a workdir or a share dir.
 */
export async function readLoom(input) {
  const shareDir = findShareDir(input);
  if (!shareDir) {
    throw new Error(`read: no share bundle at ${input} (run \`loom share\` first)`);
  }
  const loom = await readJson(join(shareDir, "loom.json"));

  const lines = [];
  lines.push(loom.title || "(untitled loom)");
  lines.push(`url:      ${loom.url ?? "(unknown)"}`);
  lines.push(`duration: ${loom.duration}s${loom.rate && loom.rate !== 1 ? ` (${loom.rate}x)` : ""}`);
  lines.push(`voice:    ${loom.voice?.voice ?? "?"} (${loom.voice?.engine ?? "?"})`);
  lines.push("");
  lines.push("steps:");
  for (const s of loom.steps || []) {
    const n = (s.clicks || []).length;
    lines.push(
      `  [${mmss(s.start)}–${mmss(s.end)}] ${s.name}: ${s.narration}` +
        ` (clicks: ${n}, frame: ${s.frame})`
    );
  }

  // Console summary + first 5 error lines, read from the bundle's own log.
  const c = loom.console || { errors: 0, warnings: 0 };
  lines.push("");
  lines.push(`console:  ${c.errors} error(s), ${c.warnings} warning(s)`);
  const logPath = join(shareDir, c.log || "console.jsonl");
  if (c.errors > 0 && existsSync(logPath)) {
    const { errors } = tallyConsole(await readFile(logPath, "utf8"));
    for (const e of errors.slice(0, 5)) {
      const at = typeof e.t === "number" ? `[${e.t.toFixed(2)}] ` : "";
      lines.push(`    ${at}${e.text ?? ""}`);
    }
    if (errors.length > 5) lines.push(`    … ${errors.length - 5} more`);
  }

  return lines.join("\n");
}

// Direct CLI: node src/share/share.mjs --workdir <dir> [--read]
const isMain = resolve(process.argv[1] || "") === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  const idx = args.indexOf("--workdir");
  const workdir = idx >= 0 ? args[idx + 1] : args.find((a) => !a.startsWith("--"));
  const readOnly = args.includes("--read");
  if (!workdir) {
    console.error("usage: node src/share/share.mjs --workdir <dir> [--read]");
    process.exit(1);
  }
  (async () => {
    if (!readOnly) await shareLoom(workdir);
    console.log("\n" + (await readLoom(workdir)));
  })()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[share] failed:", err);
      process.exit(1);
    });
}
