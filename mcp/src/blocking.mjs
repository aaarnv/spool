// "A comment blocks: an agent may not proceed past an unacknowledged one."
//
// The platform already enforces that rule twice — `nextAction` becomes
// `acknowledge_comments` and the write paths answer 409 `unacked_comments` with the
// same list (CONTRACTS.md "Blocking comments"). What this module adds is the part a
// stock agent actually reads: the block has to be the FIRST thing in the answer, in
// prose, naming each steer and the exact tool call that clears it.
//
// A payload where `blockedBy` is field number nine of forty is a rule an agent can miss
// by accident, and an agent that misses it does the work the comment was written to
// stop. So every tool that can be refused for this reason routes its refusal through
// here, and the two read tools lead with the same sentence whether or not anything is
// refusing them yet.

/** The steers carried by a read payload or by a 409, whichever this is. */
export function blockersOf(data) {
  const list = data?.blockedBy;
  return Array.isArray(list) ? list : [];
}

/** True when the platform refused this call because a steer is unacknowledged. */
export function isBlockedRefusal(result) {
  return result?.status === 409 && result?.data?.reason === 'unacked_comments';
}

const anchorLabel = (anchor) => {
  if (!anchor || typeof anchor !== 'object') return null;
  // A `general` steer is about the work, not about a moment of the video. Saying "on
  // general: the plan" would be noise dressed as context, so it gets no `on` clause.
  if (anchor.type === 'general') return null;
  if (anchor.label) return `${anchor.type}: ${anchor.label}`;
  if (anchor.type === 'range') return `range ${anchor.start}s–${anchor.end}s`;
  return anchor.type || null;
};

/**
 * One steer, as a line an agent can act on without a second lookup.
 *
 * A steer is a conversation, so the whole unacknowledged tail is printed, not just the
 * message that opened it. An agent shown only the first line of a thread whose third line
 * says "no, the other one" will confidently do the wrong thing.
 */
function steerLines(spoolId, comment, index) {
  const where = anchorLabel(comment.anchor);
  const unacked = Array.isArray(comment.unacked) && comment.unacked.length ? comment.unacked : null;
  const opening = unacked ? unacked[0] : { author: comment.askedBy, body: comment.body };
  const lines = [`  ${index + 1}. from the ${opening.author ?? comment.askedBy}${where ? ` on ${where}` : ''}: ${opening.body}`];
  for (const message of (unacked ?? []).slice(1)) {
    lines.push(`     then the ${message.author} added: ${message.body}`);
  }
  if (unacked && unacked.length > 1) {
    lines.push(`     (${unacked.length} unacknowledged messages in this thread; one ack covers all of them)`);
  }
  lines.push(`     clear it with: ack_comment { "spoolId": "${spoolId}", "questionId": "${comment.id}" }`);
  lines.push(`     answer it with: answer_question { "spoolId": "${spoolId}", "questionId": "${comment.id}", "body": "…" }`);
  return lines;
}

/**
 * The headline plus one block per steer.
 *
 * `acknowledging is not answering` is repeated here rather than left to the docs: it is
 * the single most likely thing for an agent to get wrong, and getting it wrong turns
 * the rule into a way to dismiss feedback.
 */
export function blockedText(spoolId, blockedBy, { verb = 'proceed' } = {}) {
  const n = blockedBy.length;
  const lines = [
    `BLOCKED: ${n} thread${n === 1 ? '' : 's'} on this plan's current revision ${n === 1 ? 'has' : 'have'} unacknowledged messages, so you may not ${verb}.`,
    'Acknowledging is not answering: the ack records that you READ the steer, the question stays open until you reply to it.',
    'An ack covers a thread only up to its newest message. If somebody adds another one, you are blocked again.',
    '',
  ];
  blockedBy.forEach((comment, i) => lines.push(...steerLines(spoolId, comment, i)));
  return lines.join('\n');
}

/**
 * Frame a platform refusal as a blocked answer when that is what it is.
 *
 * Returns null for every other refusal, so the caller falls through to its own error
 * handling instead of this module quietly swallowing an unrelated 409.
 */
export function blockedRefusal(spoolId, result, { verb = 'proceed' } = {}) {
  if (!isBlockedRefusal(result)) return null;
  const blockedBy = blockersOf(result.data);
  return {
    text: blockedText(spoolId, blockedBy, { verb }),
    // `blocked` is the first key on purpose: a client that renders only the head of an
    // object still renders the reason it was refused.
    json: {
      blocked: true,
      blockingCount: blockedBy.length,
      reason: 'unacked_comments',
      refused: verb,
      blockedBy,
      current: result.data.current ?? null,
      error: result.data.error ?? null,
    },
  };
}

/**
 * The blocked-first framing of a read payload.
 *
 * The whole payload rides along untouched underneath — it is additive-stable and agents
 * branch on its documented fields, so nothing here renames or drops anything.
 */
export function frameRead(payload) {
  const blockedBy = blockersOf(payload);
  const blocked = blockedBy.length > 0;
  const next = payload?.nextAction;
  const head = blocked
    ? blockedText(payload.spoolId, blockedBy, { verb: 'move this plan forward' })
    : [
        `plan ${payload?.spoolId ?? '?'} is ${payload?.status ?? 'unknown'} (revision ${payload?.revision ?? '?'}), you are the ${payload?.actor ?? 'unknown actor'}.`,
        decisionLine(payload?.decision, payload?.options),
        `next: ${next?.action ?? 'none'}${next?.reason ? ` — ${next.reason}` : ''}`,
        next?.endpoint ? `endpoint: ${next.endpoint.method} ${next.endpoint.path}` : 'endpoint: none — wait for somebody else to act.',
      ]
        .filter(Boolean)
        .join('\n');
  return {
    text: head,
    json: { blocked, blockingCount: blockedBy.length, ...payload },
  };
}

/**
 * What the reviewer actually decided, in one line.
 *
 * The status alone lost this the moment the vocabulary grew past approve/redirect: three
 * verbs land on `approved` and two on `redirected`, so "the plan is approved" no longer
 * tells the agent whether to build the headline approach or the alternative it was told
 * to build instead.
 */
export function decisionLine(decision, options) {
  if (!decision?.action) return null;
  const parts = [`decision: ${decision.action}`];
  // The option that WON, by name, from the resolved list. `optionId` alone is an opaque
  // string, and for a plain `approve` there is no optionId at all even though an option
  // did win — the recommended one. Both cases have to read the same or an agent has to
  // re-derive "what am I building" from the action, which is the derivation this exists
  // to remove.
  const won = Array.isArray(options) ? options.find((o) => o?.chosen) : null;
  if (won) parts.push(`build "${won.label}" (${won.optionId}): ${won.summary}`);
  else if (decision.optionId) parts.push(`build ${decision.optionId}, not the headline approach`);
  if (decision.conditionIds?.length)
    parts.push(`${decision.conditionIds.length} condition(s) attached — they are steers, and they block you until acked`);
  if (decision.notes) parts.push(`they said: ${decision.notes}`);
  return parts.join(' — ');
}

/**
 * The gate: may this reader move the plan forward right now, and if not, why not.
 *
 * Derived from the read payload rather than asked for separately, because `nextAction`
 * and `blockedBy` are computed from the same matrix the routes are gated by — a second
 * opinion computed here could disagree with the routes, which is the failure the
 * platform's own one-module rule exists to prevent.
 */
export function frameGate(payload) {
  const blockedBy = blockersOf(payload);
  const blocked = blockedBy.length > 0;
  const next = payload?.nextAction ?? null;
  const may = Array.isArray(payload?.may) ? payload.may : [];
  const waiting = !blocked && (!next || next.action === 'await_decision' || next.action === 'await_revision' || next.action === 'none');
  const text = blocked
    ? blockedText(payload.spoolId, blockedBy, { verb: 'move this plan forward' })
    : [
        `gate: ${waiting ? 'WAIT' : 'PROCEED'} — plan ${payload?.spoolId ?? '?'} is ${payload?.status ?? 'unknown'} at revision ${payload?.revision ?? '?'}.`,
        decisionLine(payload?.decision, payload?.options),
        `next: ${next?.action ?? 'none'}${next?.reason ? ` — ${next.reason}` : ''}`,
        `you may: ${may.length ? may.join(', ') : '(nothing this host will say)'}`,
      ]
        .filter(Boolean)
        .join('\n');
  return {
    text,
    json: {
      blocked,
      blockingCount: blockedBy.length,
      blockedBy,
      mayProceed: !blocked && !waiting,
      waiting,
      status: payload?.status ?? null,
      revision: payload?.revision ?? null,
      revisionId: payload?.revisionId ?? null,
      actor: payload?.actor ?? null,
      nextAction: next,
      may,
      // What the reviewer was offered, and which of them won. A gate answer that says
      // PROCEED without saying what to proceed WITH is half an answer.
      options: Array.isArray(payload?.options) ? payload.options : [],
      openQuestions: Array.isArray(payload?.openQuestions) ? payload.openQuestions : [],
      decision: payload?.decision ?? null,
      implementation: payload?.implementation ?? null,
    },
  };
}
