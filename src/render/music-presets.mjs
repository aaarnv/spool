// Music beds for vertical spools: CC0 loops shipped in assets/ (provenance in
// LICENSE-NOTE.md), so the OSS repo stays copyright-clean. Preset names round-trip
// through render.json, so the Linux edit worker re-resolves them from the repo; a
// custom path only resolves on the machine that holds it (documented in CONTRACTS.md).
import { existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(dirname(dirname(__dirname)), "assets");

export const MUSIC_PRESETS = {
  uplift: "music-uplift.m4a",
  calm: "music-calm.m4a",
};

export const MUSIC_PRESET_NAMES = Object.keys(MUSIC_PRESETS);

// Used when no music is specified, and when a requested bed can't be resolved.
export const DEFAULT_MUSIC = "uplift";

const presetSource = (name) => ({ source: join(ASSETS_DIR, MUSIC_PRESETS[name]), tag: name, kind: "preset" });

/**
 * Resolve a music spec to { source, tag, kind }, or null for "no music".
 *  - null/false/""/"none" → null (silent render)
 *  - preset name          → assets/music-<preset>.m4a
 *  - filesystem path      → used as-is
 *  - anything else        → warn + DEFAULT_MUSIC
 * Never throws. Presets are returned without an existence check; the caller stages
 * the file and decides what a missing asset means.
 */
export function resolveMusicSource(music) {
  if (music == null || music === false || music === "" || music === "none") return null;
  if (MUSIC_PRESETS[music]) return presetSource(music);

  const p = resolve(String(music));
  if (existsSync(p)) return { source: p, tag: String(music), kind: "path" };

  console.warn(`[music] "${music}" is not a preset or a file; using ${DEFAULT_MUSIC}`);
  return presetSource(DEFAULT_MUSIC);
}
