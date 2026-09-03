// Assembles the same beats/words/chunks timeline render.mjs + auto.html's INIT build,
// so both engines are driven by identical data.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const key = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

// Whisper gives timings but strips punctuation and sentence case, so captions read
// as one run-on and the chunker's sentence split never fires. Walk the script's
// letters against whisper's and hand each timed word its written form back.
// Returns null on any drift, and the caller keeps whisper's own text.
//
// The two streams are cut at the boundaries they SHARE, which is what makes an
// identifier survive: TTS speaks SPOOL_RENDER_TIMEOUT_MS as four words and whisper
// writes four words, and matching per whisper word could only ever fail there — it
// did, so the caption said "SPOOL RENDER TIMEOUT MS" and the underscores were gone.
// Those four timings collapse into one caption word carrying the written token,
// spanning the first word's start to the last word's end.
function scriptWords(narration, words) {
  const toks = (narration || '').trim().split(/\s+/).filter(Boolean);
  if (!toks.length || !words.length) return null;
  let stream = ''; const ends = [];
  for (const tk of toks) { stream += key(tk); ends.push(stream.length); }
  const said = words.map((w) => key(w.word));
  const off = stream.indexOf(said.join(''));
  if (off === -1) return null;

  const wEnds = []; let p = off;
  for (const s of said) { p += s.length; wEnds.push(p); }

  let ti = 0;
  while (ti < toks.length && ends[ti] <= off) ti++;
  const out = [];
  let wi = 0;
  while (wi < words.length) {
    const tFrom = ti, wFrom = wi;
    for (;;) {
      if (wi >= words.length) return null;
      const te = ti < toks.length ? ends[ti] : Infinity;
      const we = wEnds[wi];
      if (te === we) { ti++; wi++; break; }
      if (te < we) ti++; else wi++;
    }
    if (ti === tFrom) return null;
    // Backticks are a script convention for "this is code"; the caption layer has one
    // font and draws whatever it is given, so they would render as literal glyphs.
    const word = toks.slice(tFrom, ti).join(' ').replace(/`/g, '');
    out.push({ ...words[wFrom], word, start: words[wFrom].start, end: words[wi - 1].end });
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

  // What the opening and closing cards name. src/recap/video.mjs writes recap.json into
  // the workdir before it renders; a plan packet has none and gets no cards.
  // The watch link does not exist until publish, so the card carries the pull request.
  let card = null;
  try {
    const r = JSON.parse(await readFile(join(voDir, 'recap.json'), 'utf8'));
    if (r?.repo && r?.number != null) {
      card = {
        repo: r.repo,
        number: r.number,
        title: r.title || null,
        link: `github.com/${r.repo}/pull/${r.number}`,
      };
    }
  } catch { /* not a recap */ }

  const capChunks = [];
  for (const b of beats) {
    let cur = [];
    for (const w of b.words) {
      cur.push(w);
      if (cur.length >= 5 || /[.!?…]$/.test(w.word)) { capChunks.push(cur); cur = []; }
    }
    if (cur.length) capChunks.push(cur);
  }
  return { manifest, beats, total: +t0.toFixed(2), diagrams, mockups, card, capChunks };
}
