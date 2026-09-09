// Word timings for speech whose text we already know. No model: the wav's energy finds
// the pauses, punctuation snaps to them, and words share each phrase by syllable weight.

const FRAME_S = 0.01;
const GAP_MIN_S = 0.15; // a quieter stretch shorter than this is inside a phrase, not a pause
const RUN_MIN_S = 0.05;
const LEAD_S = 0.02; // consonant onsets sit just under the energy threshold
const FINAL_BONUS = 0.7;

const round2 = (x) => Math.round(x * 100) / 100;

/** PCM samples (mono, float) and the sample rate from a RIFF/WAVE buffer. */
export function decodeWav(buf) {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a wav");
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") fmt = { format: buf.readUInt16LE(body), channels: buf.readUInt16LE(body + 2), rate: buf.readUInt32LE(body + 4), bits: buf.readUInt16LE(body + 14) };
    if (id === "data") data = buf.subarray(body, Math.min(buf.length, body + size));
    off = body + size + (size % 2);
  }
  if (!fmt || !data) throw new Error("wav without fmt/data");
  const { channels, rate, bits, format } = fmt;
  const bytes = bits / 8;
  const frames = Math.floor(data.length / (bytes * channels));
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const p = (i * channels + c) * bytes;
      if (format === 3 && bits === 32) sum += data.readFloatLE(p);
      else if (bits === 16) sum += data.readInt16LE(p) / 32768;
      else if (bits === 24) sum += ((data[p] | (data[p + 1] << 8) | (data[p + 2] << 16)) << 8 >> 8) / 8388608;
      else if (bits === 32) sum += data.readInt32LE(p) / 2147483648;
      else if (bits === 8) sum += (data[p] - 128) / 128;
    }
    mono[i] = sum / channels;
  }
  return { samples: mono, rate };
}

/** Voiced stretches [{start,end}] on the clock, from frame energy against the recording's own floor. */
export function voicedRuns(samples, rate) {
  const n = Math.max(1, Math.round(rate * FRAME_S));
  const frames = Math.floor(samples.length / n);
  const db = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let acc = 0;
    for (let i = f * n; i < (f + 1) * n; i++) acc += samples[i] * samples[i];
    db[f] = 10 * Math.log10(acc / n + 1e-12);
  }
  const sorted = Float32Array.from(db).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)] ?? -120;
  const peak = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const thr = Math.max(peak - 28, floor + 12);
  const on = Array.from(db, (v) => v >= thr);
  // Fill short dips (stops, unvoiced consonants) so a word never splits in two.
  const gapFrames = Math.round(GAP_MIN_S / FRAME_S);
  let last = -1;
  for (let f = 0; f < frames; f++) {
    if (!on[f]) continue;
    if (last >= 0 && f - last - 1 < gapFrames) for (let g = last + 1; g < f; g++) on[g] = true;
    last = f;
  }
  const runs = [];
  for (let f = 0; f < frames; f++) {
    if (!on[f]) continue;
    let e = f;
    while (e + 1 < frames && on[e + 1]) e++;
    if ((e - f + 1) * FRAME_S >= RUN_MIN_S) runs.push({ start: round2(Math.max(0, f * FRAME_S - LEAD_S)), end: round2((e + 1) * FRAME_S) });
    f = e;
  }
  return runs;
}

const PHRASE_END = /[.,;:!?…]["')\]]*$/;

/** How long a word takes to say, relative to its neighbours: syllables plus an onset cost. */
export function wordWeight(word) {
  const letters = word.toLowerCase().replace(/[^a-z0-9']/g, "");
  if (!letters) return 0.4;
  const digits = (letters.match(/[0-9]/g) || []).length;
  const groups = (letters.replace(/[0-9]/g, "").match(/[aeiouy]+/g) || []).length;
  const silentE = /[^aeiouy]e$/.test(letters) && groups > 1 ? 1 : 0;
  return Math.max(1, groups - silentE) + digits * 1.6 + 0.35;
}

/**
 * Words [{word,start,end}] for `text` spoken in the wav. Pauses in the audio are matched to
 * the punctuation in the text, and words split each phrase in proportion to their weight.
 */
export function alignWords(wavBuf, text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const { samples, rate } = decodeWav(wavBuf);
  const total = samples.length / rate;
  let runs = voicedRuns(samples, rate);
  if (!runs.length) runs = [{ start: 0, end: round2(total) }];

  // Speech time: the clock with the pauses removed. `cum[i]` is where run i starts in it.
  const cum = [0];
  for (const r of runs) cum.push(cum[cum.length - 1] + (r.end - r.start));
  const T = cum[cum.length - 1];
  const clockAt = (s, edge) => {
    for (let i = 0; i < runs.length; i++) {
      const a = cum[i];
      const b = cum[i + 1];
      if (s < b || (edge === "end" && s <= b) || i === runs.length - 1) return runs[i].start + Math.min(Math.max(0, s - a), b - a);
    }
    return runs[runs.length - 1].end;
  };

  // Phrases: runs of words up to a punctuation mark, each weighted by its words.
  // A word before a pause is drawn out; give it the extra share whisper always measures.
  const weights = words.map((w, k) => wordWeight(w) + (PHRASE_END.test(w) || k === words.length - 1 ? FINAL_BONUS : 0));
  const phrases = [];
  let from = 0;
  for (let k = 0; k < words.length; k++) {
    if (PHRASE_END.test(words[k]) || k === words.length - 1) {
      phrases.push({ from, to: k + 1, s0: 0, s1: 0, w: weights.slice(from, k + 1).reduce((a, b) => a + b, 0) });
      from = k + 1;
    }
  }

  // Place phrases in order. Each takes its share of the speech time still left, so a
  // slow opening never drags every later boundary; then its end snaps to the nearest
  // unclaimed pause inside a window of its own length.
  const pauses = cum.slice(1, -1);
  let nextPause = 0;
  let s0 = 0;
  let left = phrases.reduce((a, p) => a + p.w, 0);
  for (let j = 0; j < phrases.length; j++) {
    const p = phrases[j];
    p.s0 = s0;
    p.s1 = j === phrases.length - 1 ? T : s0 + (p.w / left) * (T - s0);
    if (j < phrases.length - 1) {
      const window = 0.12 + 0.3 * (p.s1 - p.s0);
      let best = -1;
      for (let i = nextPause; i < pauses.length; i++) {
        const d = Math.abs(pauses[i] - p.s1);
        if (d <= window && (best < 0 || d < Math.abs(pauses[best] - p.s1))) best = i;
        if (pauses[i] > p.s1 + window) break;
      }
      if (best >= 0) {
        p.s1 = pauses[best];
        nextPause = best + 1;
      }
    }
    s0 = p.s1;
    left -= p.w;
  }

  const out = [];
  for (const p of phrases) {
    const span = Math.max(0, p.s1 - p.s0);
    const w = weights.slice(p.from, p.to).reduce((a, b) => a + b, 0);
    let s = p.s0;
    for (let k = p.from; k < p.to; k++) {
      const e = s + (weights[k] / w) * span;
      out.push({ word: words[k], start: round2(clockAt(s, "start")), end: round2(clockAt(e, "end")) });
      s = e;
    }
  }
  // Keep the sequence monotonic and every word audible for at least one frame.
  for (let k = 0; k < out.length; k++) {
    if (k > 0 && out[k].start < out[k - 1].end) out[k].start = out[k - 1].end;
    if (out[k].end < out[k].start + 0.05) out[k].end = round2(out[k].start + 0.05);
  }
  return out;
}
