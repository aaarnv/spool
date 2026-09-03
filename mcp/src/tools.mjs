// The tools, one per documented route.
//
// Each entry is deliberately thin: validate what the caller typed, make the one call
// CONTRACTS.md describes, and hand the platform's own payload back. The payloads are
// additive-stable and downstream agents branch on their documented fields, so nothing
// here renames, drops or "tidies" a response. What this layer adds is the two things a
// stock agent cannot get from a JSON body — a first line that says what happened, and a
// blocked-first refusal when a steer is in the way (see blocking.mjs).
//
// The lifecycle these cover, in order, is the draft lane:
//
//   plan_propose → plan_sources → plan_record_start → plan_render → plan_publish
//   → plan_request_decision → (a human decides) → implementation_start → proof_submit
//
// with plan_read, gate_check and await_events readable at every point, ack_comment and
// answer_question for the steers that arrive in between, and plan_revise for a plan
// that came back.

import { z } from 'zod';

import { NO_TOKEN } from './config.mjs';
import { call } from './http.mjs';
import * as cursor from './cursor.mjs';
import { blockedRefusal, blockedText, blockersOf, frameGate, frameRead, isBlockedRefusal } from './blocking.mjs';

/** The platform's own long-poll ceiling (CONTRACTS.md "Long polling"). */
export const POLL_SECONDS = 25;
/** What `await_events` will wait in total, and the most a caller may ask for. */
export const DEFAULT_AWAIT_SECONDS = 60;
export const MAX_AWAIT_SECONDS = 600;
/** Events one `await_events` call will drain before returning, however many pages. */
const AWAIT_EVENT_CAP = 500;

const spoolId = z.string().min(1).describe('the plan spool id, as returned by plan_propose');
const questionId = z.string().min(1).describe('the question id, from blockedBy[].id or openQuestions[].id');
const revisionId = z.string().optional().describe('the revision this acts on; defaults to the current one');
const idempotencyKey = z
  .string()
  .optional()
  .describe('a retry key, 8-200 chars of [A-Za-z0-9._:@-]; resubmitting it replays the first receipt');
const packet = z.record(z.unknown());

/** A refusal the caller must read, in the shape the server turns into an MCP result. */
const fail = (text, json) => ({ isError: true, text, json: json ?? { error: text } });

/** The platform said no. Its own words come first; nothing is invented on top of them. */
function refusal(action, result) {
  const d = result.data || {};
  const lines = [`${action} was refused: ${result.status} ${d.error || '(no message)'}`];
  if (d.reason) lines.push(`reason: ${d.reason}`);
  if (d.current) lines.push(`the plan is now ${d.current.status} at revision ${d.current.revision}`);
  if (d.missing) lines.push(`missing: ${JSON.stringify(d.missing)}`);
  return fail(lines.join('\n'), { ok: false, httpStatus: result.status, ...d });
}

/**
 * Every write can meet a steer, and every one of them says so the same way.
 *
 * A refusal that names `unacked_comments` and carries no `blockedBy` is a broken
 * refusal, and it is reported as one rather than repaired here. Reading the list back
 * off the plan would work, and it would also make the next route that forgets the field
 * indistinguishable from one that did not — the failure would live on quietly in an
 * extra request per refusal. Every lifecycle edge answers through one response builder
 * precisely so this cannot happen; if it happens anyway, the platform is what needs
 * fixing.
 */
function guarded(action, verb, id, result) {
  if (isBlockedRefusal(result)) {
    const blockedBy = blockersOf(result.data);
    if (blockedBy.length === 0) {
      return fail(
        [
          `${action} was refused as blocked, but the platform did not say by what.`,
          'The refusal named `unacked_comments` and carried no `blockedBy`, which the contract says it must.',
          'You are still blocked — do not proceed. Call plan_read to see the steers, and report this: it is a platform bug.',
        ].join('\n'),
        { blocked: true, blockingCount: null, reason: 'unacked_comments', contractViolation: 'blockedBy missing from a blocked refusal', httpStatus: result.status, ...result.data }
      );
    }
    return { isError: true, ...blockedRefusal(id, result, { verb }) };
  }
  return refusal(action, result);
}

async function requireToken(ctx) {
  if (!ctx.cfg.token) return fail(NO_TOKEN);
  return null;
}

// ---------------------------------------------------------------------------
// await_events
// ---------------------------------------------------------------------------

/**
 * Hold open for up to `timeoutSeconds`, re-issuing the platform's 25-second long poll.
 *
 * The platform cannot wait longer than 25 seconds — the function holding the request is
 * a serverless invocation with a wall clock — so waiting for a minute is this side's
 * job, and it is a loop of short waits rather than one long one. The cursor is committed
 * before the first poll and staged after the last, which is what makes a crash replay
 * the page instead of losing it (see cursor.mjs).
 */
export async function awaitEvents(ctx, args = {}) {
  const missing = await requireToken(ctx);
  if (missing) return missing;

  const timeoutSeconds = Math.min(Math.max(Number(args.timeoutSeconds ?? DEFAULT_AWAIT_SECONDS), 0), MAX_AWAIT_SECONDS);
  const limit = Math.min(Math.max(Number(args.limit ?? 100), 1), 500);
  const from = args.from ?? 'cursor';
  const deadline = Date.now() + timeoutSeconds * 1000;

  if (from === 'beginning') await cursor.reset(ctx.cfg, ctx.env);
  let position = from === 'beginning' ? null : await cursor.commit(ctx.cfg, ctx.env);
  const state = await cursor.readState(ctx.cfg, ctx.env);

  // A fresh follower asked to start "now" is anchored at the head first, so it is not
  // handed a history it never wanted. Everything else replays, which is the platform's
  // own default and the only one with no silent gap in it.
  let anchored = false;
  if (!position && from === 'now' && !state.anchored) {
    const head = await call(ctx.cfg, { path: '/api/events', query: { tail: 1, limit: 1 }, timeoutMs: 30_000 });
    if (!head.ok) return refusal('await_events', head);
    position = head.data.cursor ?? null;
    await cursor.anchor(ctx.cfg, position, ctx.env);
    anchored = true;
  }

  const events = [];
  let hasMore = false;
  let polls = 0;
  const startedAt = Date.now();

  for (;;) {
    const remainingMs = deadline - Date.now();
    const wait = events.length ? 0 : Math.min(POLL_SECONDS, Math.max(0, Math.ceil(remainingMs / 1000)));
    const page = await call(ctx.cfg, {
      path: '/api/events',
      query: { cursor: position ?? undefined, planId: args.planId, limit, wait },
      // The platform's ceiling plus room for its final query and the response, so a wait
      // that runs its full length is never read here as a network failure.
      timeoutMs: (wait + 20) * 1000,
      signal: ctx.signal,
    });
    polls += 1;
    if (!page.ok) return refusal('await_events', page);

    events.push(...(page.data.events ?? []));
    position = page.data.cursor ?? position;
    hasMore = !!page.data.hasMore;

    if (events.length >= AWAIT_EVENT_CAP) break;
    if (hasMore) continue;
    if (events.length) break;
    if (Date.now() >= deadline) break;
  }

  if (events.length) await cursor.stage(ctx.cfg, position, ctx.env);

  const waitedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
  const head = events.length
    ? `${events.length} event${events.length === 1 ? '' : 's'} after ${waitedSeconds}s: ${summarizeEvents(events)}`
    : `nothing happened in ${waitedSeconds}s${anchored ? ' (anchored at the head of the stream; only new events from here)' : ''}. Call await_events again to keep following.`;

  return {
    text: hasMore ? `${head}\nhasMore: call await_events again at once, the page filled.` : head,
    json: { events, cursor: position, hasMore, waitedSeconds, polls, anchored },
  };
}

function summarizeEvents(events) {
  const counts = new Map();
  for (const e of events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  return [...counts].map(([type, n]) => (n === 1 ? type : `${type} x${n}`)).join(', ');
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Every tool, in the order an agent meets them.
 *
 * `handler` returns `{ text, json, isError? }`; server.mjs turns that into an MCP
 * result. Keeping the handlers free of MCP types is what lets the tests drive them
 * directly against a stub host.
 */
export function toolTable() {
  return [
    {
      name: 'plan_propose',
      title: 'Propose a plan',
      description:
        'Open a Plan Spool from a packet alone (POST /api/plans). The plan lands in `draft`: it is stored and readable, ' +
        'but it is not watchable and nobody has been asked to decide on it yet. Walk it forward with plan_sources → ' +
        'plan_record_start → plan_render → plan_publish → plan_request_decision. The packet is validated by the ' +
        'platform; its required fields are `version`, `kind: "plan"`, `goal`, `outcome`, `approach` and `decision`.\n\n' +
        'ENUMERATE THE OPTIONS YOU CONSIDERED. You almost certainly weighed two or three ways to do this before ' +
        'picking one. Put each of them in `alternatives` as `{ id, summary, tradeoffs: [...] }` and list the ones a ' +
        'reviewer may pick in `decision.options` as `"alternative:<id>"`. The reviewer taps an option to decide, so an ' +
        'alternative you buried in prose is one they cannot choose, and an alternative you describe but leave out of ' +
        '`decision.options` renders as context they cannot pick. `tradeoffs` is what each option COSTS — say it ' +
        'plainly; an option with no stated cost reads as free, which is the one thing no option is. A plan with ' +
        'genuinely no alternative must say why in `noAlternativesReason`: silence there reads as "there was no other ' +
        'way", which is a claim.',
      inputSchema: {
        plan: packet.describe(
          'the plan.json packet, inline. Carry every approach you weighed in `alternatives` ' +
            '({ id, summary, tradeoffs }) and offer the pickable ones in `decision.options` as "alternative:<id>".'
        ),
        evidence: z.array(z.record(z.unknown())).optional().describe('resolved evidence descriptors, if any'),
        identity: z
          .object({
            repoOwner: z.string().optional(),
            repoName: z.string().optional(),
            projectId: z.string().optional(),
          })
          .optional()
          .describe('where this plan belongs, for the repo feed'),
      },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const res = await call(ctx.cfg, { method: 'POST', path: '/api/plans', body: args, signal: ctx.signal });
        if (!res.ok) return refusal('plan_propose', res);
        const d = res.data;
        return {
          text: [
            `plan ${d.spoolId} opened in ${d.status} at revision ${d.revision}.`,
            `watch (once published): ${d.links?.watch}`,
            'next: plan_sources to store the capture, then plan_record_start, plan_render, plan_publish, plan_request_decision.',
          ].join('\n'),
          json: d,
        };
      },
    },

    {
      name: 'plan_read',
      title: 'Read a plan',
      description:
        'The whole state of one plan in one call (GET /api/plans/{spoolId}): status, decision, nextAction, what you ' +
        'may do, the lineage delta, open questions, the newest implementation status, and `blockedBy`. If any comment ' +
        'is unacknowledged the answer LEADS with that, because nothing else you do will be allowed until you ack them. ' +
        'Read `decision` and not just `status`: three verbs land on `approved` and two on `redirected`, so the status ' +
        'alone will not tell you whether to build the headline approach, build a named alternative, or honour a list ' +
        'of conditions. A `parked` plan is on hold — it is not a slow approval, and it is not your cue to start.',
      inputSchema: { spoolId },
      async handler(ctx, args) {
        const res = await call(ctx.cfg, { path: `/api/plans/${encodeURIComponent(args.spoolId)}`, signal: ctx.signal });
        if (!res.ok) return refusal('plan_read', res);
        return frameRead(res.data);
      },
    },

    {
      name: 'gate_check',
      title: 'May I proceed?',
      description:
        'The one question before doing any work on a plan: may I move it forward right now? Derived from the same read ' +
        'payload the platform gates its own routes with — `blockedBy` first, then `nextAction` and `may` — so this can ' +
        'never say "proceed" where a route would answer 409. Returns mayProceed, waiting, and the blocking comments.',
      inputSchema: { spoolId },
      async handler(ctx, args) {
        const res = await call(ctx.cfg, { path: `/api/plans/${encodeURIComponent(args.spoolId)}`, signal: ctx.signal });
        if (!res.ok) return refusal('gate_check', res);
        return frameGate(res.data);
      },
    },

    {
      name: 'await_events',
      title: 'Wait for something to happen',
      description:
        'Block until something happens on any plan you own, then return it (GET /api/events). This is how you learn ' +
        'that a decision was made, a comment was left, a question was answered or a render finished. The cursor is ' +
        'kept on disk, so a restarted server resumes where it left off instead of replaying everything. Delivery is ' +
        'at-least-once: a crash mid-turn replays the last page. Returns as soon as anything lands, or empty at the ' +
        'timeout — an empty answer is normal, just call it again.',
      inputSchema: {
        timeoutSeconds: z
          .number()
          .int()
          .min(0)
          .max(MAX_AWAIT_SECONDS)
          .optional()
          .describe(`total seconds to wait, default ${DEFAULT_AWAIT_SECONDS}, max ${MAX_AWAIT_SECONDS}`),
        planId: z.string().optional().describe('restrict to one plan'),
        limit: z.number().int().min(1).max(500).optional().describe('events per page, default 100'),
        from: z
          .enum(['cursor', 'now', 'beginning'])
          .optional()
          .describe(
            '"cursor" (default) resumes from the stored position, replaying the whole history the first time; ' +
              '"now" anchors at the head and only reports what happens next; "beginning" forgets the cursor and replays everything'
          ),
      },
      handler: awaitEvents,
    },

    {
      name: 'ack_comment',
      title: 'Acknowledge a steer',
      description:
        'Record that you have READ one steer THREAD (POST .../questions/{questionId}/ack). This is the only call that ' +
        'clears a block. It does NOT answer the question — the question stays open and a reply through ' +
        'answer_question is what resolves it. One ack covers the thread through its NEWEST message, so acking once ' +
        'clears a backlog of follow-ups; but a message written after your ack blocks you again and needs its own. ' +
        'Idempotent: acking the same state of a thread twice writes nothing. The answer names what is still blocking, ' +
        'so you never have to guess whether you are clear.',
      inputSchema: {
        spoolId,
        questionId,
        note: z.string().max(2000).optional().describe('what you are going to do about it, for the record'),
      },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const res = await call(ctx.cfg, {
          method: 'POST',
          path: `/api/plans/${encodeURIComponent(args.spoolId)}/questions/${encodeURIComponent(args.questionId)}/ack`,
          body: { note: args.note ?? null },
          signal: ctx.signal,
        });
        if (!res.ok) return refusal('ack_comment', res);
        const left = Array.isArray(res.data.blockedBy) ? res.data.blockedBy : [];
        const head = res.data.replayed ? 'already acknowledged (nothing was written).' : 'acknowledged.';
        if (left.length) {
          return {
            text: `${head}\n${blockedText(args.spoolId, left, { verb: 'move this plan forward yet' })}`,
            json: { blocked: true, blockingCount: left.length, ...res.data },
          };
        }
        return {
          text: `${head} Nothing is blocking this plan now. The question is still OPEN — answer_question is what resolves it.`,
          json: { blocked: false, blockingCount: 0, ...res.data },
        };
      },
    },

    {
      name: 'answer_question',
      title: 'Answer a question',
      description:
        'Reply in a question thread (POST .../questions/{questionId}/replies). Whether the reply ANSWERS the question ' +
        'is decided by the platform, not by you. Answering is never blocked by an unacknowledged comment — blocking it ' +
        'would deadlock the plan. This is also how you reply to a free-form steer: a steer IS a question thread, so ' +
        'the same call continues the conversation.',
      inputSchema: { spoolId, questionId, body: z.string().min(1).max(2000).describe('what you want to say') },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const res = await call(ctx.cfg, {
          method: 'POST',
          path: `/api/plans/${encodeURIComponent(args.spoolId)}/questions/${encodeURIComponent(args.questionId)}/replies`,
          body: { body: args.body },
          signal: ctx.signal,
        });
        if (!res.ok) return refusal('answer_question', res);
        return {
          text: `replied${res.data.answers ? ' — the platform recorded this as answering the question' : ' (the thread stays open)'}.`,
          json: res.data,
        };
      },
    },

    {
      name: 'send_message',
      title: 'Say something to the humans on this plan',
      description:
        'Open a free-form thread on a plan (POST .../questions with a `general` anchor). Use it to raise something ' +
        'nobody has asked you about yet: a blocker, an assumption you had to make, a choice you want a person to ' +
        'make before you go further. `answer_question` is the other half of the same conversation — it replies in a ' +
        'thread that already exists, and this one starts a thread that does not. Pass `questionId` and it delegates ' +
        'to that reply, so a caller who does not know which case it is in can always use this. Not anchored to a ' +
        'moment of the video, so it needs no chapter and no timestamp, and it lands on the current revision ' +
        'whatever that is by the time it arrives.',
      inputSchema: {
        spoolId,
        body: z.string().min(1).max(2000).describe('what you want to say'),
        questionId: z
          .string()
          .optional()
          .describe('continue an existing thread instead of starting one; same as answer_question'),
      },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const id = encodeURIComponent(args.spoolId);
        if (args.questionId) {
          const res = await call(ctx.cfg, {
            method: 'POST',
            path: `/api/plans/${id}/questions/${encodeURIComponent(args.questionId)}/replies`,
            body: { body: args.body },
            signal: ctx.signal,
          });
          if (!res.ok) return refusal('send_message', res);
          return { text: 'sent, in the existing thread.', json: res.data };
        }
        const res = await call(ctx.cfg, {
          method: 'POST',
          path: `/api/plans/${id}/questions`,
          body: { anchor: { type: 'general' }, body: args.body },
          signal: ctx.signal,
        });
        if (!res.ok) return refusal('send_message', res);
        return {
          text: [
            `sent. Thread ${res.data.questionId} is open on this plan.`,
            'Your own message does not block you — only a steer from the other side does. Watch for a reply with await_events.',
          ].join('\n'),
          json: res.data,
        };
      },
    },

    {
      name: 'plan_sources',
      title: 'Store the capture',
      description:
        'Upload the raw capture the platform will render (POST .../sources). The small JSON rides inline; the video ' +
        'and the per-segment wavs come back as scoped 15-minute upload grants you must PUT yourself — this tool ' +
        'returns those grants and does NOT upload the binaries for you. Bring a `planScript` or the plan card layer is ' +
        'dropped silently and the video is quietly an ordinary walkthrough; the answer says `planReady: false` when ' +
        'that happened. This drives no state edge, so re-uploading a better take is free.',
      inputSchema: {
        spoolId,
        timeline: z.unknown().describe('timeline.json — required; it is what the render is built from'),
        render: z.record(z.unknown()).optional(),
        planScript: z.record(z.unknown()).optional().describe('plan.script.json — without it the plan card layer is dropped'),
        format: z.string().optional().describe('"wide" or "vertical" — the canvas the take was captured for; omit and the render.json you upload decides'),
        vo: z.record(z.unknown()).optional(),
        segments: z.array(z.number()).optional(),
        hasVideo: z.boolean().optional(),
        hasBg: z.boolean().optional(),
      },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const { spoolId: id, ...body } = args;
        const res = await call(ctx.cfg, {
          method: 'POST',
          path: `/api/plans/${encodeURIComponent(id)}/sources`,
          body,
          signal: ctx.signal,
        });
        if (!res.ok) return guarded('plan_sources', 'store sources', id, res);
        const uploads = res.data.uploads ?? [];
        return {
          text: [
            `sources stored. planReady: ${res.data.planReady}${res.data.warning ? ` — ${res.data.warning}` : ''}`,
            uploads.length
              ? `${uploads.length} upload grant(s) returned: PUT each one yourself before plan_publish.`
              : 'no binary uploads were granted.',
          ].join('\n'),
          json: res.data,
        };
      },
    },

    {
      name: 'plan_record_start',
      title: 'Start the take',
      description: 'draft → recording (POST .../record/start). Says a take is being made; it stores nothing itself.',
      inputSchema: { spoolId, revisionId, note: z.string().optional() },
      async handler(ctx, args) {
        return lifecycle(ctx, args, 'record/start', 'plan_record_start', 'start recording');
      },
    },

    {
      name: 'plan_render',
      title: 'Render on the platform',
      description:
        'Have the platform build the video (POST .../render). Two kinds, decided by what is really stored rather than ' +
        'by a flag: `render` when a capture is there, `render_packet` when the packet is all there is. The job lands ' +
        '`queued` and the worker is woken; this tool does not wait for it. Poll the job with the `links.job` url in ' +
        'the answer, or watch for a render event with await_events. Counts against your monthly cloud render cap.\n\n' +
        'There is nothing to configure: the canvas, the frame rate, the encode tier, the ambient background and ' +
        'the voice are house defaults the platform picks, so this takes the plan id and nothing else.',
      inputSchema: { spoolId },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const res = await call(ctx.cfg, {
          method: 'POST',
          path: `/api/plans/${encodeURIComponent(args.spoolId)}/render`,
          body: {},
          signal: ctx.signal,
        });
        if (!res.ok) return guarded('plan_render', 'start a render', args.spoolId, res);
        return {
          text: [
            `render job ${res.data.jobId} is ${res.data.status}, kind ${res.data.kind}.`,
            res.data.warning ? `warning: ${res.data.warning}` : null,
            `it is NOT finished: poll ${res.data.links?.job} or wait for it with await_events.`,
          ]
            .filter(Boolean)
            .join('\n'),
          json: res.data,
        };
      },
    },

    {
      name: 'plan_publish',
      title: 'Publish',
      description:
        'Make the plan watchable, or land a revision (POST .../publish). From `recording` this is the draft lane ' +
        'becoming watchable and it REFUSES until the video is really stored. From `revised` it writes revision N+1, ' +
        'supersedes revision N and returns the structural delta — and refuses with `recording_required` if the ' +
        'revision changed what the video argues without naming a new recording.',
      inputSchema: {
        spoolId,
        revisionId,
        parentRevisionId: z.string().optional().describe('required when publishing a revision'),
        plan: packet.optional().describe('the corrected packet, for a text-only revision'),
        evidence: z.array(z.record(z.unknown())).optional(),
        mediaSpoolId: z.string().optional().describe('the recording that argues this revision'),
      },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const { spoolId: id, ...body } = args;
        const res = await call(ctx.cfg, {
          method: 'POST',
          path: `/api/plans/${encodeURIComponent(id)}/publish`,
          body,
          signal: ctx.signal,
        });
        if (!res.ok) return guarded('plan_publish', 'publish', id, res);
        const d = res.data;
        return {
          text: [
            `published: the plan is ${d.status} at revision ${d.revision}${d.replayed ? ' (replayed — this had already happened)' : ''}.`,
            d.delta?.summary ? `delta: ${d.delta.summary}` : null,
            d.status === 'published' ? 'next: plan_request_decision, once the people who should decide have access.' : null,
          ]
            .filter(Boolean)
            .join('\n'),
          json: d,
        };
      },
    },

    {
      name: 'plan_request_decision',
      title: 'Ask for a decision',
      description:
        'published → awaiting_decision (POST .../request-decision). The plan has a working watch link; this is where ' +
        'you ask the people who should decide to decide. Refused while a comment is unacknowledged. Calling it on a ' +
        'plan already awaiting a decision reports `recorded: false`, which is not an error.',
      inputSchema: { spoolId, revisionId, note: z.string().optional(), idempotencyKey },
      async handler(ctx, args) {
        return lifecycle(ctx, args, 'request-decision', 'plan_request_decision', 'ask for a decision');
      },
    },

    {
      name: 'plan_revise',
      title: 'Revise a plan that came back',
      description:
        'A redirect or an unanswered question sends a plan back. Revision is lineage, not overwrite, and it is TWO ' +
        'calls with nothing written between them. `step: "open"` (default) takes revision N as your draft and returns ' +
        'it verbatim with the feedback that sent it back. Edit it, re-record if the change is material, then ' +
        '`step: "publish"` with the corrected packet writes revision N+1. Publishing a material change against the old ' +
        'recording is refused with `recording_required`.',
      inputSchema: {
        spoolId,
        parentRevisionId: z.string().min(1).describe('the revision you are revising'),
        step: z.enum(['open', 'publish']).optional().describe('"open" starts the draft, "publish" lands revision N+1'),
        plan: packet.optional().describe('the corrected packet, for step "publish"'),
        evidence: z.array(z.record(z.unknown())).optional(),
        mediaSpoolId: z.string().optional().describe('a new recording, for a material change'),
      },
      async handler(ctx, args) {
        const missing = await requireToken(ctx);
        if (missing) return missing;
        const id = encodeURIComponent(args.spoolId);
        if ((args.step ?? 'open') === 'publish') {
          const res = await call(ctx.cfg, {
            method: 'POST',
            path: `/api/plans/${id}/publish`,
            body: {
              parentRevisionId: args.parentRevisionId,
              plan: args.plan,
              evidence: args.evidence,
              mediaSpoolId: args.mediaSpoolId,
            },
            signal: ctx.signal,
          });
          if (!res.ok) return guarded('plan_revise (publish)', 'publish a revision', args.spoolId, res);
          return {
            text: `revision ${res.data.revision} published; the plan is ${res.data.status}. ${res.data.delta?.summary ?? ''}`.trim(),
            json: res.data,
          };
        }
        const res = await call(ctx.cfg, {
          method: 'POST',
          path: `/api/plans/${id}/revisions`,
          body: { parentRevisionId: args.parentRevisionId },
          signal: ctx.signal,
        });
        if (!res.ok) return guarded('plan_revise (open)', 'open a revision', args.spoolId, res);
        const d = res.data;
        return {
          text: [
            `revision ${d.nextRevision} is open${d.opened ? '' : ' (it already was)'}; the plan is ${d.status}.`,
            d.feedback ? `it came back as ${d.feedback.action}: ${d.feedback.notes ?? '(no note)'}` : null,
            'the draft below is revision N verbatim. Edit it, then call plan_revise again with step "publish".',
          ]
            .filter(Boolean)
            .join('\n'),
          json: d,
        };
      },
    },

    {
      name: 'implementation_start',
      title: 'Start the approved work',
      description:
        'approved → implementing (POST .../implementation/start). The implementation gate runs in your repo, against ' +
        'spool.config.json; this route is where its verdict lands, so `policy` is the policy that was in force. ' +
        'Refused while a comment is unacknowledged — which is exactly how an approve_with_conditions holds you: its ' +
        'conditions are real steers, and they refuse this call until you have acked every one.',
      inputSchema: {
        spoolId,
        revisionId,
        policy: z.string().min(1).describe('the gate policy in force: off | advisory | required | strict'),
        highRisk: z.boolean().optional(),
        idempotencyKey,
      },
      async handler(ctx, args) {
        return lifecycle(ctx, args, 'implementation/start', 'implementation_start', 'start implementation');
      },
    },

    {
      name: 'proof_submit',
      title: 'Close the loop',
      description:
        'implementing → proved (POST .../implementation/proved). Terminal: a proved plan asks nothing of anybody. ' +
        'This route is for work whose proof is a LINK, so it insists on a summary. If the proof is a recording, ' +
        'publish a proof reply spool instead — that takes the same edge and carries the video and the deviation list. ' +
        'Refused while a comment is unacknowledged.',
      inputSchema: {
        spoolId,
        summary: z.string().min(1).describe('what was built and how it was proved; a plan closed with an empty receipt tells the next reader nothing'),
        revisionId,
        proofSpoolId: z.string().optional(),
        idempotencyKey,
      },
      async handler(ctx, args) {
        return lifecycle(ctx, args, 'implementation/proved', 'proof_submit', 'mark this proved');
      },
    },

    {
      name: 'status_report',
      title: 'Report where the work is',
      description:
        'Scaffold an implementation status spool: a `kind: "status"` reply that says whether the approved work is ' +
        'on plan, changed or blocked. There is no route that posts a status without a recording, because the point of ' +
        'a status is the video that shows it — so this validates the report against the live parent plan and writes ' +
        'reply.json plus a narration skeleton into a workdir. Record it with `spool live <dir>` and publish it with ' +
        '`spool publish <dir>`; the answer names both commands. Refused if the report contradicts itself, or if the ' +
        'plan is not in a state that can take one.',
      inputSchema: {
        parent: z.string().min(1).describe('the parent plan: a spool id, a watch url, or a local workdir'),
        verdict: z.enum(['on_plan', 'changed', 'blocked']).describe('the headline a reviewer reads first'),
        planValid: z.boolean().optional().describe('does the approved plan still hold? default true'),
        reason: z.enum(['milestone', 'blocker', 'decision']).optional().describe('the cadence; defaults from the verdict'),
        completed: z.array(z.string()).optional().describe('approach step ids finished, max 20'),
        changed: z.string().optional().describe('what departs from the approved plan, max 400 chars'),
        blocked: z.string().optional().describe('what stops the work, max 400 chars'),
        next: z.string().optional().describe('what happens next, max 400 chars'),
        summary: z.string().optional(),
        anchors: z.array(z.record(z.unknown())).optional().describe('0-4 anchors into the parent packet'),
        dir: z.string().optional().describe('where to write the workdir; defaults to ./spool/status-<id>'),
        force: z.boolean().optional().describe('overwrite an existing reply.json and steps.mjs'),
      },
      async handler(ctx, args) {
        const { statusScaffold } = await import('./status.mjs');
        return statusScaffold(ctx, args);
      },
    },
  ];
}

/**
 * The lifecycle edges, which all answer the same way.
 *
 * `{ ok, status, revisionId, revision, recorded }` on success — `recorded: false` means
 * the call repeated one that had already taken the edge, which is not an error — and a
 * refusal carrying `reason`, `current` and, on a block, `blockedBy`.
 */
async function lifecycle(ctx, args, path, toolName, verb) {
  const missing = await requireToken(ctx);
  if (missing) return missing;
  const { spoolId: id, ...body } = args;
  const res = await call(ctx.cfg, {
    method: 'POST',
    path: `/api/plans/${encodeURIComponent(id)}/${path}`,
    body,
    signal: ctx.signal,
  });
  if (!res.ok) return guarded(toolName, verb, id, res);
  const d = res.data;
  return {
    text: d.recorded === false
      ? `nothing to do: the plan is already ${d.status} at revision ${d.revision}.`
      : `the plan is now ${d.status} at revision ${d.revision}.`,
    json: d,
  };
}
