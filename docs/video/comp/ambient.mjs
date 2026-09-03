// The ambient background pool. Clips live in ambient/ (gitignored) and are
// described by ambient/manifest.json; ambient.mp4 stays the fallback when the
// pool is empty, so a fresh checkout still renders.
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'ambient');
const manifestPath = join(dir, 'manifest.json');

export const FALLBACK = { slug: 'ambient', src: join(here, 'ambient.mp4'), clipDur: 28.4, dim: 1 };

export function loadPool() {
  if (!existsSync(manifestPath)) return [];
  const { clips = [] } = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return clips
    .map((c) => ({ dim: 1, ...c, src: join(dir, c.file) }))
    .filter((c) => existsSync(c.src));
}

// FNV-1a: a stable string picks a stable clip, so re-rendering a packet keeps
// the background it already had.
const hash = (s) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
};

export function pickAmbient(choice, seed = '') {
  const pool = loadPool();
  if (!pool.length) return FALLBACK;
  if (choice && choice !== 'random') {
    const hit = pool.find((c) => c.slug === choice);
    if (!hit) throw new Error(`unknown background '${choice}'; pool: ${pool.map((c) => c.slug).join(', ')}`);
    return hit;
  }
  return pool[hash(seed) % pool.length];
}
