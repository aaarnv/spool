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
// The diagram stage is reused verbatim (`authorDiagrams`). What differs is the CHANGE
// handed to it beside the beats: a plan lane passes its packet, this lane passes the
// trimmed diff, so a box can hold an identifier the model actually read.
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_DIAGRAM,
  DEFAULT_SCRIPT,
  ESCALATE,
  authorDiagrams,
  complete,
  gated,
  resolveKey,
} from '../packet/author.mjs';
import { lintRecapBeats } from './recaplint.mjs';
import { renderDiagramDiff, renderDiff, DIAGRAM_DIFF_CHARS } from './pr.mjs';
import { deriveUnderstanding, renderRecapContext } from './context.mjs';

const PROMPTS = new URL('../packet/', import.meta.url);

const SCRIPT_ATTEMPTS = 3;

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
export async function authorRecapVideo({ pr, context = null, model, script: scriptTier, diagram: diagramTier, key, log = console.error } = {}) {
  const apiKey = await resolveKey(key);
  if (!apiKey) throw new Error('recap authoring needs OPENAI_API_KEY (env, ./.env, or "openaiKey" in ~/.spool.json)');
  if (!pr) throw new Error('authorRecapVideo: pr required');

  const scriptCfg = scriptTier ?? (model ? { model, effort: null } : DEFAULT_SCRIPT);
  const cheapCfg = diagramTier ?? (model ? { model, effort: null } : DEFAULT_DIAGRAM);
  const strongCfg = model ? cheapCfg : ESCALATE;

  const repositoryContext = renderRecapContext(context);
  const diff = [renderDiff(pr), repositoryContext].filter(Boolean).join('\n\n');
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

  // The diagram diff is the dominant input to the dominant cost, so its size is
  // reported rather than inferred from the bill.
  const diagramDiff = renderDiagramDiff(pr);
  log(`[recap] diagram diff: ${diagramDiff.length} chars (cap ${DIAGRAM_DIFF_CHARS})`);
  const drawing = { beats: script.value, context: diagramDiff, key: apiKey, cheap: cheapCfg, strong: strongCfg, log };
  const diagrams = await authorDiagrams(drawing);

  return {
    mode: 'commentary',
    visual: 'diagram',
    beats: script.value,
    diagrams: diagrams.value,
    mockups: null,
    shots: [],
    attempts: { script: script.attempts, diagrams: diagrams.attempts },
    models: { script: script.used, diagrams: diagrams.used },
    // Taste findings the gate accepted on its last attempt. Carried so the job can
    // record what shipped imperfect rather than losing it to the worker's log.
    warnings: [...(script.warnings || []), ...(diagrams.warnings || [])],
    // The frame gate's way back in: same beats, same VO, diagrams redrawn with the
    // pixel findings in hand.
    redraw: async (findings) => (await authorDiagrams({ ...drawing, priorFindings: findings })).value,
    understanding: deriveUnderstanding({ pr, beats: script.value, context }),
  };
}
