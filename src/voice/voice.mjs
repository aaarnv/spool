// `spool voice`: the user's own voice for narration. The provider model is created and
// held on the platform, so the CLI only records a sample, uploads it, and reads status.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, mkdir, rm } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { resolveConfig } from "../publish/publish.mjs";
import { readPrefs, writePrefs } from "../config/prefs.mjs";
import { VOICE_SCRIPT } from "./script.mjs";

const SAMPLE_PATH = join(homedir(), ".spool", "voice-sample.wav");
const SECONDS_MIN = 10;
const SECONDS_MAX = 60;
const GRACE_S = 10;

const MIC_HELP =
  "Could not open the microphone. On macOS, allow your terminal under System Settings > " +
  "Privacy & Security > Microphone, then run again; or pass a file: spool voice clone ~/me.m4a";

const TYPES = {
  ".wav": "audio/wav",
  ".webm": "audio/webm",
  ".m4a": "audio/mp4",
  ".mp4": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".opus": "audio/opus",
  ".ogg": "audio/ogg",
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// host + token, the pair `spool publish` already uses. A voice belongs to the account.
async function account(opts) {
  const { host, token } = await resolveConfig(opts);
  if (typeof token !== "string" || !token.trim()) {
    fail("This machine is not connected to a Spool account. Run `spool login` first.");
  }
  return { host, token };
}

async function voiceFetch({ host, token }, method, body) {
  let res;
  try {
    res = await fetch(`${host}/api/voice`, { method, headers: { Authorization: `Bearer ${token}` }, body });
  } catch (e) {
    return fail(`Could not reach ${host}: ${e.message}`);
  }
  if (res.status === 204) return null;
  const text = await res.text().catch(() => "");
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* an error body that is not json */
  }
  if (!res.ok) return fail(json?.error || `voice ${res.status}: ${text.slice(0, 200)}`);
  return json;
}

const dateOf = (value) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value ?? "") : d.toISOString().slice(0, 10);
};

/** `spool voice`: print the current voice, or say there is none. */
export async function showVoice(opts = {}) {
  const cfg = await account(opts);
  const voice = (await voiceFetch(cfg, "GET"))?.voice;
  if (!voice) {
    console.log("No custom voice yet. Run `spool voice clone` to record one.");
    return;
  }
  console.log(`${voice.title}, cloned ${dateOf(voice.createdAt)}.`);
  console.log("Every spool speaks in it. Run `spool voice remove` to go back to the house voice.");
}

/** `spool voice remove`: drop the voice; the hosted engine returns to the house voice. */
export async function removeVoice(opts = {}) {
  const cfg = await account(opts);
  await voiceFetch(cfg, "DELETE");
  console.log("Voice removed.");
}

/** `spool voice clone [file]`: record (or take) a sample, upload it, pin the hosted engine. */
export async function cloneVoice(file, opts = {}) {
  const cfg = await account(opts);
  let path = null;
  let text = null;
  if (file) {
    path = resolve(file);
    if (!existsSync(path)) fail(`No such file: ${path}`);
  } else {
    const seconds = Number(opts.seconds ?? 20);
    if (!Number.isFinite(seconds) || seconds < SECONDS_MIN || seconds > SECONDS_MAX) {
      fail(`--seconds must be between ${SECONDS_MIN} and ${SECONDS_MAX}.`);
    }
    path = await recordSample(Math.round(seconds), opts.device);
    text = VOICE_SCRIPT;
  }

  const bytes = await readFile(path);
  const form = new FormData();
  const type = TYPES[extname(path).toLowerCase()] || "application/octet-stream";
  form.append("sample", new Blob([bytes], { type }), basename(path));
  if (text) form.append("text", text);
  form.append("title", "Your voice");

  console.error("Cloning your voice…");
  await voiceFetch(cfg, "POST", form);
  await useHostedEngine();
  console.log("Your voice is ready. Every spool from now on speaks in it.");
  console.log(`Sample: ${await describeSample(path, bytes.length)}`);
}

// A cloned voice is only reachable through the hosted engine, so pin it once.
async function useHostedEngine() {
  const prefs = await readPrefs();
  if (prefs.engine === "hosted") return;
  await writePrefs({ ...prefs, engine: "hosted" });
  console.log("Voice engine set to hosted.");
}

async function describeSample(path, size) {
  const mb = `${(size / 1024 / 1024).toFixed(1)} MB`;
  const { code, stdout } = await run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nk=1:nw=1", path]);
  const seconds = code === 0 ? parseFloat(stdout.trim()) : NaN;
  return Number.isFinite(seconds) ? `${seconds.toFixed(1)} s, ${mb}, ${path}` : `${mb}, ${path}`;
}

// --- recording -------------------------------------------------------------

async function recordSample(seconds, device) {
  await mkdir(dirname(SAMPLE_PATH), { recursive: true });
  // Resolve the device first: a name that matches nothing must not cost a countdown.
  const inputs = await captureInputs(device);
  console.log("Read this out loud, at your normal pace:\n");
  console.log(VOICE_SCRIPT + "\n");
  for (let n = 3; n >= 1; n--) {
    process.stderr.write(`Recording in ${n}…\n`);
    await sleep(1000);
  }

  let last = null;
  for (const input of inputs) {
    // A mic macOS has not allowed opens but sends no samples, so ffmpeg never reaches -t.
    await rm(SAMPLE_PATH, { force: true });
    const stop = counter(seconds);
    const { code, stderr } = await run(
      "ffmpeg",
      ["-y", "-hide_banner", "-loglevel", "error", ...input, "-t", String(seconds), "-ar", "44100", "-ac", "1", "-c:a", "pcm_s16le", SAMPLE_PATH],
      (seconds + GRACE_S) * 1000
    );
    stop();
    if (code === 0 && existsSync(SAMPLE_PATH)) return SAMPLE_PATH;
    last = stderr;
  }
  if (last) console.error(last.trim().split("\n").slice(-2).join("\n"));
  return fail(MIC_HELP);
}

// The ffmpeg input flags to try, in order. Linux has two device layers; macOS has one.
async function captureInputs(device) {
  if (process.platform === "darwin") return [["-f", "avfoundation", "-i", `:${await macAudioIndex(device)}`]];
  if (process.platform === "linux") return [["-f", "pulse", "-i", "default"], ["-f", "alsa", "-i", "default"]];
  return fail(`Recording is not supported on ${process.platform}. Pass a file: spool voice clone ~/me.m4a`);
}

// avfoundation has no device called "default", so an index is the only way in.
async function macAudioIndex(device) {
  const { stderr } = await run("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""]);
  const lines = stderr.split("\n");
  const head = lines.findIndex((l) => /AVFoundation audio devices/.test(l));
  const devices = [];
  if (head >= 0) {
    for (const line of lines.slice(head + 1)) {
      const m = /\[(\d+)\]\s+(\S.*?)\s*$/.exec(line);
      if (m) devices.push({ index: m[1], name: m[2] });
    }
  }
  if (!devices.length) return fail(MIC_HELP);
  if (!device) return devices[0].index;
  const hit = devices.find((d) => d.name.toLowerCase().includes(device.toLowerCase()));
  if (!hit) fail(`No microphone matching "${device}". This machine has: ${devices.map((d) => d.name).join(", ")}.`);
  return hit.index;
}

// A moving seconds counter while ffmpeg records. Returns the function that stops it.
function counter(seconds) {
  const t0 = Date.now();
  const tty = !!process.stderr.isTTY;
  const timer = setInterval(() => {
    const n = Math.min(seconds, Math.round((Date.now() - t0) / 1000));
    process.stderr.write(tty ? `\r${n} s / ${seconds} s ` : `${n} s / ${seconds} s\n`);
  }, 1000);
  return () => {
    clearInterval(timer);
    process.stderr.write(tty ? "\r                    \r" : "");
  };
}

function run(cmd, args, timeoutMs = 0) {
  return new Promise((res) => {
    const p = spawn(cmd, args);
    let stdout = "";
    let stderr = "";
    const timer = timeoutMs
      ? setTimeout(() => {
          stderr += `${cmd} sent nothing for ${Math.round(timeoutMs / 1000)}s`;
          p.kill("SIGKILL");
        }, timeoutMs)
      : null;
    p.stdout.on("data", (d) => (stdout += d));
    p.stderr.on("data", (d) => (stderr += d));
    p.on("error", (e) => res({ code: 127, stdout, stderr: `${cmd} not available: ${e.message}` }));
    p.on("close", (code) => {
      if (timer) clearTimeout(timer);
      res({ code, stdout, stderr });
    });
  });
}
