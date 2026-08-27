// Assembles the same beats/words/chunks timeline render.mjs + auto.html's INIT build,
// so both engines are driven by identical data.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Whisper gives timings but strips punctuation and sentence case, so captions read
// as one run-on and the chunker's sentence split never fires. Walk the script's
// letters against whisper's and hand each timed word its written form back.
// Returns null on any drift, and the caller keeps whisper's own text.
function scriptWords(narration, words) {
  const toks = (narration || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length || !words.length) return null;
  let stream = ''; const ends = [];
  for (const tk of toks) { stream += key(tk); ends.push(stream.length); }
  const said = words.map((w) => key(w.word));
  const off = stream.indexOf(said.join(''));
  if (off === -1) return null;

  let pos = off, ti = 0;
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const from = pos, to = pos + said[i].length;
    pos = to;
    const parts = [];
    while (ti < toks.length && ends[ti] <= to) { if (ends[ti] > from) parts.push(toks[ti]); ti++; }
    if (!parts.length) return null;
    out.push({ ...words[i], word: parts.join(' ') });
  }
  return out;
}

export async function loadTimeline(voDir) {
  const manifest = JSON.parse(await readFile(join(voDir, 'vo/manifest.json'), 'utf8'));
  let t0 = 0;
  const beats = [];
  for (const seg of manifest.segments) {
    const heard = JSON.parse(await readFile(join(voDir, seg.words), 'utf8'));
    const words = (scriptWords(seg.narration, heard) || heard)
      .map((w) => ({ ...w, start: +(w.start + t0).toFixed(2), end: +(w.end + t0).toFixed(2) }));
    beats.push({ name: seg.name, start: +t0.toFixed(2), duration: seg.duration, words });
    t0 += seg.duration;
  }
  let diagrams = null;
  try { diagrams = JSON.parse(await readFile(join(voDir, 'diagrams.json'), 'utf8')); } catch { /* comp without a spec */ }
  // A design packet ships screenshots of the product instead of a diagram spec. The
  // paths are stored relative to the workdir so the bundle moves; resolve them here,
  // because the scene is handed data, not a directory.
  let mockups = null;
  try {
    mockups = JSON.parse(await readFile(join(voDir, 'mockups.json'), 'utf8'))
      .map((m) => ({ ...m, png: m.png ? resolve(voDir, m.png) : null }));
  } catch { /* comp without mockups */ }

  const capChunks = [];
  for (const b of beats) {
    let cur = [];
    for (const w of b.words) {
      cur.push(w);
      if (cur.length >= 5 || /[.!?…]$/.test(w.word)) { capChunks.push(cur); cur = []; }
    }
    if (cur.length) capChunks.push(cur);
  }
  return { manifest, beats, total: +t0.toFixed(2), diagrams, mockups, capChunks };
}
