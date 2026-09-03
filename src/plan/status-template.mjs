// The status spool's creation template (roadmap R5.4).
//
// A status reply is a recording, so `spool status` scaffolds the narration as well as
// the descriptor. The skeleton is not decoration: it fixes the ORDER a status is told
// in — the verdict first, then what is done, then what changed or what blocks, then
// what happens next — which is what makes a status skimmable in seconds whether it is
// read or watched.
//
// Pure: it turns a report plus its parent's facts into the text of a steps.mjs file,
// so the shape is testable without a browser. See CONTRACTS.md "Implementation status".

import { VERDICT_LABEL } from './status.mjs';

const quote = (s) => JSON.stringify(String(s));

/** "step 2 of 4" — progress a reviewer can hear, from ids they can check. */
function progress(report, parent) {
  const total = parent.approach?.length ?? 0;
  const done = report.completed?.length ?? 0;
  if (!total || !done) return null;
  return `${done} of ${total} step${total === 1 ? '' : 's'}`;
}

/**
 * The narration the recording opens with. One sentence, and it carries the verdict —
 * a reviewer who stops after it still knows whether the work is on plan.
 */
export function verdictNarration(report, parent = {}) {
  const goal = parent.goal ? ` on ${parent.goal.replace(/\.$/, '')}` : '';
  const done = progress(report, parent);
  const lead =
    report.verdict === 'blocked' ? `Status${goal}: this is blocked.`
    : report.verdict === 'changed' ? `Status${goal}: the work has changed from the approved plan.`
    : `Status${goal}: still on plan.`;
  const holds = report.planValid
    ? 'The approved plan still holds.'
    : 'The approved plan no longer holds, so this needs a new decision.';
  return done ? `${lead} ${done} done. ${holds}` : `${lead} ${holds}`;
}

/**
 * The steps a status spool is told in. Only the beats this report has words for: a
 * status with nothing blocked does not open a step to say so.
 */
export function statusSteps(report, parent = {}) {
  const steps = [{ name: 'verdict', narration: verdictNarration(report, parent) }];
  if (report.completed?.length) {
    const labels = report.completed.map((id) => {
      const step = parent.approach?.find((s) => s.id === id);
      return step ? step.summary.replace(/\.$/, '') : id;
    });
    steps.push({ name: 'done', narration: `Done since the plan was approved: ${labels.join('; ')}.` });
  }
  if (report.changed) steps.push({ name: 'changed', narration: `What changed: ${report.changed}` });
  if (report.blocked) steps.push({ name: 'blocked', narration: `What is in the way: ${report.blocked}` });
  if (report.next) steps.push({ name: 'next', narration: `Next: ${report.next}` });
  return steps;
}

/**
 * The text of the scaffolded steps.mjs. The narration is written; the driver is not —
 * showing the work is the part only the agent recording it can author.
 */
export function statusStepsFile(report, parent = {}, { url = 'http://localhost:3000' } = {}) {
  const title = `Status: ${VERDICT_LABEL[report.verdict] ?? report.verdict}${parent.goal ? ` — ${parent.goal}` : ''}`;
  const body = statusSteps(report, parent)
    .map(
      (s) => `  {
    name: ${quote(s.name)},
    narration: ${quote(s.narration)},
    zoom: 'auto',
    run: async (page, h) => {
      // TODO: show it. A status is believed when the reviewer sees the thing being claimed.
      await h.pause(800);
    },
  },`
    )
    .join('\n');

  return `// Status spool — the recording behind reply.json (roadmap R5.4).
//
// The narration below is scaffolded from the status report: the verdict first, then
// what is done, then what changed or what blocks, then what happens next. Keep that
// order — a reviewer who watches ten seconds must already know where the work is.
//
// Workflow: edit steps → \`spool dry <workdir> --headed\` → \`spool build <workdir>\`.

export const config = {
  url: ${quote(url)},
  viewport: { width: 1600, height: 900 },
  title: ${quote(title)},
  prep: async (page, h) => {},
};

export const steps = [
${body}
];
`;
}
