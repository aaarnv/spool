import { buildPlanCards } from './model.mjs';

export const SAMPLE_PLAN = Object.freeze({
  version: 1,
  kind: 'plan',
  goal: 'Make plan reviews clear before implementation begins.',
  currentState: [
    {
      claim: 'Reviewers must reconstruct the proposal from metadata, narration, and raw product footage.',
      evidence: ['ev-player'],
      chapterId: 'context',
    },
  ],
  outcome: 'One muted plan spool explains the change, the sequence, the risk, and the decision in under 90 seconds.',
  approach: [
    { id: 'model', summary: 'Convert the plan packet into six stable card models.', chapterId: 'approach', evidence: ['ev-renderer'] },
    { id: 'layout', summary: 'Reserve separate bounds for footage, cards, and captions.', chapterId: 'approach' },
    { id: 'fixtures', summary: 'Render every card and source mode as a visual baseline.', chapterId: 'approach' },
  ],
  alternatives: [
    { id: 'captions-only', summary: 'Use captions over full-screen footage only.', tradeoffs: ['Faster to build', 'Harder to scan while muted'] },
  ],
  assumptions: [
    'Plan packets already pass schema validation.',
    'One visual direction becomes the product default after founder review.',
  ],
  risks: [
    'Dense cards can compete with the product footage.',
    'Small output sizes can weaken hierarchy and contrast.',
  ],
  decision: {
    type: 'selection',
    prompt: 'Which visual direction should become the Plan Spool default?',
    options: ['approve', 'alternative:captions-only', 'redirect'],
  },
  chapters: [
    { id: 'context', title: 'Start from shared context' },
    { id: 'outcome', title: 'Make the outcome unmistakable' },
    { id: 'approach', title: 'Show the implementation sequence' },
    { id: 'risks', title: 'Name risk before commitment' },
    { id: 'decision', title: 'Ask for one clear decision' },
  ],
});

export const SAMPLE_EVIDENCE = Object.freeze({
  version: 1,
  kind: 'evidence',
  items: [
    { id: 'ev-player', kind: 'url', label: 'Current plan watch page', ref: 'http://localhost:3000/l/sample', revision: null, chapterIds: ['context'] },
    { id: 'ev-renderer', kind: 'file', label: 'Render engine entry point', ref: 'src/render/engine-ffmpeg/index.mjs', revision: null, chapterIds: ['approach'] },
    { id: 'ev-contract', kind: 'file', label: 'Plan Spool product contract', ref: 'docs/PLAN-SPOOLS-PRD.md', revision: null, chapterIds: ['risks', 'decision'] },
  ],
});

export const SAMPLE_SCRIPT = Object.freeze({
  version: 1,
  kind: 'plan-script',
  goal: SAMPLE_PLAN.goal,
  chapters: [
    { id: 'context', title: SAMPLE_PLAN.chapters[0].title, visual: { kind: 'browser', source: 'evidence:ev-player', label: 'Current plan watch page' } },
    { id: 'outcome', title: SAMPLE_PLAN.chapters[1].title, visual: { kind: 'card', source: 'plan:outcome' } },
    { id: 'approach', title: SAMPLE_PLAN.chapters[2].title, visual: { kind: 'terminal', source: 'evidence:ev-renderer', label: 'Remotion render composition' } },
    { id: 'risks', title: SAMPLE_PLAN.chapters[3].title, visual: { kind: 'card', source: 'plan:risks' } },
    { id: 'decision', title: SAMPLE_PLAN.chapters[4].title, visual: { kind: 'card', source: 'plan:decision' } },
  ],
});

export const SAMPLE_CARDS = Object.freeze(buildPlanCards({
  plan: SAMPLE_PLAN,
  evidence: SAMPLE_EVIDENCE,
  script: SAMPLE_SCRIPT,
}));
