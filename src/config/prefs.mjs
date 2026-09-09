// Installation preferences. A key's config lives on the platform; ~/.spool.json holds
// the machine copy plus host/token/openaiKey. Precedence everywhere:
// explicit arg > env > platform key config > prefs > default.
import { existsSync } from "node:fs";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const PREFS_PATH = join(homedir(), ".spool.json");

// Built-in defaults for each preference. bg has no default (renderer falls back on its own).
// The hosted platform is the default publish origin everywhere; self-hosting is
// opt-in via SPOOL_HOST, --host, or a manual host entry in ~/.spool.json.
export const DEFAULT_HOST = "https://spoolkit.dev";

export const DEFAULTS ={ browser: "chromium", target: "browser", engine: "auto", bg: null, format: "wide" };

// Allowed values per key (bg is free-form). Env var that overrides each pref.
export const CHOICES = {
  browser: ["chromium", "chrome", "edge"],
  target: ["browser", "os"],
  engine: ["auto", "openrouter", "openai", "hosted", "fish", "local", "none"],
  format: ["wide", "vertical"],
};
const ENV = { browser: "SPOOL_BROWSER", target: "SPOOL_TARGET", engine: "SPOOL_ENGINE", bg: "SPOOL_BG", format: "SPOOL_FORMAT" };

// What `spool setup` asks about. `bg` and `format` are resolved from the workdir and
// the house defaults; they stay readable here only as SPOOL_BG / SPOOL_FORMAT escapes.
export const SETUP_KEYS = ["browser", "target", "engine"];

// The five fields a key's config on the platform can hold.
export const CONFIG_KEYS = ["browser", "target", "engine", "bg", "format"];

// A preset name, a wallpaper name, or a path. Mirrors the platform validator.
const BG_RE = /^[A-Za-z0-9._~/-]{1,80}$/;

const READ_TIMEOUT_MS = 2000;
const WRITE_TIMEOUT_MS = 8000;
const CACHE_FRESH_MS = 60000;

// Read ~/.spool.json (unknown keys preserved). Returns {} when absent or malformed.
export async function readPrefs() {
  if (!existsSync(PREFS_PATH)) return {};
  try {
    return JSON.parse(await readFile(PREFS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// Read-modify-write ~/.spool.json; chmod 600 only when creating it.
export async function writePrefs(obj) {
  const creating = !existsSync(PREFS_PATH);
  await writeFile(PREFS_PATH, JSON.stringify(obj, null, 2) + "\n");
  if (creating) await chmod(PREFS_PATH, 0o600);
}

// --- The platform layer ----------------------------------------------------

// Hosted {host, token} from env, then ~/.spool.json; null when either half is missing.
// The one rule the VO layer, `spool setup` and the config layer all share.
export async function resolveHosted() {
  let host = process.env.SPOOL_HOST;
  let token = process.env.SPOOL_PUBLISH_TOKEN;
  if (!host || !token) {
    const cfg = await readPrefs();
    host = host || cfg.host;
    token = token || cfg.token;
  }
  return host && token ? { host: String(host).replace(/\/$/, ""), token } : null;
}

// Keep only the five known fields. A value this CLI does not understand is dropped, so
// a newer platform cannot feed an older CLI something it would pass to Playwright.
function sanitize(config) {
  if (!config || typeof config !== "object") return null;
  const out = {};
  for (const key of CONFIG_KEYS) {
    const value = config[key];
    if (typeof value !== "string" || !value) continue;
    if (CHOICES[key] && !CHOICES[key].includes(value)) continue;
    if (key === "bg" && !BG_RE.test(value)) continue;
    out[key] = value;
  }
  return Object.keys(out).length ? out : null;
}

async function cacheWrite(entry) {
  await writePrefs({ ...(await readPrefs()), platform: entry });
}

function cacheRead(prefs) {
  const block = prefs && prefs.platform;
  if (!block || typeof block !== "object") return null;
  return { at: Number(block.at) || 0, config: sanitize(block.config), label: block.label || null };
}

let pending = null;

// The key's config from the platform, memoized per process: at most one request and one
// cache write per run. null when this machine is not connected to an account.
export function platformConfig() {
  pending ||= loadPlatform();
  return pending;
}

async function loadPlatform() {
  const hosted = await resolveHosted();
  if (!hosted) return null;
  const cached = cacheRead(await readPrefs());
  if (cached && Date.now() - cached.at < CACHE_FRESH_MS) return { config: cached.config, label: cached.label };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), READ_TIMEOUT_MS);
  try {
    const res = await fetch(`${hosted.host}/api/config`, {
      headers: { authorization: `Bearer ${hosted.token}` },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    const entry = { at: Date.now(), config: sanitize(body && body.config), label: (body && body.key && body.key.label) || null };
    await cacheWrite(entry);
    return { config: entry.config, label: entry.label };
  } catch {
    if (!cached) return null;
    console.error("[spool] platform config unreachable; using the last known copy");
    return { config: cached.config, label: cached.label };
  } finally {
    clearTimeout(timer);
  }
}

async function putPlatform({ host, token }, patch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), WRITE_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${host}/api/config`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(patch),
      signal: ctrl.signal,
    });
  } catch (e) {
    throw new Error(`could not reach ${host}: ${(e && e.message) || e}`);
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* an error body that is not json */
  }
  if (!res.ok) throw new Error((body && body.error) || `the platform refused the config (HTTP ${res.status})`);
  return sanitize(body && body.config);
}

// Save a config patch where it belongs: the key on the platform when this machine is
// connected, else ~/.spool.json. `local` forces the file. Throws if the platform refuses.
export async function saveConfig(patch, { local = false } = {}) {
  const hosted = local ? null : await resolveHosted();
  if (!hosted) {
    await writePrefs({ ...(await readPrefs()), ...patch });
    return { where: "local", path: PREFS_PATH };
  }
  const known = await platformConfig();
  const label = (known && known.label) || null;
  const config = await putPlatform(hosted, patch);
  await cacheWrite({ at: Date.now(), config, label });
  pending = Promise.resolve({ config, label });
  return { where: "platform", label, config };
}

// --- Resolvers -------------------------------------------------------------

// Resolve one preference: explicit > env > platform > prefs > default, plus the source.
function pick(prefs, key, explicit, platform) {
  const envVal = ENV[key] ? process.env[ENV[key]] : undefined;
  const keyed = platform && platform.config ? platform.config[key] : undefined;
  if (explicit != null && explicit !== "") return { value: explicit, source: "explicit" };
  if (envVal != null && envVal !== "") return { value: envVal, source: "env" };
  if (keyed != null && keyed !== "") return { value: keyed, source: "platform", label: platform.label };
  if (prefs[key] != null && prefs[key] !== "") return { value: prefs[key], source: "prefs" };
  return { value: DEFAULTS[key], source: "default" };
}

// One key, end to end. The platform is only asked when nothing above it already won.
async function resolveOne(key, explicit) {
  const envVal = ENV[key] ? process.env[ENV[key]] : undefined;
  if (explicit != null && explicit !== "") return { value: explicit, source: "explicit" };
  if (envVal != null && envVal !== "") return { value: envVal, source: "env" };
  const platform = await platformConfig();
  return pick(await readPrefs(), key, undefined, platform);
}

// Effective preference profile (no explicit flags) with per-key source; for doctor + `setup --show`.
export async function effectivePrefs() {
  const platform = await platformConfig();
  const prefs = await readPrefs();
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = pick(prefs, key, undefined, platform);
  return out;
}

// Map a browser preference to a Playwright launch channel. chromium => undefined
// (bundled). Unknown values warn and fall back to chromium.
export function browserChannel(value, warn = console.warn) {
  if (!value || value === "chromium") return undefined;
  if (value === "chrome") return "chrome";
  if (value === "edge") return "msedge";
  warn(`[spool] unknown browser "${value}"; using chromium`);
  return undefined;
}

// Launch channel for record/live: explicit > env SPOOL_BROWSER > platform > prefs > chromium.
export async function resolveLaunchChannel(explicit) {
  const { value } = await resolveOne("browser", explicit);
  return browserChannel(value);
}

// Default recording target: explicit > env SPOOL_TARGET > platform > prefs > "browser".
export async function resolveTarget(explicit) {
  return (await resolveOne("target", explicit)).value;
}

// VO engine default: env SPOOL_ENGINE > platform > prefs.engine, unless "auto" (=> null,
// keep generateVO's auto-detect). Explicit --engine is handled by the caller before this.
export async function resolveEnginePref() {
  const { value } = await resolveOne("engine", undefined);
  return value && value !== "auto" ? value : null;
}

// Default render background: explicit > env SPOOL_BG > platform > prefs.bg > null.
export async function resolveBgPref(explicit) {
  return (await resolveOne("bg", explicit)).value;
}

// Render format: explicit > env SPOOL_FORMAT > platform > prefs > "wide". Callers fold
// a steps.mjs `config.format` into the explicit slot (see resolveWorkdirFormat).
export async function resolveFormatPref(explicit) {
  return (await resolveOne("format", explicit)).value;
}
