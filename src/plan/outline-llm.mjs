// OPTIONAL LLM assistance for the plan narration. Off by default.
//
// The deterministic generator in ./generate.mjs owns what is said: which
// chapters exist, which visual each one shows, which packet claims it may use.
// This module only rewrites the *wording* of an already-generated chapter, and
// every rewrite must survive three checks before it is kept:
//
//   1. the chapter set is unchanged (no chapter added, dropped or reordered);
//   2. the rewrite introduces no new hard fact — every identifier, path, number
//      or quoted term in it already appears in the packet;
//   3. the refined script still passes lintPlanScript.
//
// A chapter that fails any check keeps its deterministic text and reports a
// warning. So the worst case of `--llm` is the deterministic script plus an
// explanation, never a claim the author did not make.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { openaiFetch } from '../vo/timestamps.mjs';
import { countWords, estimateSeconds, lintPlanScript } from './generate.mjs';

export const DEFAULT_MODEL = process.env.SPOOL_PLAN_MODEL || 'gpt-5';

// How far the rewrite may drift from the deterministic length, either way.
const LENGTH_TOLERANCE = 0.35;

const EM_DASH = '\u2014'; // kept as an escape (no literal em dashes in source)

// A "hard fact" is anything a listener could check: a path, an identifier, a
// number, or a quoted term. Plain prose is the model's to rewrite.
const HARD_TOKEN_RE = /`[^`]+`|\b[\w-]+(?:[./][\w-]+)+\b|\b[a-z]+[A-Z][A-Za-z]*\b|\b\w*_\w+\b|\b\d[\d.,%]*\b/g;

function hardTokens(text) {
  return (String(text).match(HARD_TOKEN_RE) || []).map((t) => t.replace(/`/g, '').toLowerCase());
}

// Everything the author actually supplied, as one lowercase haystack.
function packetCorpus(packet) {
  return JSON.stringify([packet.plan, packet.evidence ?? null]).toLowerCase();
}

async function resolveKey() {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.spool.json'), 'utf8'));
    if (cfg.openaiKey) return cfg.openaiKey;
  } catch { /* no key anywhere */ }
  return null;
}

function buildPrompt(script, packet) {
  const facts = {
    goal: packet.plan.goal,
    outcome: packet.plan.outcome,
    currentState: (packet.plan.currentState || []).map((c) => c.claim),
    approach: (packet.plan.approach || []).map((s) => s.summary),
    alternatives: (packet.plan.alternatives || []).map((a) => a.summary),
    noAlternativesReason: packet.plan.noAlternativesReason ?? null,
    assumptions: packet.plan.assumptions || [],
    risks: packet.plan.risks || [],
    decision: packet.plan.decision,
    evidence: (packet.evidence?.items || []).map((e) => ({ id: e.id, label: e.label, ref: e.ref })),
  };
  const chapters = script.chapters.map((c) => ({ id: c.id, title: c.title, narration: c.narration }));
  return [
    {
      role: 'system',
      content:
        'You rewrite voiceover narration for a short plan video. You may only improve flow and phrasing. ' +
        'You must not add, remove or reorder chapters. You must not add any fact, file name, number, metric or claim ' +
        'that is absent from the supplied plan packet. Keep each chapter within a quarter of its current length. ' +
        'Write short spoken sentences, active voice, present tense, no em dashes, no marketing language. ' +
        'Reply with JSON only: {"chapters":[{"id":"...","narration":"..."}]}.',
    },
    {
      role: 'user',
      content: `Plan packet (the only facts you may use):\n${JSON.stringify(facts, null, 2)}\n\nChapters to rewrite:\n${JSON.stringify(chapters, null, 2)}`,
    },
  ];
}

async function openaiComplete(messages, model) {
  const key = await resolveKey();
  if (!key) throw new Error('OPENAI_API_KEY not set (env or "openaiKey" in ~/.spool.json)');
  const res = await openaiFetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature: 0.2, response_format: { type: 'json_object' }, messages }),
  });
  const body = await res.json();
  return body.choices?.[0]?.message?.content ?? '';
}

/**
 * Rewrite the narration of a generated script with an LLM, keeping the
 * deterministic text wherever the rewrite cannot be trusted.
 *
 * @param {object} script  — from generatePlanScript()
 * @param {{plan: object, evidence?: object|null}} packet
 * @param {{model?: string, complete?: (messages, model) => Promise<string>}} opts
 *        `complete` is the injection point for tests; production uses OpenAI.
 * @returns {Promise<{script: object, warnings: Array<{path, code, message}>}>}
 */
export async function refinePlanScript(script, packet, { model = DEFAULT_MODEL, complete = openaiComplete } = {}) {
  const warnings = [];
  const warn = (path, code, message) => warnings.push({ path, code, message });

  let parsed;
  try {
    parsed = JSON.parse(await complete(buildPrompt(script, packet), model));
  } catch (e) {
    warn('llm', 'llm-unusable', `the model reply could not be read (${e.message}); keeping the deterministic narration`);
    return { script, warnings };
  }

  const byId = new Map();
  for (const c of Array.isArray(parsed?.chapters) ? parsed.chapters : []) {
    if (c && typeof c.id === 'string') byId.set(c.id, c.narration);
  }
  const returned = [...byId.keys()];
  const expected = script.chapters.map((c) => c.id);
  if (returned.length !== expected.length || returned.some((id) => !expected.includes(id))) {
    warn('llm', 'chapter-set-changed', `the model returned chapters [${returned.join(', ')}] instead of [${expected.join(', ')}]; keeping the deterministic narration`);
    return { script, warnings };
  }

  const corpus = packetCorpus(packet);
  const chapters = script.chapters.map((c) => {
    const candidate = byId.get(c.id);
    const at = `chapters.${c.id}.narration`;
    if (typeof candidate !== 'string' || !candidate.trim()) {
      warn(at, 'llm-empty', `chapter "${c.id}" came back empty; keeping the deterministic narration`);
      return c;
    }
    if (candidate.includes(EM_DASH)) {
      warn(at, 'llm-em-dash', `chapter "${c.id}" came back with an em dash; keeping the deterministic narration`);
      return c;
    }
    const words = countWords(candidate);
    const drift = Math.abs(words - c.words) / Math.max(c.words, 1);
    if (drift > LENGTH_TOLERANCE) {
      warn(at, 'llm-length-drift', `chapter "${c.id}" came back ${words} words against ${c.words}; keeping the deterministic narration`);
      return c;
    }
    const invented = [...new Set(hardTokens(candidate))].filter((t) => !corpus.includes(t));
    if (invented.length) {
      warn(at, 'llm-invented-fact', `chapter "${c.id}" introduced ${invented.map((t) => `"${t}"`).join(', ')}, which the packet does not contain; keeping the deterministic narration`);
      return c;
    }
    const narration = candidate.trim();
    return {
      ...c,
      narration,
      words,
      estimatedSeconds: estimateSeconds(narration),
      step: { ...c.step, narration },
    };
  });

  const refined = {
    ...script,
    generator: chapters.some((c, i) => c !== script.chapters[i]) ? 'llm-refined' : script.generator,
    estimatedSeconds: Math.round(chapters.reduce((sum, c) => sum + c.estimatedSeconds, 0) * 10) / 10,
    chapters,
  };

  // Last gate: a refined script that fails the quality lint is not shipped at all.
  const lint = lintPlanScript(refined, packet);
  if (!lint.ok) {
    warn('llm', 'llm-lint-failed', `the refined script failed the quality lint (${lint.errors[0].message}); keeping the deterministic narration`);
    return { script, warnings };
  }
  return { script: refined, warnings };
}
