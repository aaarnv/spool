const CHAPTER_CARD_TYPES = Object.freeze({
  context: 'context',
  outcome: 'outcome',
  approach: 'sequence',
  risks: 'risks',
  decision: 'decision',
});

const DEFAULT_TITLES = Object.freeze({
  context: 'What exists today',
  outcome: 'What changes',
  approach: 'How we build it',
  risks: 'What could go wrong',
  decision: 'What we need from you',
  evidence: 'What supports this plan',
});

const OPTION_LABELS = Object.freeze({
  approve: 'Approve',
  redirect: 'Redirect',
  'ask-question': 'Ask a question',
  'needs-input': 'Needs input',
});

export function chapterCardType(chapterId) {
  return CHAPTER_CARD_TYPES[chapterId] || null;
}

function chapterTitle(script, id) {
  return script?.chapters?.find((chapter) => chapter.id === id)?.title || DEFAULT_TITLES[id];
}

function optionLabel(id, alternatives) {
  if (OPTION_LABELS[id]) return OPTION_LABELS[id];
  if (!id.startsWith('alternative:')) return id;
  const alternative = alternatives.find((item) => item.id === id.slice('alternative:'.length));
  return alternative?.summary || id;
}

/**
 * Convert plan artifacts into renderer-ready card models.
 * Source strings remain verbatim so the video never invents a claim.
 */
export function buildPlanCards({ plan, evidence = null, script = null }) {
  const alternatives = plan?.alternatives || [];
  return [
    {
      id: 'context',
      type: 'context',
      title: chapterTitle(script, 'context'),
      goal: plan?.goal || '',
      claims: (plan?.currentState || []).map((item) => item.claim),
    },
    {
      id: 'outcome',
      type: 'outcome',
      title: chapterTitle(script, 'outcome'),
      statement: plan?.outcome || '',
    },
    {
      id: 'approach',
      type: 'sequence',
      title: chapterTitle(script, 'approach'),
      steps: (plan?.approach || []).map((item, index) => ({
        id: item.id,
        number: index + 1,
        label: item.summary,
      })),
    },
    {
      id: 'risks',
      type: 'risks',
      title: chapterTitle(script, 'risks'),
      // A risk is authored as a string or as a claim, and the published copy
      // normalizes it to a claim — so cards are built from both shapes.
      risks: (plan?.risks || []).map((r) => (typeof r === 'string' ? r : r?.claim ?? '')),
      assumptions: [...(plan?.assumptions || [])],
    },
    {
      id: 'decision',
      type: 'decision',
      title: chapterTitle(script, 'decision'),
      decisionType: plan?.decision?.type || null,
      prompt: plan?.decision?.prompt || '',
      options: (plan?.decision?.options || []).map((id) => ({
        id,
        label: optionLabel(id, alternatives),
      })),
    },
    {
      id: 'evidence',
      type: 'evidence',
      title: DEFAULT_TITLES.evidence,
      items: (evidence?.items || []).map((item) => ({
        id: item.id,
        kind: item.kind,
        label: item.label,
        ref: item.ref,
        revision: item.revision || null,
        chapterIds: [...(item.chapterIds || [])],
      })),
    },
  ];
}

export function visualModeForChapter({ visual, timeline }) {
  if (!visual || visual.kind === 'card') return 'card-only';
  const supported = new Set(['browser', 'code', 'image', 'terminal']);
  if (supported.has(visual.kind)) return 'overlay';
  return timeline?.target === 'os' ? 'overlay' : 'card-only';
}

export function activePlanVisual({ cards, script, windows, timeline, time }) {
  const availableWindows = windows || [];
  let window = availableWindows.find((item) => time >= item.startSec && time < item.endSec);
  if (!window && availableWindows.length) {
    window = time < availableWindows[0].startSec
      ? availableWindows[0]
      : availableWindows[availableWindows.length - 1];
  }
  const chapter = script?.chapters?.find((item) => item.id === window?.name)
    || script?.chapters?.[0]
    || null;
  const type = chapterCardType(chapter?.id);
  const card = cards?.find((item) => item.type === type) || null;
  const evidenceCard = cards?.find((item) => item.type === 'evidence');
  const evidence = (evidenceCard?.items || []).filter((item) => item.chapterIds.includes(chapter?.id));
  return {
    chapter,
    card,
    mode: visualModeForChapter({ visual: chapter?.visual, timeline }),
    evidence,
  };
}

function rect(x, y, width, height) {
  return { x, y, width, height };
}

/**
 * Reserve distinct bounds for plan copy, source footage, and captions.
 * Cards never cover the media rectangle.
 */
export function planStageLayout({ width, height, mode }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('plan stage needs positive width and height');
  }
  const portrait = height > width;
  const canvas = { width, height };

  if (mode === 'card-only') {
    if (portrait) {
      return {
        canvas,
        orientation: 'portrait',
        media: null,
        card: rect(width * 0.055, height * 0.075, width * 0.89, height * 0.73),
        caption: rect(width * 0.055, height * 0.86, width * 0.89, height * 0.1),
      };
    }
    return {
      canvas,
      orientation: 'landscape',
      media: null,
      card: rect(width * 0.094, height * 0.11, width * 0.812, height * 0.71),
      caption: rect(width * 0.094, height * 0.86, width * 0.812, height * 0.1),
    };
  }

  if (portrait) {
    return {
      canvas,
      orientation: 'portrait',
      media: rect(width * 0.045, height * 0.03, width * 0.91, height * 0.42),
      card: rect(width * 0.055, height * 0.47, width * 0.89, height * 0.36),
      caption: rect(width * 0.055, height * 0.875, width * 0.89, height * 0.095),
    };
  }

  return {
    canvas,
    orientation: 'landscape',
    media: rect(width * 0.025, height * 0.06, width * 0.615, height * 0.72),
    card: rect(width * 0.665, height * 0.06, width * 0.31, height * 0.72),
    caption: rect(width * 0.08, height * 0.835, width * 0.84, height * 0.12),
  };
}
