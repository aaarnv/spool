// Canonical REPO background presets — generated gradients shipped in assets/ (no
// third-party imagery, so the OSS repo stays copyright-clean). Single source of
// truth for the render pipeline (bg-resolve.mjs) and the edit worker (worker/ops.mjs);
// the web mirrors BG_PRESET_NAMES in lib/editOps.ts (keep in sync).
// macOS system wallpapers (sonoma, ventura, …) are resolved at RUNTIME off this
// machine — see bg-resolve.mjs — never shipped in the repo.
export const BG_PRESETS = {
  graphite: "bg-graphite.jpg",
  paper: "bg-paper.jpg",
  indigo: "bg-indigo.jpg",
};

export const BG_PRESET_NAMES = Object.keys(BG_PRESETS);

// The repo-shipped default (used when no bg is given, or a requested bg can't be
// resolved — e.g. a macOS wallpaper name on the Linux worker). "indigo" = brand.
export const DEFAULT_BG = "indigo";
