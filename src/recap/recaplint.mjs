#!/usr/bin/env node
// Recap slop lint: the shared narration gate plus the four defects only the recap
// lane produces. It WRAPS sloplint rather than extending it, because a plan packet
// is a proposal — "we should" and "will add" are the correct register there and a
// merged PR is the only input where they are wrong.
//
// CALIBRATION. Every rule below was measured against real gpt-5 drafts of two
// merged PRs in this repo (the recut-ops merge and the minimal-watch merge), and
// each one catches a defect BOTH drafts actually shipped: a closer that inventories
// the work, a middle beat that recites CSS class names, "the worker now applied",
// and a 7-beat script. The thresholds are deliberately blunt — three artifact names
// in one beat, not two — so a line that legitimately points a teammate at one file
// still passes. Verified against spool/bake-previews/.mv-*/beats.json: these rules
// add no findings to the reference corpus.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { lintBeats } from '../packet/sloplint.mjs';

/** 4 to 6, per RECAPPER.md's SHAPE. A 7th beat is always the inventory beat. */
const MIN_BEATS = 4;
const MAX_BEATS = 6;
/** Artifact names one beat may carry before it reads as a changelog. */
const MAX_ARTIFACTS = 3;
/** The closer gets a tighter budget: it is the beat that must not list anything. */
const MAX_CLOSER_ARTIFACTS = 2;

// A path, a filename or a CSS class read aloud. Bare words are excluded on purpose:
// "the worker" and "timeline" are the subject of the sentence, not an inventory.
const ARTIFACT = [
  /\b[\w.-]+\/[\w./-]+\b/g,
  /\b[\w-]+\.(?:mjs|cjs|js|ts|tsx|jsx|json|md|css|scss|sql|py|rb|go|rs|ya?ml|html|sh|toml)\b/gi,
  /(?:^|\s)\.[a-z][a-z0-9-]{2,}\b/gi,
  /\bdot [a-z][a-z0-9-]*(?:-[a-z0-9]+)+\b/gi,
];

const PROPOSAL = [
  [/\bwe(?:'ll| will| should| could| can| need to| ought to)\b/i, 'proposal language — this already merged'],
  [/\b(?:will|would) (?:be )?(?:add|ship|land|build|introduce|include|follow|come|move|need|require|switch|replace|extend)(?:ed|s)?\b/i, 'future tense about the change — it already landed'],
  [/\b(?:the )?next step(?:s)? (?:is|are|will)\b|\bstill to (?:do|come)\b|\bis going to\b/i, 'proposal language — this already merged'],
  [/\blet'?s\b/i, 'proposal language — this already merged'],
];

// "the worker now applied": a present-state adverb against a past-tense verb. The
// auxiliary guard keeps "is now named" and "has now shipped", which are both fine.
const AUX = /(?:\b(?:is|are|was|were|be|been|being|get|gets|got|has|have|had|having)\s+)$/i;
const DRIFT = /\b(now|currently|today)\s+((?:[a-z]+ly\s+)?[a-z]+ed)\b/gi;
// Past participles that are ordinary adjectives after "now", not a tense slip.
const ADJECTIVE = /^(?:used|based|named|called|aged|advanced|mixed|limited|detailed|required|expected|allowed|supported|shared|closed|open(?:ed)?)$/i;

const countArtifacts = (text) =>
  ARTIFACT.reduce((n, re) => n + (text.match(re) || []).length, 0);

/** A last beat that lists what got touched instead of what to carry forward. */
function inventoryCloser(text) {
  const parts = text.split(/,| and /).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 3) return false;
  return parts.filter((p) => /\b[a-z]+ed\b\s*$/i.test(p)).length >= 2;
}

function tenseDrift(text) {
  for (const m of text.matchAll(DRIFT)) {
    const before = text.slice(0, m.index);
    if (AUX.test(before)) continue;
    if (ADJECTIVE.test(m[2].trim())) continue;
    return m[0];
  }
  return null;
}

/** Every finding against a recap beats array — the shared gate plus the recap rules. */
export function lintRecapBeats(input) {
  const findings = lintBeats(input);
  const beats = Array.isArray(input) ? input : input?.beats || input?.steps;
  if (!Array.isArray(beats) || !beats.length) return findings;

  if (beats.length < MIN_BEATS || beats.length > MAX_BEATS) {
    findings.push(`[shape] ${beats.length} beats — a recap is ${MIN_BEATS} to ${MAX_BEATS}`);
  }

  beats.forEach((b, i) => {
    const text = b.narration || '';
    const last = i === beats.length - 1;
    const budget = last ? MAX_CLOSER_ARTIFACTS : MAX_ARTIFACTS;
    const artifacts = countArtifacts(text);
    if (artifacts >= budget) {
      findings.push(`[${b.name}] ${artifacts} file or class names read aloud — say what changed for a teammate, not which files moved`);
    }
    if (last && inventoryCloser(text)) {
      findings.push(`[${b.name}] the closer inventories the work — end on the risk, the behaviour change or the open follow-up`);
    }
    for (const [re, why] of PROPOSAL) {
      const m = text.match(re);
      if (m) findings.push(`[${b.name}] ${why}: "${m[0]}"`);
    }
    const drift = tenseDrift(text);
    if (drift) findings.push(`[${b.name}] tense drift ("${drift}") — past tense for the change, present tense for what is now true`);
  });

  return findings;
}

const isMain = resolve(process.argv[1] || '') === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const src = process.argv[2] ? readFileSync(process.argv[2], 'utf8') : readFileSync(0, 'utf8');
  const parsed = JSON.parse(src);
  const findings = lintRecapBeats(parsed);
  if (findings.length) {
    console.error(`RECAP LINT: ${findings.length} finding(s)`);
    for (const f of findings) console.error('  ' + f);
    process.exit(1);
  }
  const beats = Array.isArray(parsed) ? parsed : parsed.beats || parsed.steps;
  console.log(`recap lint: clean (${beats.length} beats)`);
}
