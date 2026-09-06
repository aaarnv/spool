import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { scanMacWallpapers } from '../src/render/bg-resolve.mjs';

test('discovers full-size stills, landscape videos and solids with usable aliases', async t => {
  const root = await mkdtemp(join(tmpdir(), 'spool-wallpapers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const file of [
    'Sonoma.heic', 'iMac Purple.heic', 'Solid Colors/Space Gray.png',
    '.wallpapers/Tahoe Day/Tahoe Day.mov',
    '.wallpapers/Sonoma/Sonoma Graphic Dark Landscape.mov',
    '.wallpapers/Sonoma/Sonoma Graphic Light Landscape.mov',
    '.wallpapers/Sonoma/Sonoma Graphic Dark Portrait.mov',
    '.wallpapers/Sonoma/Sonoma Thumbnail.png',
    '.thumbnails/Ventura.png', 'Ventura Graphic.madesktop',
  ]) {
    const path = join(root, file);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, 'fixture');
  }
  await mkdir(join(root, 'Not An Image.jpg'));
  const found = await scanMacWallpapers(root);
  assert.equal(found.get('tahoe'), join(root, '.wallpapers/Tahoe Day/Tahoe Day.mov'));
  assert.equal(found.get('sonoma-dark'), found.get('sonoma-graphic-dark-landscape'));
  assert.equal(found.get('sonoma-light'), found.get('sonoma-graphic-light-landscape'));
  assert.equal(found.get('solid-space-gray'), join(root, 'Solid Colors/Space Gray.png'));
  assert.ok(found.has('imac-purple'));
  assert.ok(found.has('sonoma'));
  assert.equal(found.size, 9);
  assert.ok([...found.keys()].every(k => !/portrait|thumbnail|ventura|not-an-image/.test(k)));
});

test('missing macOS directories have no wallpaper options or dangling aliases', async () => {
  assert.equal((await scanMacWallpapers('/nonexistent-spool-wallpapers')).size, 0);
});

test('backgrounds JSON exposes usable names and bundled presets', async () => {
  const cli = fileURLToPath(new URL('../bin/spool.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'backgrounds', '--json']);
  const list = JSON.parse(stdout);
  assert.deepEqual(list.filter(b => b.kind === 'preset').map(b => b.name), ['graphite', 'paper', 'indigo', 'sky']);
  assert.ok(list.every(b => typeof b.name === 'string' && typeof b.source === 'string'));
  assert.equal(new Set(list.map(b => b.name)).size, list.length);
});
