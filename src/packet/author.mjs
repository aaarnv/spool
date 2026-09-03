// Packet → script → visuals, with no coding agent in the loop.
//
// docs/video/tools/make-video.mjs runs these stages by shelling to `claude -p`,
// which a render worker cannot do. Here the same prompts go over the OpenAI API
// (the only model provider Spool carries a key for) behind the SAME deterministic
// gates: a draft that fails sloplint/diaglint is handed its own findings and asked
// again, and a run that never passes fails loudly rather than rendering slop.
//
// The visual layer has two shapes. A plan about a MECHANISM gets diagrams. A plan
// about a SCREEN gets mockups of that screen, because the owner decides a design by
// looking at it, and a diagram of a layout is a worse drawing of the thing itself.
import { readFile, mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { openaiFetch } from '../vo/timestamps.mjs';
import { lintBeats } from './sloplint.mjs';
import { lintDiagrams, repairDiagrams } from './diaglint.mjs';
import { lintMockupSpec, lintMockupShots, optionsOf } from './mocklint.mjs';
import { shootMockups } from './mockup.mjs';

const HERE = new URL('.', import.meta.url);
// Standard OpenAI env name, so a gateway or a test double can stand in for the API.
const BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
// Both stages stay on gpt-5 and pay for correctness; what they tune is the reasoning
// budget, measured on test/fixtures/skill/{risky-change,new-feature}.
//
// The MODEL is not the knob. gpt-4o was measured on risky-change dropping one of its
// two risks and then arguing the survivor down, and gpt-5-mini was measured drawing a
// red shield across a write the narration says SUCCEEDS — the picture stating the
// opposite of the line. A plan video that quietly loses a risk is wrong, not merely
// worse, so a cheaper model is not an option at either stage.
//
// The EFFORT is. `low` on both stages authored both fixtures on the FIRST attempt at
// $0.089 and $0.078 a video, against $0.183 and $0.148 for a `minimal` diagram tier
// that never once passed the gate and spent two failed calls before escalating. The
// floor is the diagram stage's ~6.5k output tokens, so ~$0.08 is what a correct video
// costs here; getting under $0.05 means a weaker model, and that trade is refused
// above. Escalation stays for the packet `low` cannot draw.
export const DEFAULT_MODEL = 'gpt-5';
export const DEFAULT_SCRIPT = { model: 'gpt-5', effort: 'low' };
export const DEFAULT_DIAGRAM = { model: 'gpt-5', effort: 'low' };
export const ESCALATE = { model: 'gpt-5', effort: null };
const ESCALATE_AFTER = 2;
const TEMPERATURE = 0.4;
const SCRIPT_ATTEMPTS = 3;
// Two. Measured on aaarnv/spool-web#6: four attempts spent 861s in this stage and the
// fourth still failed the same finding, because a lint the model cannot satisfy is not
// made satisfiable by asking again. One draft plus one go with the findings in hand.
const DIAGRAM_ATTEMPTS = 2;
// A mockup round trip renders and screenshots seven screens, so it is slower per try
// but its findings are exact; three tries has been enough for every packet measured.
const MOCKUP_ATTEMPTS = 5;

// make-video.mjs's mode inference, lifted verbatim so the platform and the local
// pipeline pick the same register for the same packet.
export function inferMode(packet) {
  const blob = JSON.stringify(packet);
  if (/"(status|state)":\s*"[^"]*(proved|proof)/i.test(blob)) return 'broadcast';
  if (blob.includes('"deviation')) return 'commentary';
  return 'pov';
}

// A plan is design-shaped when it says so twice. The goal or the outcome has to name
// a SURFACE, and the options themselves have to be built out of screen parts.
const SURFACE = /\b(screens?|pages?|views?|dashboards?|layouts?|ui|interface|design|redesign|mockups?|wireframes?)\b/i;
// These read as screen parts on a design plan and as ordinary nouns everywhere else,
// so they corroborate a surface goal and never carry the call on their own.
const PARTS = /\b(sidebars?|navs?|navigation|tabs?|chips?|pills?|cards?|grids?|rows?|rails?|sheets?|modals?|drawers?|toolbars?|headers?|footers?|columns?|lists?|panels?|buttons?|icons?|lanes?|typography|spacing)\b/gi;

/**
 * Which visual layer this packet earns: `mockup` or `diagram`.
 *
 * `plan.visual` overrides it, because an agent that knows the work is a design
 * change should be able to say so outright.
 */
export function inferVisual(packet) {
  const explicit = packet?.plan?.visual ?? packet?.visual;
  if (explicit === 'mockup' || explicit === 'diagram') return explicit;

  const plan = packet?.plan || {};
  const claim = (c) => (typeof c === 'string' ? c : c?.claim || c?.summary || '');
  const headline = [plan.goal, plan.outcome].filter(Boolean).join(' ');
  if (!SURFACE.test(headline)) return 'diagram';

  const options = [...(plan.approach || []), ...(plan.alternatives || [])]
    .flatMap((a) => [claim(a), ...(a?.tradeoffs || [])]).join(' ');
  const parts = new Set((options.match(PARTS) || []).map((w) => w.toLowerCase()));
  return parts.size >= 2 ? 'mockup' : 'diagram';
}

export async function resolveKey(explicit) {
  if (explicit) return explicit;
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  try {
    const cfg = JSON.parse(await readFile(join(homedir(), '.spool.json'), 'utf8'));
    if (cfg.openaiKey) return cfg.openaiKey;
  } catch { /* no key anywhere */ }
  return null;
}

const readPrompt = (name) => readFile(new URL(name, HERE), 'utf8');

// One completion, forced to JSON. The prompts ask for a bare array, which
// response_format:json_object refuses, so the array is carried in a one-key
// envelope and unwrapped here.
//
// The reasoning models serve this prompt best and they accept only the default
// temperature, so a rejected sampling knob is retried without it rather than
// pinning the whole stage to the models that happen to take one.
export async function complete({ key, model, effort, system, user, envelope }) {
  const send = (temperature) =>
    openaiFetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(temperature == null ? {} : { temperature }),
        ...(effort ? { reasoning_effort: effort } : {}),
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: `${system}\n\nReturn a JSON object shaped {"${envelope}": [ ... ]} — the array is exactly what the instructions above describe.` },
          { role: 'user', content: user },
        ],
      }),
    });

  const res = await send(TEMPERATURE).catch((e) => {
    if (!/does not support|unsupported_value/i.test(e.message)) throw e;
    return send(null);
  });
  const body = await res.json();
  const text = body?.choices?.[0]?.message?.content;
  if (!text) throw new Error('author: empty completion');
  const parsed = JSON.parse(text);
  const out = parsed[envelope] ?? parsed.items ?? parsed.result;
  if (!Array.isArray(out)) throw new Error(`author: no "${envelope}" array in the reply`);
  return out;
}

// A call that never came back is not a draft the lint rejected. openaiFetch already
// retries a dropped socket once; past that the throw reaches here, and counting it as
// an attempt spends a budget the model never got to use. Two long calls timing out in
// a row retired a recap with "not valid JSON: fetch failed", which is not a finding
// anybody can fix by drawing differently.
const TRANSPORT = /fetch failed|ECONN|ETIMEDOUT|EPIPE|socket hang up|network|terminated|-> (?:429|5\d\d)\b/i;
// Transport retries are free in tokens, so they get their own small budget rather than
// eating the lint budget.
const TRANSPORT_RETRIES = 2;

// Draft → lint → hand the findings back. A parse failure is just another finding,
// exactly as make-video.mjs treats it.
export async function gated({ attempts, label, draft, lint, repair, log, tierFor }) {
  let findings = [];
  const used = [];
  let transport = 0;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const extra = findings.length
      ? `\n\nYOUR PREVIOUS DRAFT FAILED THE LINT:\n${findings.join('\n')}\nFix every finding.`
      : '';
    const tier = tierFor ? tierFor(attempt) : null;
    used.push(tier ? tier.model : 'default');
    // Per-attempt seconds: this stage is the dominant cost of a recap and the only way
    // to see which attempt spent it is to say so.
    const t0 = Date.now();
    const secs = () => ((Date.now() - t0) / 1000).toFixed(1);
    let out;
    try {
      out = await draft(extra, tier);
    } catch (e) {
      if (TRANSPORT.test(e.message) && transport < TRANSPORT_RETRIES) {
        transport++;
        used.pop();
        attempt--; // the call never returned, so it was not an attempt at the picture
        log(`${label} attempt ${attempt + 2} (${secs()}s): ${e.message} — retrying, not counted`);
        continue;
      }
      findings = [`not valid JSON: ${e.message}`];
      log(`${label} attempt ${attempt + 1} (${secs()}s): ${findings[0]}`);
      continue;
    }
    if (repair) out = repair(out);
    // Mockups only fail in ways a browser can see, so a lint is allowed to render.
    findings = await lint(out);
    // A lint may split its findings: everything in `soft` is taste, the rest structure.
    // A lint that says nothing is treated as all-structural, which is what it was.
    const soft = Array.isArray(findings.soft) ? findings.soft : [];
    const hard = findings.filter((f) => !soft.includes(f));
    const last = attempt === attempts - 1;
    if (!findings.length) {
      log(`${label} attempt ${attempt + 1} (${tier ? tier.model : 'default'}, ${secs()}s): clean`);
      return { value: out, attempts: attempt + 1, used, warnings: [] };
    }
    // The last attempt is spent on structure alone. Taste findings that survived every
    // draft are recorded against the job and the render goes ahead.
    if (last && !hard.length) {
      log(`${label} attempt ${attempt + 1} (${tier ? tier.model : 'default'}, ${secs()}s): `
        + `${soft.length} taste finding(s) accepted, structure clean`);
      for (const f of soft) log('  warn: ' + f);
      return { value: out, attempts: attempt + 1, used, warnings: soft };
    }
    log(`${label} attempt ${attempt + 1} (${tier ? tier.model : 'default'}, ${secs()}s): `
      + `${findings.length} finding(s)${soft.length ? ` (${hard.length} structural)` : ''}`);
    for (const f of findings) log('  ' + f);
    if (last) findings = hard;
  }
  throw new Error(`${label} never passed its lint in ${attempts} attempts: ${findings.join(' | ')}`);
}

/**
 * The diagram stage, shared by both lanes and re-runnable after the frame gate.
 *
 * `context` is the change itself — the plan packet, or the recap lane's trimmed diff.
 * The prompt used to receive BEATS and nothing else, which made a box holding a real
 * identifier impossible in principle: the model had no identifiers. `priorFindings`
 * carries framelint's pixel findings into attempt one, so a re-author after a failed
 * frame gate starts where the render stopped rather than redrawing blind.
 */
export async function authorDiagrams({
  beats, context = '', key, cheap = DEFAULT_DIAGRAM, strong = ESCALATE, priorFindings = [], log = console.error,
} = {}) {
  const prompt = await readPrompt('DIAGRAMMER.md');
  const change = context
    ? `\n\nTHE CHANGE ITSELF. Every box must hold an artifact from below — an identifier, a value, a state or a count. Do not draw from the beats alone:\n${context}`
    : '';

  // One call per beat, all in flight: the stage's wall time is its output tokens, and
  // one call writes five diagrams in series. The retry budget goes per beat too.
  const runs = await Promise.all(beats.map((beat, i) => gated({
    attempts: DIAGRAM_ATTEMPTS,
    label: `diagram lint [${beat.name}]`,
    log,
    lint: (spec) => beatFindings(spec, beat, i === beats.length - 1),
    // Repair first, lint second: the mechanical mistakes cost nothing to fix here and
    // a retry spent on them is a retry not spent on the picture being wrong.
    repair: (spec) => {
      const { spec: fixed, repairs } = repairDiagrams(spec);
      for (const r of repairs) log('  repaired ' + r);
      return fixed;
    },
    // The cheap tier draws first; the LAST attempt is the strong model, so a beat the
    // cheap tier cannot draw still ships.
    tierFor: (attempt) => (attempt < DIAGRAM_ATTEMPTS - 1 ? cheap : strong),
    draft: (extra, tier) =>
      complete({
        key,
        model: tier.model,
        effort: tier.effort,
        envelope: 'diagrams',
        system: prompt + seedFor(priorFindings, beat) + extra,
        // The whole script still goes in: a beat drawn without its neighbours repeats
        // them. Only the ASK narrows, so the output tokens are one beat's, not five.
        user: `ALL BEATS, so your diagram does not repeat a neighbour's:\n${JSON.stringify(beats)}`
          + `\n\nDRAW BEAT ${i + 1} OF ${beats.length}${i === beats.length - 1 ? ' — the closing beat, which may return null if it is purely the ask or a sign-off' : ''}.`
          + ` Return the array with EXACTLY ONE entry, for this beat:\n${JSON.stringify(beat)}`
          + change,
      }),
  })));

  const value = runs.map((r) => r.value[0]);
  const warnings = runs.flatMap((r) => r.warnings || []);
  // The per-beat lints ran on one entry each, so the array as a whole is checked once
  // more here. Structure only: a taste finding each beat's own gate already accepted
  // is carried out as a warning, not thrown after the drafts are spent.
  const findings = lintDiagrams(value, beats);
  const hard = findings.filter((f) => !findings.soft.includes(f) && !warnings.includes(f));
  if (hard.length) throw new Error(`diagram lint never passed: ${hard.join(' | ')}`);
  return {
    value, warnings,
    attempts: Math.max(...runs.map((r) => r.attempts)),
    used: runs.flatMap((r) => r.used),
  };
}

// diaglint reads the closing-ask exemption off the entry's position, so a one-entry
// array would exempt every beat. The rule is restored here instead of relaxed.
function beatFindings(spec, beat, isLast) {
  if (!Array.isArray(spec) || spec.length !== 1) {
    return [`[${beat.name}] return exactly one entry, for this beat`];
  }
  if (!spec[0]?.diagram && !isLast) {
    return [`[${beat.name}] no diagram — every beat needs one except a closing ask`];
  }
  return lintDiagrams(spec, [beat]);
}

// framelint tags its findings with the beat they were seen on, so a re-author after a
// failed frame gate hands each beat its own pixels rather than all five beats'.
function seedFor(priorFindings, beat) {
  if (!priorFindings.length) return '';
  const mine = priorFindings.filter((f) => !f.startsWith('[') || f.startsWith(`[${beat.name}]`));
  if (!mine.length) return '';
  return `\n\nTHE RENDERED FRAMES FAILED THE PIXEL GATE:\n${mine.join('\n')}\nFix every finding.`;
}

/**
 * Author a vertical video script and its visual layer from a plan packet.
 *
 * `packet` is `{ plan, evidence? }` — the same object the local pipeline reads off
 * disk. Returns `{ mode, visual, beats, diagrams, mockups, shots, attempts }`. The
 * artifacts have already passed their gates, so a caller can render them without
 * re-checking. `visual` says which layer was authored: `diagram` fills `diagrams`,
 * `mockup` fills `mockups` + `shots` and leaves `diagrams` empty.
 *
 * `visual` forces the layer. `workdir` is where mockup HTML and PNGs land; without
 * one they go to a temp directory, which is right for a caller that only wants the
 * spec back.
 *
 * `script` and `diagram` override the tiers as `{ model, effort }`; `model` alone
 * still works and pins BOTH stages to it, which is what a caller asking for one
 * specific model means.
 */
export async function authorPacketVideo({ packet, mode, visual, model, script: scriptTier, diagram: diagramTier, workdir, key, log = console.error } = {}) {
  const apiKey = await resolveKey(key);
  if (!apiKey) throw new Error('packet authoring needs OPENAI_API_KEY (env, ./.env, or "openaiKey" in ~/.spool.json)');
  const register = mode || inferMode(packet);
  const layer = visual || inferVisual(packet);

  const scriptCfg = scriptTier ?? (model ? { model, effort: null } : DEFAULT_SCRIPT);
  const cheapCfg = diagramTier ?? (model ? { model, effort: null } : DEFAULT_DIAGRAM);
  const strongCfg = model ? cheapCfg : ESCALATE;

  const scriptPrompt = await readPrompt('SCRIPTWRITER.md');
  const script = await gated({
    attempts: SCRIPT_ATTEMPTS,
    label: 'slop lint',
    log,
    lint: lintBeats,
    tierFor: () => scriptCfg,
    draft: (extra, tier) =>
      complete({
        key: apiKey,
        model: tier.model,
        effort: tier.effort,
        envelope: 'beats',
        system: scriptPrompt + extra,
        // The script has to know which visual layer it is writing for: one mockup can
        // only show one option, so a design packet needs a beat per option.
        user: `MODE: ${register}\nVISUALS: ${layer}\n\nPACKET:\n${JSON.stringify(packet)}`,
      }),
  });

  if (layer === 'mockup') {
    const mockups = await authorMockups({ packet, beats: script.value, apiKey, cfg: cheapCfg, strongCfg, workdir, log });
    return {
      mode: register,
      visual: layer,
      beats: script.value,
      diagrams: [],
      mockups: mockups.value,
      shots: mockups.shots,
      attempts: { script: script.attempts, mockups: mockups.attempts },
      models: { script: script.used, mockups: mockups.used },
    };
  }

  const drawing = { beats: script.value, context: `PLAN PACKET:\n${JSON.stringify(packet)}`, key: apiKey, cheap: cheapCfg, strong: strongCfg, log };
  const diagrams = await authorDiagrams(drawing);

  return {
    mode: register,
    visual: layer,
    beats: script.value,
    diagrams: diagrams.value,
    mockups: null,
    shots: [],
    attempts: { script: script.attempts, diagrams: diagrams.attempts },
    // Which model actually drew each attempt, so a caller can see when the cheap
    // tier handed off rather than inferring it from the bill.
    models: { script: script.used, diagrams: diagrams.used },
    // The frame gate's way back in: same beats, same VO, diagrams redrawn with the
    // pixel findings in hand.
    redraw: async (findings) => (await authorDiagrams({ ...drawing, priorFindings: findings })).value,
  };
}

/**
 * The mockup stage: draft screens, render them, and judge the pixels.
 *
 * The screenshots are inside the loop rather than after it, because the findings that
 * matter most here — a screen that overflowed, a title cut off mid-word, two options
 * that came out looking the same — do not exist until a browser has drawn the spec.
 * A retry gets those findings by beat, exactly as the diagram stage gets its geometry.
 */
async function authorMockups({ packet, beats, apiKey, cfg, strongCfg, workdir, log }) {
  const dir = workdir ? join(workdir, 'mockups') : await mkdtemp(join(tmpdir(), 'spool-mockups-'));
  const prompt = await readPrompt('MOCKUPPER.md');
  const options = optionsOf(packet);
  log(`[mockup] ${options.length} option(s) to draw: ${options.map((o) => o.id).join(', ')}`);

  let shots = [];
  const run = await gated({
    attempts: MOCKUP_ATTEMPTS,
    label: 'mockup lint',
    log,
    tierFor: (attempt) => (attempt < ESCALATE_AFTER ? cfg : strongCfg),
    lint: async (spec) => {
      const { findings, renderable } = lintMockupSpec(spec, beats, packet);
      if (!renderable) return findings;
      shots = await shootMockups(spec, dir);
      return [...findings, ...await lintMockupShots(shots)];
    },
    draft: (extra, tier) =>
      complete({
        key: apiKey,
        model: tier.model,
        effort: tier.effort,
        envelope: 'mockups',
        system: prompt + extra,
        user: `OPTIONS TO COVER:\n${options.map((o) => `- "${o.id}": ${o.label}`).join('\n')}`
          + `\n\nBEATS:\n${JSON.stringify(beats)}\n\nPACKET:\n${JSON.stringify(packet)}`,
      }),
  });
  return { ...run, shots };
}
