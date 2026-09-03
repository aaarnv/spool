// `spool mcp watch` — the half of the story MCP cannot tell.
//
// An MCP tool only runs when an agent calls it, so an agent that has finished its turn
// and gone quiet will never see the comment somebody just left. Something outside the
// protocol has to notice and poke it. That is this daemon: it holds the same events
// cursor the `await_events` tool holds, long-polls forever, and hands anything that
// needs the agent's attention to the configured sinks.
//
// Two properties it is careful about:
//
//   - **The cursor advances after delivery, never before.** A sink that throws leaves
//     the position where it was, so the batch is retried on the next poll. Delivery is
//     therefore at-least-once: a crash between a sink accepting and the write landing
//     replays that batch. A wake delivered twice costs an agent one wasted read; a wake
//     lost costs it the steer it was supposed to stop for.
//   - **The filter is a default, not a vocabulary.** `plan_events` types are an open
//     set, so an unknown type is not an error — it is logged, and `--all` delivers it.

import { call } from './http.mjs';
import * as cursor from './cursor.mjs';
import { POLL_SECONDS } from './tools.mjs';
import { commandSink, logSink, notifySink } from './sinks.mjs';

/**
 * What wakes an agent by default: somebody decided, somebody steered, somebody answered.
 * Everything else is progress the agent caused itself and can read when it next looks.
 */
export const WAKE_TYPES = [
  'plan_decision_submitted',
  'plan_question_created',
  'plan_question_replied',
  'plan_reply_created',
];

/** How long to back off after a poll that failed outright, so a dead host is not hammered. */
const BACKOFF_MS = [1_000, 2_000, 5_000, 15_000, 30_000];

/** Build the sink list a watch was configured with. `log` is always first and always on. */
export function sinksFrom(options, { write, env = process.env } = {}) {
  const sinks = [logSink(write)];
  const command = options.on ?? env.SPOOL_MCP_WAKE_CMD;
  if (command) sinks.push(commandSink(command, { log: (line) => write(`${line}\n`) }));
  if (options.notify || env.SPOOL_MCP_NOTIFY === '1') sinks.push(notifySink({ log: (line) => write(`${line}\n`) }));
  return sinks;
}

/**
 * Follow the stream until stopped.
 *
 * `once` returns after a single poll, which is what the tests drive; everything else
 * runs until the signal aborts. The return value is the batch history, so a caller can
 * assert on what was delivered rather than on what was logged.
 */
export async function watch(ctx, options = {}) {
  const write = options.write ?? ((s) => process.stderr.write(s));
  const sinks = options.sinks ?? sinksFrom(options, { write, env: ctx.env });
  const types = options.all ? null : new Set(options.types?.length ? options.types : WAKE_TYPES);
  const delivered = [];
  let failures = 0;

  let position = await cursor.commit(ctx.cfg, ctx.env);
  const state = await cursor.readState(ctx.cfg, ctx.env);
  if (!position && !state.anchored && options.from !== 'beginning') {
    // A watch started for the first time follows from here. Replaying every event a
    // person ever caused would fire a wake per row of history, which is not a wake.
    const head = await call(ctx.cfg, { path: '/api/events', query: { tail: 1, limit: 1 } });
    if (head.ok) {
      position = head.data.cursor ?? null;
      await cursor.anchor(ctx.cfg, position, ctx.env);
    }
  }

  write(`[watch] ${ctx.cfg.host} — sinks: ${sinks.map((s) => s.describe()).join(' | ')}\n`);
  write(`[watch] waking on: ${types ? [...types].join(', ') : 'every event type'}\n`);

  for (;;) {
    if (options.signal?.aborted) break;

    let page;
    try {
      page = await call(ctx.cfg, {
        path: '/api/events',
        query: { cursor: position ?? undefined, planId: options.planId, limit: options.limit ?? 100, wait: POLL_SECONDS },
        timeoutMs: (POLL_SECONDS + 20) * 1000,
        signal: options.signal,
      });
    } catch (e) {
      if (options.signal?.aborted) break;
      const delay = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)];
      write(`[watch] ${e.message}; retrying in ${delay}ms\n`);
      await sleep(delay, options.signal);
      if (options.once) break;
      continue;
    }

    if (!page.ok) {
      const delay = BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)];
      write(`[watch] the host answered ${page.status}: ${page.data?.error ?? ''}; retrying in ${delay}ms\n`);
      await sleep(delay, options.signal);
      if (options.once) break;
      continue;
    }
    failures = 0;

    const events = page.data.events ?? [];
    const woke = [];
    for (const event of events) {
      if (types && !types.has(event.type)) {
        write(`[watch] skipped ${event.type} (not a wake type)\n`);
        continue;
      }
      // Every sink must accept before the cursor moves; one that throws replays the
      // whole batch, which is the trade at-least-once delivery is made of.
      for (const sink of sinks) await sink.deliver(event, { host: ctx.cfg.host });
      woke.push(event);
    }
    delivered.push(...woke);

    if (page.data.cursor) {
      position = page.data.cursor;
      await cursor.advance(ctx.cfg, position, ctx.env);
    }

    if (options.once) break;
    if (page.data.hasMore) continue;
  }

  return { delivered, cursor: position };
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}
