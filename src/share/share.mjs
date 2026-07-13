import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, copyFile, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { buildWindows } from "../render/retime.mjs";

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

// Resolve a `spool pr` scaffold in the workdir into the spool.json `pr` summary,
// mapping each tour stop to the recorded step (by `stop.step ?? stop.id` vs step
// name) so the watch page can anchor a seek. Returns null when not a PR guide.
async function buildPrSummary(dir, steps) {
  const prPath = join(dir, "pr.json");
  const tourPath = join(dir, "tour.json");
  if (!existsSync(prPath) || !existsSync(tourPath)) return null;
  const info = await readJson(prPath);
  const tour = await readJson(tourPath);
  const byName = new Map((steps || []).map((s, idx) => [s.name, idx]));
  const unmatched = [];
  const stops = (tour.stops || []).map((stop) => {
    const key = stop.step ?? stop.id;
    const matched = byName.has(key) ? byName.get(key) : null;
    if (matched === null) unmatched.push(stop.id);
    return {
      id: stop.id,
      heading: stop.heading ?? "",
      prose: stop.prose ?? "",
      files: stop.files ?? [],
      step: matched,
    };
  });
  if (unmatched.length) {
    console.error(`[share] PR guide: ${unmatched.length} stop(s) not mapped to a recorded step (prose+diff only): ${unmatched.join(", ")}`);
  }
  return {
    number: info.number,
    url: info.url,
    title: info.title,
    additions: info.additions,
    deletions: info.deletions,
    changedFiles: info.changedFiles,
    mode: tour.mode ?? null,
    stops,
  };
}

/**
 * Write the agent-consumable share/ bundle for a spool workdir.
 * See CONTRACTS.md "share/ bundle".
 */
export async function shareSpool(workdir) {
  const dir = resolve(workdir);
  const timeline = await readJson(join(dir, "timeline.json"));
  const manifest = await readJson(join(dir, "vo", "manifest.json"));
  const narrationByIndex = new Map(
    (manifest.segments || []).map((s) => [s.i, s.narration])
  );

  // Frames come from the pre-speed normalize output (video.mp4), whose clock
  // matches timeline.json — final.mp4 is time-compressed by `rate`, so pulling
  // frames from it would land on the wrong moments. Duration, though, is read
  // from the actual deliverable (final.mp4) so spool.json reports true runtime.
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
  // which differs from the sped-up final.mp4 duration used for spool.json.
  const frameDur = frameName === durName ? videoDur : await duration(videoPath);

  // spool.json reports the OUTPUT timeline (window-based) — that's the clock a
  // consuming agent sees in final.mp4. Keyframes, though, are pulled from the
  // recording-clock frame video, so extraction still uses timeline.steps times.
  const { windows } = buildWindows(timeline, manifest);
  const windowByIndex = new Map(windows.map((w) => [w.i, w]));

  // One keyframe per step.
  const steps = [];
  for (const step of timeline.steps || []) {
    const nn = String(step.i).padStart(2, "0");
    const rel = `frames/step_${nn}.png`;
    const out = join(shareDir, rel);
    const t = frameTime(step, frameDur); // recording clock (frame video)
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
    const w = windowByIndex.get(step.i);
    steps.push({
      i: step.i,
      name: step.name,
      narration: narrationByIndex.get(step.i) ?? step.narration ?? "",
      start: w ? +w.startSec.toFixed(3) : step.start,
      end: w ? +w.endSec.toFixed(3) : step.end,
      clicks: w ? w.outClicks : step.clicks || [],
      frame: rel,
    });
  }

  // preview.gif: the step keyframes cycled (~1.1s each, 640w) — embeddable where
  // video players aren't (GitHub PR comments render GIFs; an MP4 link doesn't).
  if (steps.length) {
    const gifOut = join(shareDir, "preview.gif");
    const concatList = steps.map((s) => `file '${join(shareDir, s.frame)}'\nduration 1.1`).join("\n");
    const listPath = join(shareDir, ".preview-frames.txt");
    await writeFile(listPath, concatList + "\n");
    await exec(FFMPEG, [
      "-y", "-f", "concat", "-safe", "0", "-i", listPath,
      "-vf", "scale=640:-2,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer",
      "-loop", "0", gifOut,
    ]).catch((e) => console.error(`[share] preview.gif skipped: ${e.message}`));
    await rm(listPath, { force: true }).catch(() => {});
  }

  // PR guide (optional): if the workdir is a `spool pr` scaffold, attach a `pr`
  // summary so the watch page never needs tour.json. Stop ids map to recorded step
  // names; unmatched stops degrade to prose+diff only (step: null), never fail.
  const pr = await buildPrSummary(dir, steps);

  const spool = {
    version: 1,
    kind: "spool",
    title: timeline.title || manifest.title || null,
    url: await resolveUrl(dir, timeline),
    video: `../${deliverable}`,
    duration: Math.round(videoDur * 10) / 10,
    rate,
    voice: { engine: manifest.engine ?? null, voice: manifest.voice ?? null },
    steps,
    ...(pr ? { pr } : {}),
    console: {
      errors: errors.length,
      warnings: warnings.length,
      log: "console.jsonl",
    },
  };
  await writeFile(join(shareDir, "spool.json"), JSON.stringify(spool, null, 2) + "\n");

  // transcript.txt: "[mm:ss] narration" per narrated step, at the step start.
  const transcript = steps
    .filter((s) => s.narration)
    .map((s) => `[${mmss(s.start)}] ${s.narration}`)
    .join("\n");
  await writeFile(join(shareDir, "transcript.txt"), transcript + (transcript ? "\n" : ""));

  console.log(`[share] wrote ${shareDir} (${steps.length} steps, ${errors.length} console errors)`);
  return shareDir;
}

// Resolve a workdir OR a share dir to the directory that holds spool.json.
function findShareDir(input) {
  const d = resolve(input);
  if (existsSync(join(d, "spool.json"))) return d;
  if (existsSync(join(d, "share", "spool.json"))) return join(d, "share");
  return null;
}

/**
 * Read a built share bundle and return an agent-oriented digest string.
 * Accepts a workdir or a share dir.
 */
export async function readSpool(input) {
  const shareDir = findShareDir(input);
  if (!shareDir) {
    throw new Error(`read: no share bundle at ${input} (run \`spool share\` first)`);
  }
  const spool = await readJson(join(shareDir, "spool.json"));

  const lines = [];
  lines.push(spool.title || "(untitled spool)");
  lines.push(`url:      ${spool.url ?? "(unknown)"}`);
  lines.push(`duration: ${spool.duration}s${spool.rate && spool.rate !== 1 ? ` (${spool.rate}x)` : ""}`);
  lines.push(`voice:    ${spool.voice?.voice ?? "?"} (${spool.voice?.engine ?? "?"})`);
  lines.push("");
  lines.push("steps:");
  for (const s of spool.steps || []) {
    const n = (s.clicks || []).length;
    lines.push(
      `  [${mmss(s.start)}–${mmss(s.end)}] ${s.name}: ${s.narration}` +
        ` (clicks: ${n}, frame: ${s.frame})`
    );
  }

  // Console summary + first 5 error lines, read from the bundle's own log.
  const c = spool.console || { errors: 0, warnings: 0 };
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
    if (!readOnly) await shareSpool(workdir);
    console.log("\n" + (await readSpool(workdir)));
  })()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("[share] failed:", err);
      process.exit(1);
    });
}
