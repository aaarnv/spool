#!/usr/bin/env node
// Slop lint: deterministic gate for narration scripts (docs/video/VOICE.md).
// Importable as lintBeats(); as a CLI it takes a beats JSON on stdin or a file arg
// and exits 0 clean / 1 with findings. Nothing renders until this passes.
//
// CALIBRATION, so nobody "fixes" this later by loosening it. The bakeoff scripts in
// spool/bake-previews/.mv-*/beats.json are the reference corpus, and 2 of the 8 fail
// ON PURPOSE: they predate the first-person rules entirely. SPL45 says "Say approve
// and I build the chip … I will go fix that first" — it is the script those rules
// were written against, not a regression. SPL43 says "So I add one", the same form
// as the explicitly banned "I hook it up"; ruled 2026-08-20 to stay flagged, because
// narrowing the verb class to protect one already-shipped script would weaken the
// gate exactly where a weaker model drifts. Published videos are never re-linted —
// this gate governs new generations, so a flagged reference costs nothing.
// The bar to clear when tuning: the other 6 stay clean, and a rule earns its place
// by catching a real generated defect, not by catching more.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const BANNED = [
  [/here'?s the (part|good part|best part|funny part|thing)/i, 'teaser label'],
  [/no(body| one) (talks|tells you) about/i, 'teaser label'],
  [/now (for )?the \w+ part/i, 'teaser label'],
  [/what happen(s|ed) next/i, 'teaser label'],
  [/stay tuned|buckle up|let'?s dive|dive in(to)?\b/i, 'filler opener'],
  [/\b(seamless(ly)?|robust|leverag\w+|utiliz\w+|delve|streamlin\w+|elevate|supercharge|game.?changer|cutting.?edge|furthermore|moreover)\b/i, 'slop vocabulary'],
  [/\bit'?s worth noting\b|\barguably\b/i, 'hedging'],
  [/\bin this (chapter|video|section)\b|\bthe approach consists\b|\bthis plan proposes\b/i, 'narrating the structure'],
  [/\w+, \w+, and \w+ (way|approach|solution)/i, 'rule-of-three flourish'],
  [/;/, 'semicolon — this is speech'],
  // POV mode speaks as the agent, but a promise is not a mechanism: describe the
  // change and ask for the call, never trade an approval for future work.
  [/\bI(?:'ll| will)\b/i, 'first-person promise ("I will …") — say what the change does instead'],
  [/\b(?:approve|ship it|say yes)\b[^.?!]*\bI\s+\w+/i, 'approval bargain ("approve and I …") — ask for the call, then stop'],
  // SCRIPTWRITER.md bans "I hook it up" as flatly as "I'll ship it": narrating
  // unapproved work in the present tense still puts the agent, not the change, in
  // the subject. The list is the class of implementation actions and stays explicit
  // so it can be audited — stance verbs (propose, think, need, see) are deliberately
  // absent, because making the case in first person is what POV mode IS.
  [
    /\b(?:I|we)(?:'m|'ve|'re)?\s+(?:add|build|ship|hook|wire|push|merge|land|deploy|run|split|write|create|store|move|copy|migrate|backfill|refactor|delete|remove|rename|swap|patch|implement|introduce|drop|replace|extend|fix|update|read|filter|cache|index|log|route|send|pull|call)(?:s|ing|ed)?\b/i,
    'first-person commitment verb — put the change in the subject, not the agent',
  ],
  // A packet field name read aloud as a heading. "Risks:" is a slide title, not
  // speech, and it is the same failure as narrating the structure.
  [
    /^\s*(?:the\s+)?(?:risk|alternative|context|approach|outcome|decision|ask|tradeoff|problem|solution|assumption|option|summary|background|goal|step|next step|current state)s?\s*:/i,
    'spoken section label — say the thing, do not announce the heading',
  ],
];

/** Every finding against a beats array — empty means the script may render. */
export function lintBeats(input) {
  const beats = Array.isArray(input) ? input : input?.beats || input?.steps;
  if (!Array.isArray(beats)) return ['[shape] expected an array of {name, narration} beats'];
  if (!beats.length) return ['[shape] no beats'];

  const findings = [];
  for (const b of beats) {
    const text = b.narration || '';
    for (const [re, why] of BANNED) {
      const m = text.match(re);
      if (m) findings.push(`[${b.name}] ${why}: "${m[0]}"`);
    }
    for (const sentence of text.split(/(?<=[.!?])\s+/)) {
      const words = sentence.trim().split(/\s+/).filter(Boolean);
      if (words.length > 24) findings.push(`[${b.name}] sentence too long to say aloud (${words.length} words): "${sentence.slice(0, 60)}…"`);
    }
  }

  const total = beats.reduce((n, b) => n + (b.narration || '').split(/\s+/).filter(Boolean).length, 0);
  if (total > 200) findings.push(`[length] ${total} words (~${Math.round(total / 2.4)}s) — over the 200-word ceiling`);

  // hook check: first beat must not open on an ID or title
  const first = (beats[0]?.narration || '').trim();
  if (/^(SPL-|this (plan|task|video)|today)/i.test(first)) findings.push('[hook] opens on structure, not stakes');

  return findings;
}

const isMain = resolve(process.argv[1] || '') === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const src = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
  const parsed = JSON.parse(src);
  const findings = lintBeats(parsed);
  if (findings.length) {
    console.error(`SLOP LINT: ${findings.length} finding(s)`);
    for (const f of findings) console.error('  ' + f);
    process.exit(1);
  }
  const beats = Array.isArray(parsed) ? parsed : parsed.beats || parsed.steps;
  console.log(`slop lint: clean (${beats.length} beats)`);
}
