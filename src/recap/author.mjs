// Merged pull request → recap script → diagrams, with no coding agent in the loop.
//
// This is the packet authoring stage (src/packet/author.mjs) pointed at a different
// input. A plan packet is a proposal an owner has to decide; a merged PR is a fact a
// teammate has to absorb. The stages are the same shape — draft, lint, hand the
// findings back, escalate the tier when the cheap one cannot draw — so the machinery
// is imported rather than copied, and only the SCRIPT prompt is new (RECAPPER.md).
//
// The SCRIPT GATE is not shared, though. sloplint governs both lanes, but a recap has
// failure modes a proposal cannot have — a closer that inventories the files, a beat
// that recites class names, "we should" about work that already merged — so the recap
// lane runs sloplint wrapped in those extra rules (recaplint.mjs) and the plan lane is
// left exactly as calibrated.
//
// The diagram stage is reused verbatim. DIAGRAMMER.md reads BEATS and nothing else:
// it never sees the packet, so it cannot tell a plan's beats from a recap's, and a
// second copy of that prompt would be a second copy of the geometry rules to drift.
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_DIAGRAM,
  DEFAULT_SCRIPT,
  ESCALATE,
  complete,
  gated,
  resolveKey,
} from '../packet/author.mjs';
import { lintRecapBeats } from './recaplint.mjs';
import { lintDiagrams, repairDiagrams } from '../packet/diaglint.mjs';
import { renderDiff } from './pr.mjs';

const PROMPTS = new URL('../packet/', import.meta.url);

const SCRIPT_ATTEMPTS = 3;
const DIAGRAM_ATTEMPTS = 4;
const ESCALATE_AFTER = 2;

const readPrompt = (name) => readFile(new URL(name, PROMPTS), 'utf8');

/**
 * Author a vertical recap script and its diagrams from one merged pull request.
 *
 * `pr` is what `fetchPullRequest` returns. Returns the same shape the packet author
 * returns — `{ mode, visual, beats, diagrams, attempts, models }` — so the render
 * stage does not care which lane produced it.
 *
 * The visual layer is always `diagram`. A recap has no options to compare and no
 * screen to show, so the mockup lane has nothing to draw; a diff about a UI change is
 * still a MECHANISM story here, because the screen it changed is not ours to render.
 */
export async function authorRecapVideo({ pr, model, script: scriptTier, diagram: diagramTier, key, log = console.error } = {}) {
  const apiKey = await resolveKey(key);
  if (!apiKey) throw new Error('recap authoring needs OPENAI_API_KEY (env, ./.env, or "openaiKey" in ~/.spool.json)');
  if (!pr) throw new Error('authorRecapVideo: pr required');

  const scriptCfg = scriptTier ?? (model ? { model, effort: null } : DEFAULT_SCRIPT);
  const cheapCfg = diagramTier ?? (model ? { model, effort: null } : DEFAULT_DIAGRAM);
  const strongCfg = model ? cheapCfg : ESCALATE;

  const diff = renderDiff(pr);
  const scriptPrompt = await readPrompt('RECAPPER.md');
  const script = await gated({
    attempts: SCRIPT_ATTEMPTS,
    label: 'recap lint',
    log,
    lint: lintRecapBeats,
    tierFor: () => scriptCfg,
    draft: (extra, tier) =>
      complete({
        key: apiKey,
        model: tier.model,
        effort: tier.effort,
        envelope: 'beats',
        system: scriptPrompt + extra,
        user: diff,
      }),
  });

  const diagramPrompt = await readPrompt('DIAGRAMMER.md');
  const diagrams = await gated({
    attempts: DIAGRAM_ATTEMPTS,
    label: 'diagram lint',
    log,
    lint: (spec) => lintDiagrams(spec, script.value),
    repair: (spec) => {
      const { spec: fixed, repairs } = repairDiagrams(spec);
      for (const r of repairs) log('  repaired ' + r);
      return fixed;
    },
    tierFor: (attempt) => (attempt < ESCALATE_AFTER ? cheapCfg : strongCfg),
    draft: (extra, tier) =>
      complete({
        key: apiKey,
        model: tier.model,
        effort: tier.effort,
        envelope: 'diagrams',
        system: diagramPrompt + extra,
        user: `BEATS:\n${JSON.stringify(script.value)}`,
      }),
  });

  return {
    mode: 'commentary',
    visual: 'diagram',
    beats: script.value,
    diagrams: diagrams.value,
    mockups: null,
    shots: [],
    attempts: { script: script.attempts, diagrams: diagrams.attempts },
    models: { script: script.used, diagrams: diagrams.used },
  };
}
