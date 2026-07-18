import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { effectivePrefs, browserChannel } from "../config/prefs.mjs";

const run = promisify(execFile);
const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

// One check result. status: ok | warn | fail. A fail on a hard dep exits 1.
const ok = (name, detail) => ({ name, status: "ok", detail });
const warn = (name, detail, hint) => ({ name, status: "warn", detail, hint });
const fail = (name, detail, hint) => ({ name, status: "fail", detail, hint });

// First non-empty line of a `--version` style output.
const firstLine = (s) => (s || "").split("\n").map((l) => l.trim()).find(Boolean) || "";

async function checkNode() {
  const major = parseInt(process.versions.node, 10);
  if (major >= 20) return ok("node", `v${process.versions.node}`);
  return fail("node", `v${process.versions.node}`, "spool needs node >= 20 (https://nodejs.org)");
}

async function checkFfmpeg() {
  try {
    const { stdout } = await run(FFMPEG, ["-version"]);
    return ok("ffmpeg", firstLine(stdout));
  } catch {
    return fail("ffmpeg", `not found (${FFMPEG})`, "install it (macOS: brew install ffmpeg) or set FFMPEG to its path");
  }
}

async function checkFfprobe() {
  try {
    const { stdout } = await run(FFPROBE, ["-version"]);
    return ok("ffprobe", firstLine(stdout));
  } catch {
    return fail("ffprobe", `not found (${FFPROBE})`, "ships with ffmpeg (brew install ffmpeg) or set FFPROBE to its path");
  }
}

async function checkChromium() {
  try {
    const { chromium } = await import("playwright");
    const path = chromium.executablePath();
    if (path && existsSync(path)) return ok("chromium", path);
    return fail("chromium", "playwright browser not installed", "npx playwright install chromium");
  } catch {
    return fail("chromium", "playwright not resolvable", "npx playwright install chromium");
  }
}

async function checkGh() {
  try {
    await run("gh", ["--version"]);
  } catch {
    return warn("gh", "not found", "only needed for `spool pr` and `spool publish --pr` (https://cli.github.com)");
  }
  try {
    await run("gh", ["auth", "status"]);
    return ok("gh", "authenticated");
  } catch {
    return warn("gh", "present but not authenticated", "run `gh auth login` before using PR features");
  }
}

// Never print the token; mask to its first 6 chars. Legacy = present but not spk_.
async function checkConfig() {
  const cfgPath = join(homedir(), ".spool.json");
  if (!existsSync(cfgPath)) {
    return warn("config", "no ~/.spool.json", "get a token at https://spoolkit.dev/dashboard, then write ~/.spool.json {host, token}");
  }
  let cfg;
  try {
    cfg = JSON.parse(await readFile(cfgPath, "utf8"));
  } catch {
    return warn("config", "~/.spool.json is malformed", "must be valid JSON: {host, token}");
  }
  const bits = [];
  if (!cfg.host) bits.push("host missing");
  const t = cfg.token;
  if (!t) {
    bits.push("token absent");
  } else if (!String(t).startsWith("spk_")) {
    bits.push(`legacy token (${String(t).slice(0, 6)}…)`);
  }
  if (bits.length) return warn("config", bits.join(", "), "regenerate a token at https://spoolkit.dev/dashboard");
  return ok("config", `host=${cfg.host}, token=${String(t).slice(0, 6)}…`);
}

async function resolveConf() {
  let cfg = {};
  const cfgPath = join(homedir(), ".spool.json");
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(await readFile(cfgPath, "utf8"));
    } catch {
      /* handled by checkConfig */
    }
  }
  const host = (process.env.SPOOL_HOST || cfg.host || "").replace(/\/$/, "");
  const token = process.env.SPOOL_PUBLISH_TOKEN || cfg.token;
  return { host, token };
}

// GET {host}/ within 5s; reachability only, a 200 is expected.
async function checkHost(host) {
  if (!host) return warn("host", "no host configured", "set SPOOL_HOST or host in ~/.spool.json");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${host}/`, { signal: ctrl.signal });
    if (res.status === 200) return ok("host", `${host} reachable (200)`);
    return warn("host", `${host} returned ${res.status}`, "expected 200 from the watch app root");
  } catch (e) {
    return warn("host", `${host} unreachable (${e.name === "AbortError" ? "timeout" : e.message})`, "check the host URL / your network");
  } finally {
    clearTimeout(timer);
  }
}

// Validate the token against a cheap authed endpoint. POST /api/vo with an empty
// body: a bad token 401s before any usage is counted; a valid token 400s (missing
// text) with no side effect. Non-401/403 => auth accepted.
async function checkToken(host, token) {
  if (!token) return warn("token", "no token to verify", "add a token to ~/.spool.json to enable publishing");
  if (!host) return warn("token", "not verifiable offline (no host)", "set a host to verify the token");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${host}/api/vo`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: ctrl.signal,
    });
    if (res.status === 401 || res.status === 403) {
      return warn("token", `rejected by ${host} (${res.status})`, "regenerate a token at https://spoolkit.dev/dashboard");
    }
    return ok("token", `accepted by ${host}`);
  } catch (e) {
    return warn("token", `not verifiable (${e.name === "AbortError" ? "timeout" : e.message})`, "host unreachable, skipped");
  } finally {
    clearTimeout(timer);
  }
}

// OPENAI_API_KEY chain: env → ./.env → ~/.spool.json openaiKey. Never print the key.
async function checkOpenAI() {
  if (process.env.OPENAI_API_KEY) return ok("openai-key", "resolved (env OPENAI_API_KEY)");
  try {
    const m = (await readFile(join(process.cwd(), ".env"), "utf8")).match(/^\s*OPENAI_API_KEY\s*=\s*(.+)$/m);
    if (m && m[1].trim()) return ok("openai-key", "resolved (./.env)");
  } catch {
    /* try next source */
  }
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), ".spool.json"), "utf8"));
    if (cfg.openaiKey) return ok("openai-key", "resolved (~/.spool.json openaiKey)");
  } catch {
    /* none */
  }
  return warn("openai-key", "not set", "hosted voice works without it; else set OPENAI_API_KEY (env, ./.env, or ~/.spool.json)");
}

// Report the active preference profile (browser/target/engine/bg + source). When
// browser is chrome/edge, verify that channel actually launches on this machine.
async function checkPrefs() {
  const eff = await effectivePrefs();
  const profile = Object.keys(eff)
    .map((k) => `${k}=${eff[k].value ?? "-"}(${eff[k].source})`)
    .join("  ");
  const browser = eff.browser.value;
  const channel = browserChannel(browser, () => {});
  if (browser === "chrome" || browser === "edge") {
    if (!channel) return warn("prefs", profile, `unknown browser "${browser}"; run \`spool setup --browser chromium\``);
    try {
      const { chromium } = await import("playwright");
      const b = await chromium.launch({ channel, headless: true });
      await b.close();
    } catch (e) {
      return warn("prefs", profile, `browser="${browser}" (${channel}) not launchable (${(e && e.message) || e}); install it or run \`spool setup --browser chromium\``);
    }
  }
  return ok("prefs", profile);
}

async function checkSips() {
  if (platform() !== "darwin") return null;
  try {
    await run("sips", ["--help"]);
    return ok("sips", "present (macOS background compositing)");
  } catch {
    return warn("sips", "not found", "macOS-only; background wallpaper compositing degrades without it");
  }
}

// Run every check in sequence and return the results array.
async function runChecks() {
  const results = [];
  results.push(await checkNode());
  results.push(await checkFfmpeg());
  results.push(await checkFfprobe());
  results.push(await checkChromium());
  results.push(await checkGh());
  results.push(await checkConfig());
  const { host, token } = await resolveConf();
  results.push(await checkHost(host));
  results.push(await checkToken(host, token));
  results.push(await checkOpenAI());
  results.push(await checkPrefs());
  const sips = await checkSips();
  if (sips) results.push(sips);
  return results;
}

const MARK = { ok: "✓", warn: "⚠", fail: "✗" };

export async function doctor({ json = false } = {}) {
  const results = await runChecks();
  const hardFail = results.some((r) => r.status === "fail");
  if (json) {
    console.log(JSON.stringify({ ok: !hardFail, checks: results }, null, 2));
    return hardFail ? 1 : 0;
  }
  console.log("spool doctor\n");
  for (const r of results) {
    const line = `${MARK[r.status]} ${r.name.padEnd(11)} ${r.detail || ""}`.trimEnd();
    console.log(line);
    if (r.hint && r.status !== "ok") console.log(`  → ${r.hint}`);
  }
  const warns = results.filter((r) => r.status === "warn").length;
  const fails = results.filter((r) => r.status === "fail").length;
  console.log(`\n${fails} failing, ${warns} warning(s).`);
  if (hardFail) console.log("Fix the failing checks above before recording.");
  return hardFail ? 1 : 0;
}
