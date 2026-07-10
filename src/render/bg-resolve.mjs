// Background resolution: turns a `--bg` spec into an on-disk image to composite.
// Resolution order (per the render contract):
//   1. repo preset name  → assets/bg-<preset>.jpg (shipped gradients)
//   2. macOS wallpaper    → /System/Library/Desktop Pictures/<Name>, converted to a
//                           cached JPG under ~/.spool-cache/bg/ (HEIC via `sips`)
//   3. filesystem path    → used as-is
//   4. fallback           → repo DEFAULT_BG preset
// macOS stills are resolved at RUNTIME (never shipped — they're Apple copyright) and
// only exist on a Mac; off-Mac (e.g. the Linux worker) the scan is empty and any
// wallpaper name falls through to the default. The published src/bg.jpg carries the
// resolved pixels across machines (see EDIT-CONTRACT.md).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { mkdir, readdir, copyFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { BG_PRESETS, BG_PRESET_NAMES, DEFAULT_BG } from "./bg-presets.mjs";

const exec = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(dirname(dirname(__dirname)), "assets");
const MAC_WALLPAPER_ROOT = "/System/Library/Desktop Pictures";
const CACHE_DIR = join(homedir(), ".spool-cache", "bg");
const IMAGE_EXT = new Set([".heic", ".jpg", ".jpeg", ".png", ".tiff"]);

// Wallpaper "name" ⇄ key: lowercase, spaces→dashes, extension stripped. Lets a user
// pass "Sonoma", "sonoma", or "sonoma-horizon" interchangeably.
export const normalizeBgName = (s) =>
  String(s).trim().replace(/\.[^.]+$/, "").toLowerCase().replace(/\s+/g, "-");

const presetSource = (name) => ({ source: join(ASSETS_DIR, BG_PRESETS[name]), tag: name, kind: "preset" });

// Scan the macOS wallpaper dir for full-res stills → Map<normalizedName, absPath>.
// Top-level images + the per-wallpaper stills under .wallpapers/*/ (e.g. "Sonoma
// Horizon.heic"). Skips .thumbnails (those are ~200px). Empty off-Mac / on error.
export async function scanMacWallpapers() {
  const found = new Map();
  if (!existsSync(MAC_WALLPAPER_ROOT)) return found;
  const add = (file, dir) => {
    if (!IMAGE_EXT.has(extname(file).toLowerCase())) return;
    if (/thumbnail/i.test(file)) return; // low-res sidecar thumbnails, not usable as a canvas
    const key = normalizeBgName(file);
    if (!found.has(key)) found.set(key, join(dir, file));
  };
  try {
    for (const f of await readdir(MAC_WALLPAPER_ROOT)) add(f, MAC_WALLPAPER_ROOT);
    const wpRoot = join(MAC_WALLPAPER_ROOT, ".wallpapers");
    if (existsSync(wpRoot)) {
      for (const entry of await readdir(wpRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const sub = join(wpRoot, entry.name);
        for (const f of await readdir(sub)) add(f, sub);
      }
    }
  } catch {
    /* permission/IO race — return whatever we gathered */
  }
  return found;
}

// Convert/normalize a source image to a cached JPG (downscaled to ≤3840 wide — the
// canvas is 1920px and cover-cropped, so more is wasted bytes). Cached by key so the
// (slow) HEIC decode runs once. Requires `sips` (macOS only; only reached on a Mac).
async function toCachedJpg(key, srcPath) {
  await mkdir(CACHE_DIR, { recursive: true });
  const dest = join(CACHE_DIR, `${key}.jpg`);
  if (existsSync(dest)) return dest;
  await exec("sips", ["-s", "format", "jpeg", "-Z", "3840", srcPath, "--out", dest]);
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
  if (!bg) return presetSource(DEFAULT_BG);
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

// What `spool backgrounds` / `--bg list` reports: repo presets + this machine's
// macOS wallpapers (normalized names), and which is the default.
export async function listBackgrounds() {
  const wallpapers = [...(await scanMacWallpapers()).keys()].sort();
  return { presets: BG_PRESET_NAMES, default: DEFAULT_BG, wallpapers };
}

// Pretty one-shot printer shared by the CLI command and the `--bg list` shortcut.
export async function printBackgrounds(log = console.log) {
  const { presets, default: def, wallpapers } = await listBackgrounds();
  log("Backgrounds — pass any name (or an image path) to --bg:\n");
  log(`  repo presets:  ${presets.map((p) => (p === def ? `${p} (default)` : p)).join(", ")}`);
  if (wallpapers.length) {
    log(`  macOS wallpapers (this machine, ${wallpapers.length}):`);
    log(wallpapers.map((w) => `    ${w}`).join("\n"));
  } else {
    log("  macOS wallpapers: none found (not a Mac, or none installed)");
  }
}
