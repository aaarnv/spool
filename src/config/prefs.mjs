// First-class installation preferences in ~/.spool.json (alongside host/token/openaiKey).
// Readers resolve with a single precedence everywhere: explicit arg > env > prefs > default.
import { existsSync } from "node:fs";
import { readFile, writeFile, chmod } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export const PREFS_PATH = join(homedir(), ".spool.json");

// Built-in defaults for each preference. bg has no default (renderer falls back on its own).
export const DEFAULTS = { browser: "chromium", target: "browser", engine: "auto", bg: null };

// Allowed values per key (bg is free-form). Env var that overrides each pref.
export const CHOICES = {
  browser: ["chromium", "chrome", "edge"],
  target: ["browser", "os"],
  engine: ["auto", "openai", "hosted", "local"],
};
const ENV = { browser: "SPOOL_BROWSER", target: "SPOOL_TARGET", engine: "SPOOL_ENGINE", bg: "SPOOL_BG" };

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

// Resolve one preference: explicit > env > prefs > default, plus which source won.
function pick(prefs, key, explicit) {
  const envVal = ENV[key] ? process.env[ENV[key]] : undefined;
  if (explicit != null && explicit !== "") return { value: explicit, source: "explicit" };
  if (envVal != null && envVal !== "") return { value: envVal, source: "env" };
  if (prefs[key] != null && prefs[key] !== "") return { value: prefs[key], source: "prefs" };
  return { value: DEFAULTS[key], source: "default" };
}

// Effective preference profile (no explicit flags) with per-key source; for doctor + `setup --show`.
export async function effectivePrefs() {
  const prefs = await readPrefs();
  const out = {};
  for (const key of Object.keys(DEFAULTS)) out[key] = pick(prefs, key, undefined);
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

// Launch channel for record/live: explicit > env SPOOL_BROWSER > prefs.browser > chromium.
export async function resolveLaunchChannel(explicit) {
  const { value } = pick(await readPrefs(), "browser", explicit);
  return browserChannel(value);
}

// Default recording target: explicit > env SPOOL_TARGET > prefs.target > "browser".
export async function resolveTarget(explicit) {
  return pick(await readPrefs(), "target", explicit).value;
}

// VO engine default: env SPOOL_ENGINE > prefs.engine, unless "auto" (=> null, keep
// generateVO's auto-detect). Explicit --engine is handled by the caller before this.
export async function resolveEnginePref() {
  const { value } = pick(await readPrefs(), "engine", undefined);
  return value && value !== "auto" ? value : null;
}

// Default render background: explicit > env SPOOL_BG > prefs.bg > null.
export async function resolveBgPref(explicit) {
  return pick(await readPrefs(), "bg", explicit).value;
}
