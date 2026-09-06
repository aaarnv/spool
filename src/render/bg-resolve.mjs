// Background resolution: turns a `--bg` spec into an on-disk image to composite.
// Resolution order (per the render contract):
//   1. repo preset name  → assets/bg-<preset>.jpg (shipped gradients)
//   2. macOS wallpaper    → installed still or video, converted to a cached JPG
//                           under ~/.spool-cache/bg/ (sips or ffmpeg)
//   3. filesystem path    → used as-is
//   4. fallback           → repo DEFAULT_BG preset
// macOS stills are resolved at RUNTIME (never shipped — they're Apple copyright) and
// only exist on a Mac; off-Mac (e.g. the Linux worker) the scan is empty and any
// wallpaper name falls through to the default. The published src/bg.jpg carries the
// resolved pixels across machines (see EDIT-CONTRACT.md).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat, rename, rm } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, dirname, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { BG_PRESETS, DEFAULT_BG, DEFAULT_MAC_WALLPAPER } from "./bg-presets.mjs";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(dirname(dirname(__dirname)), "assets");
const MAC_WALLPAPER_ROOT = "/System/Library/Desktop Pictures";
const CACHE_DIR = join(homedir(), ".spool-cache", "bg");
const IMAGE_EXT = new Set([".heic", ".jpg", ".jpeg", ".png", ".tiff"]);
const VIDEO_EXT = new Set([".mov", ".mp4"]);
const MAC_ALIASES = {
  tahoe: 'tahoe-day',
  'sonoma-light': 'sonoma-graphic-light-landscape',
  'sonoma-dark': 'sonoma-graphic-dark-landscape',
};

// Wallpaper "name" ⇄ key: lowercase, spaces→dashes, extension stripped. Lets a user
// pass "Sonoma", "sonoma", or "sonoma-horizon" interchangeably.
export const normalizeBgName = (s) =>
  String(s).trim().replace(/\.[^.]+$/, "").toLowerCase().replace(/\s+/g, "-");

const presetSource = (name) => ({ source: join(ASSETS_DIR, BG_PRESETS[name]), tag: name, kind: "preset" });

// Scan the macOS wallpaper dir for full-res stills → Map<normalizedName, absPath>.
// Top-level images, Solid Colors, and per-wallpaper stills/videos under .wallpapers/*/.
// Skips thumbnails and portrait video variants. Empty off-Mac / on error.
export async function scanMacWallpapers(root = MAC_WALLPAPER_ROOT) {
  const found = new Map();
  const add = (file, dir, prefix = '') => {
    if (!IMAGE_EXT.has(extname(file).toLowerCase()) && !VIDEO_EXT.has(extname(file).toLowerCase())) return;
    if (/thumbnail|portrait/i.test(file)) return;
    const key = normalizeBgName(file);
    if (!found.has(prefix + key)) found.set(prefix + key, join(dir, file));
  };
  // One unreadable folder must not hide unrelated wallpapers. Sort for stable
  // duplicate resolution and ignore directories that happen to have image suffixes.
  const entries = async (dir) => {
    try { return (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name)); }
    catch { return []; }
  };
  const scan = async (dir, prefix = '') => {
    for (const entry of await entries(dir)) {
      if (entry.isFile() || entry.isSymbolicLink()) add(entry.name, dir, prefix);
    }
  };
  await scan(root);
  await scan(join(root, 'Solid Colors'), 'solid-');
  const wpRoot = join(root, '.wallpapers');
  for (const entry of await entries(wpRoot)) {
    if (entry.isDirectory()) await scan(join(wpRoot, entry.name));
  }
  for (const [alias, name] of Object.entries(MAC_ALIASES)) {
    if (found.has(name) && !found.has(alias)) found.set(alias, found.get(name));
  }
  return found;
}

export async function listBackgrounds() {
  return [
    ...Object.keys(BG_PRESETS).map(name => ({ name, ...presetSource(name) })),
    ...[...await scanMacWallpapers()].sort(([a], [b]) => a.localeCompare(b))
      .map(([name, source]) => ({ name, source, kind: 'macos' })),
  ];
}

// Convert/normalize a source image to a cached JPG (downscaled to ≤3840 wide — the
// canvas is 1920px and cover-cropped, so more is wasted bytes). Cached by key so the
// (slow) HEIC decode runs once. Video frame extraction uses ffmpeg. The source
// fingerprint invalidates the cache after OS updates; atomic writes avoid partial
// JPEGs when multiple recordings request the same wallpaper concurrently.
async function toCachedJpg(key, srcPath) {
  await mkdir(CACHE_DIR, { recursive: true });
  const info = await stat(srcPath);
  const version = createHash('sha256').update(`${srcPath}:${info.size}:${info.mtimeMs}`).digest('hex').slice(0, 12);
  const dest = join(CACHE_DIR, `${key}-${version}.jpg`);
  if (existsSync(dest)) return dest;
  const temporary = join(CACHE_DIR, `${key}-${randomUUID()}.jpg`);
  try {
    if (VIDEO_EXT.has(extname(srcPath).toLowerCase())) {
      // Installed animated wallpapers become a still canvas, never an animation
      // competing with the demo. Frame zero is available even for short assets.
      await exec(process.env.FFMPEG || 'ffmpeg', [
        '-y', '-loglevel', 'error', '-i', srcPath, '-frames:v', '1',
        '-vf', "scale=w='min(3840,iw)':h=-2", '-q:v', '2', temporary,
      ]);
    } else {
      await exec("sips", ["-s", "format", "jpeg", "-Z", "3840", srcPath, "--out", temporary]);
    }
    await rename(temporary, dest);
  } finally {
    await rm(temporary, { force: true });
  }
  return dest;
}

/**
 * Resolve a bg spec to { source, tag, kind }.
 *  - source: absolute path to a compositable image (repo asset, cached JPG, or file)
 *  - tag:    what to stamp into render.json (preset name, wallpaper key, path, or default)
 *  - kind:   "preset" | "macos" | "path"
 * Never throws on a bad spec — unresolvable specs fall back to the default preset.
 */
export async function resolveBgSource(bg) {
  // No spec: the real macOS wallpaper when this machine has it, else the sky preset.
  if (!bg) bg = (await scanMacWallpapers()).has(DEFAULT_MAC_WALLPAPER) ? DEFAULT_MAC_WALLPAPER : DEFAULT_BG;
  if (BG_PRESETS[bg]) return presetSource(bg);

  // macOS wallpaper by (normalized) name.
  const key = normalizeBgName(bg);
  const wallpapers = await scanMacWallpapers();
  if (wallpapers.has(key)) {
    try {
      const source = await toCachedJpg(key, wallpapers.get(key));
      return { source, tag: key, kind: "macos" };
    } catch (e) {
      console.warn(`[bg] failed to convert macOS wallpaper "${bg}" (${(e && e.message) || e}) — using ${DEFAULT_BG}`);
      return presetSource(DEFAULT_BG);
    }
  }

  // Filesystem path (absolute or relative to cwd).
  const p = resolve(bg);
  if (existsSync(p)) return { source: p, tag: bg, kind: "path" };

  console.warn(`[bg] "${bg}" is not a preset, a macOS wallpaper, or a file — using ${DEFAULT_BG}`);
  return presetSource(DEFAULT_BG);
}
