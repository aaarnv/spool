// The two things `spool mcp` does: serve the protocol, or watch the stream.
//
// One entry point rather than two binaries, because they are two halves of one story.
// `serve` is what a live agent talks to; `watch` is what pokes an agent that is not
// live. Neither is useful on its own — an agent with only `serve` never hears about the
// comment that blocked it, and a `watch` with nothing to wake is a log file.

import { loadConfig, SERVER_VERSION, stateDir } from './config.mjs';
import { cursorPath, readState, reset } from './cursor.mjs';

/** `spool mcp serve` — stdio MCP. Returns when the client disconnects. */
export async function serveCommand(opts = {}) {
  const { serve } = await import('./server.mjs');
  await serve({ env: process.env });
  // The transport owns the lifetime from here; resolving would end the process.
  await new Promise(() => {});
}

/** `spool mcp watch` — hold the cursor and wake something when an event lands. */
export async function watchCommand(opts = {}) {
  const cfg = await loadConfig({ host: opts.host, token: opts.token });
  if (!cfg.token) {
    console.error('[watch] no spool token: set SPOOL_TOKEN (or SPOOL_PUBLISH_TOKEN), or run `spool login`');
    return 1;
  }
  const { watch } = await import('./watch.mjs');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => controller.abort());

  if (opts.reset) await reset(cfg);
  await watch(
    { cfg: { ...cfg, version: SERVER_VERSION }, env: process.env },
    {
      on: opts.on,
      planId: opts.plan,
      once: !!opts.once,
      signal: controller.signal,
      write: (s) => process.stderr.write(s),
    }
  );
  return 0;
}

/** `spool mcp status` — what this machine remembers, and where it keeps it. */
export async function statusCommand(opts = {}) {
  const cfg = await loadConfig({ host: opts.host, token: opts.token });
  const state = await readState(cfg);
  console.log(
    [
      `host:    ${cfg.host}`,
      `token:   ${cfg.token ? 'set' : 'MISSING — set SPOOL_TOKEN or run `spool login`'}`,
      `state:   ${stateDir()}`,
      `cursor:  ${cursorPath(cfg)}`,
      `         ${state.anchored ? `following since ${state.updatedAt}` : 'never started — the first read replays the whole history'}`,
      `         committed ${state.committed ? `${state.committed.slice(0, 16)}…` : '(none)'}${
        state.pending && state.pending !== state.committed ? `, pending ${state.pending.slice(0, 16)}…` : ''
      }`,
    ].join('\n')
  );
  return 0;
}
