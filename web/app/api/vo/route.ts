import { sql } from "drizzle-orm";
import { db } from "../../../db";
import { voUsage } from "../../../db/schema";
import { resolveOwner } from "../../../db/owner";
import { sendOpsAlert } from "../../../lib/alerts";

export const runtime = "nodejs";

// Hosted voiceover: the CLI POSTs narration with a publish token, we call OpenAI
// (gpt-4o-mini-tts speech + whisper-1 word timings, mirroring src/vo/*) and return
// the raw wav + word timings so the client applies its own loudnorm/atempo pass.
const TEXT_CAP = 1200;
const INSTR_CAP = 2000;
const DEFAULT_VOICE = "alloy";
const DAILY_CAP = Number(process.env.VO_DAILY_CAP) || 300;

const round2 = (x: number) => Math.round(x * 100) / 100;

const bad = (status: number, error: string) =>
  Response.json({ error }, { status });

type Body = { text?: string; voice?: string; instructions?: string };

export async function POST(req: Request) {
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer) return bad(401, "unauthorized");
  const ownerId = await resolveOwner(bearer);
  if (!ownerId) return bad(401, "unauthorized");
  if (!process.env.OPENAI_API_KEY) return bad(500, "OPENAI_API_KEY not configured");

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return bad(400, "expected json body");
  }
  const text = (body.text || "").trim();
  if (!text) return bad(400, "missing text");
  if (text.length > TEXT_CAP) return bad(413, `text too long (max ${TEXT_CAP} chars)`);
  const voice = body.voice || DEFAULT_VOICE;
  const instructions = body.instructions?.slice(0, INSTR_CAP);

  // Reserve a daily slot atomically before doing any work; rejecting past the cap
  // keeps counting, which is harmless for an abuse guard.
  const day = new Date().toISOString().slice(0, 10);
  const [row] = await db
    .insert(voUsage)
    .values({ ownerId, day, count: 1 })
    .onConflictDoUpdate({
      target: [voUsage.ownerId, voUsage.day],
      set: { count: sql`${voUsage.count} + 1` },
    })
    .returning({ count: voUsage.count });
  const count = row.count;
  if (count > DAILY_CAP) {
    return bad(429, `daily voiceover cap reached (${DAILY_CAP}/day) — try again tomorrow`);
  }
  const remainingToday = Math.max(0, DAILY_CAP - count);

  let audio: string;
  let words: { word: string; start: number; end: number }[];
  try {
    const wav = await openaiSpeech(text, voice, instructions);
    audio = Buffer.from(wav).toString("base64");
    words = await openaiWordTimestamps(wav, text);
  } catch (e) {
    await sendOpsAlert("/api/vo upstream tts failed", (e as Error).message, { key: "vo-error" });
    return bad(502, `upstream tts failed: ${(e as Error).message}`);
  }

  return Response.json({ audio, words, usage: { remainingToday } });
}

// gpt-4o-mini-tts → wav bytes (same request shape as src/vo/tts.mjs openaiSpeech).
async function openaiSpeech(text: string, voice: string, instructions?: string) {
  const reqBody: Record<string, unknown> = {
    model: "gpt-4o-mini-tts",
    voice,
    input: text,
    response_format: "wav",
  };
  if (instructions) reqBody.instructions = instructions;
  const res = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) throw new Error(`speech ${res.status}: ${await res.text().catch(() => "")}`);
  return Buffer.from(await res.arrayBuffer());
}

// whisper-1 verbose_json word timings (same request shape as src/vo/timestamps.mjs).
async function openaiWordTimestamps(wav: Buffer, prompt: string) {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "seg.wav");
  form.append("model", "whisper-1");
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  if (prompt) form.append("prompt", prompt);
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!res.ok) throw new Error(`transcription ${res.status}: ${await res.text().catch(() => "")}`);
  const json = (await res.json()) as { words?: { word: string; start: number; end: number }[] };
  return (json.words || []).map((w) => ({
    word: w.word,
    start: round2(w.start),
    end: round2(w.end),
  }));
}
