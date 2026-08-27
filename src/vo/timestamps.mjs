// src/vo/timestamps.mjs — per-segment word timings for the VO layer.
// OpenAI whisper-1 (verbose_json, word granularity) is the default; the local
// engine reuses vo.sh's chunk output, split evenly into per-word times.
// Produces the [{word,start,end}] shape CONTRACTS.md requires (times local to the wav).
const round2 = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Transcribe a segment's (loudnormed) wav into word timings local to that wav.
export async function openaiWordTimestamps({ key, wavBuf, prompt }) {
  const form = new FormData();
  form.append('file', new Blob([wavBuf], { type: 'audio/wav' }), 'seg.wav');
  form.append('model', 'whisper-1');
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  if (prompt) form.append('prompt', prompt); // bias spelling toward the known narration
  const res = await openaiFetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  const json = await res.json();
  return (json.words || []).map((w) => ({ word: w.word, start: round2(w.start), end: round2(w.end) }));
}

// vo.sh emits multi-word [[start,end,text],…] chunks; split each evenly per word.
export function chunksToWords(chunks) {
  const out = [];
  for (const [start, end, text] of chunks) {
    const ws = String(text).split(/\s+/).filter(Boolean);
    if (!ws.length) continue;
    const step = (end - start) / ws.length;
    ws.forEach((w, k) => out.push({ word: w, start: round2(start + k * step), end: round2(start + (k + 1) * step) }));
  }
  return out;
}

// Shared OpenAI POST: retry once on 429/5xx with backoff; any other non-2xx
// throws with the response body. Also used by tts.mjs for the speech call.
export async function openaiFetch(url, opts, attempt = 0) {
  const res = await fetch(url, opts);
  if (res.ok) return res;
  const body = await res.text().catch(() => '');
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await sleep(1500 * (attempt + 1));
    return openaiFetch(url, opts, attempt + 1);
  }
  throw new Error(`OpenAI ${new URL(url).pathname} -> ${res.status}: ${body}`);
}
