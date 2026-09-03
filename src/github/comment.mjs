// The compact plan comment on a pull request.
//
// A reviewer arriving at a pull request should find the plan in one place: what it
// proposes, whether it was decided, whether it is still about this code, and where to
// watch it. That is one comment, kept up to date in place — a thread of near-identical
// bot comments is noise, and noise is what makes a team turn an integration off.
//
// See CONTRACTS.md "GitHub integration".

import { createComment, listComments, updateComment } from './gh.mjs';
import { formatRef } from './refs.mjs';

/** The hidden anchor that makes a comment findable on the next run. */
export const MARKER_PREFIX = 'spool-plan:';
export const commentMarker = (key) => `<!-- ${MARKER_PREFIX}${key} -->`;

/** The key inside a spool marker, or null when the body carries none. */
export function markerKey(body) {
  const m = String(body || '').match(/<!--\s*spool-plan:([^\s>]+)\s*-->/);
  return m ? m[1] : null;
}

const human = (status) => String(status || 'unknown').replace(/_/g, ' ');
const short = (sha) => (typeof sha === 'string' && sha.length > 7 ? sha.slice(0, 7) : sha || null);
const link = (label, url) => (url ? `[${label}](${url})` : null);

/**
 * Render the comment body. Pure, so the caller can compare it with what is already on
 * the pull request and post nothing when they match.
 *
 * Compact by design: the plan itself is the long form, and this comment is the pointer
 * to it. Anything a reviewer cannot act on from the pull request stays out.
 */
export function renderPlanComment(facts) {
  const {
    key,
    goal = null,
    status = 'unknown',
    revision = null,
    decision = null,
    decisionMade = null,
    watch = null,
    branch = null,
    commit = null,
    openQuestions = 0,
    task = null,
    issue = null,
    stale = null,
    error = null,
  } = facts;

  const head = [`**Plan spool — ${human(status)}**`, link('Watch the plan', watch)].filter(Boolean).join(' · ');
  const lines = [commentMarker(key), head, ''];
  if (goal) lines.push(`> ${goal}`, '');

  if (decisionMade) {
    const { action, optionId, notes } = decisionMade;
    lines.push(`**Decided:** ${action}${optionId ? ` → ${optionId}` : ''}`);
    if (notes) lines.push(`Notes: ${notes}`);
    lines.push('');
  } else if (decision?.prompt) {
    lines.push(`**Decision needed** (${decision.type}): ${decision.prompt}`);
    if (decision.options?.length) lines.push(`Options: ${decision.options.map((o) => `\`${o}\``).join(', ')}`);
    lines.push('');
  }

  const source = branch || commit ? `\`${branch || 'detached'}\`${commit ? ` @ \`${short(commit)}\`` : ''}` : 'not pinned';
  const facts2 = [`Source: ${source}`];
  if (revision) facts2.push(`Revision: ${revision}`);
  if (openQuestions) facts2.push(`Open questions: ${openQuestions}`);
  lines.push(...facts2.map((f) => `- ${f}`));

  if (stale?.status === 'stale') {
    lines.push(`- **Stale:** ${stale.why.map((w) => w.detail).join('; ')}`);
  } else if (stale?.status === 'unknown') {
    lines.push(`- Staleness: unknown — ${stale.why[0]?.detail ?? 'no source revision to compare'}`);
  }
  if (error) lines.push(`- Note: ${error}`);

  const related = [link('Task', task), issue ? link(`Issue ${formatRef(issue)}`, issue.url) : null].filter(Boolean);
  if (related.length) lines.push('', related.join(' · '));

  lines.push(
    '',
    '<sub>Posted by `spool plan pr`. This comment is updated in place — decide on the plan page, not in this thread.</sub>'
  );
  return lines.join('\n');
}

/**
 * Put the body on the pull request: update the plan's own comment when it is already
 * there, post one when it is not, and do nothing at all when the text has not changed.
 *
 * `keys` lists every marker this plan may have written before, newest first. A plan
 * comments before it is published (keyed by its workdir slug) and again after (keyed
 * by its spool id), and both must resolve to the same comment or the pull request
 * collects one per run.
 */
export async function upsertPlanComment(gh, { owner, name, number, keys, body, api = {} }) {
  const list = api.listComments || listComments;
  const create = api.createComment || createComment;
  const patch = api.updateComment || updateComment;

  const comments = await list(gh, { owner, name, number });
  const mine = comments.filter((c) => keys.includes(markerKey(c.body)));
  const existing = mine.find((c) => markerKey(c.body) === keys[0]) || mine[0] || null;

  if (!existing) {
    const created = await create(gh, { owner, name, number, body });
    return { action: 'created', id: created?.id ?? null, url: created?.html_url ?? null };
  }
  if (existing.body === body) {
    return { action: 'unchanged', id: existing.id ?? null, url: existing.html_url ?? null };
  }
  const updated = await patch(gh, { owner, name, id: existing.id, body });
  return { action: 'updated', id: updated?.id ?? existing.id ?? null, url: updated?.html_url ?? existing.html_url ?? null };
}
