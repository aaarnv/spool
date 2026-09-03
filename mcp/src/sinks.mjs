// How an event reaches an agent that is not currently running.
//
// This is the honest limit of MCP: a tool is something a live agent calls, so an MCP
// server cannot wake an idle one. Whatever does the waking has to be outside the
// protocol, and it has to be whatever the harness in front of it understands — a
// Claude Code session, a tmux pane, an HTTP endpoint, a queue. So delivery is a SINK:
// a small interface with one method, and the daemon does not care which one is wired.
//
// Two ship. `command` runs a shell command with the event on stdin and in the
// environment, which is the general answer — anything a harness can be poked with can
// be poked with a command. `notify` puts a macOS notification on screen, which is the
// answer when the human is the one who should react. Both are additive: a watch can run
// several, and an event is delivered only when every sink accepted it.

import { spawn } from 'node:child_process';

/** A sink that accepted an event; anything thrown is a delivery failure. */
const ok = (name, detail) => ({ sink: name, delivered: true, ...detail });

/**
 * Run a shell command per event.
 *
 * The event arrives three ways because harnesses differ: as JSON on stdin, as
 * `$SPOOL_EVENT`, and split into the four fields most commands actually branch on.
 * Failure is a non-zero exit or a timeout, and a failed delivery leaves the cursor
 * where it was, so the event is retried rather than lost.
 */
export function commandSink(command, { shell = process.env.SHELL || '/bin/sh', timeoutMs = 60_000, log } = {}) {
  return {
    name: 'command',
    describe: () => `command: ${command}`,
    async deliver(event, context) {
      const payload = JSON.stringify(event);
      const child = spawn(shell, ['-c', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SPOOL_EVENT: payload,
          SPOOL_EVENT_TYPE: event.type ?? '',
          SPOOL_EVENT_AT: event.at ?? '',
          SPOOL_PLAN_ID: event.planSpoolId ?? '',
          SPOOL_PLAN_URL: context?.host ? `${context.host}/l/${event.planSpoolId}` : '',
        },
      });
      let stderr = '';
      child.stdout.on('data', (b) => log?.(`[wake:command] ${String(b).trimEnd()}`));
      child.stderr.on('data', (b) => {
        stderr += String(b);
        log?.(`[wake:command] ${String(b).trimEnd()}`);
      });
      // A command that never reads stdin — `echo …`, `curl …`, most wake hooks — can exit
      // before this write lands, and an unhandled EPIPE would then throw out of `deliver`.
      // The watch loop reads a throwing sink as a failed delivery and replays the batch,
      // so without this an ordinary wake command wakes the agent again and again for one
      // event. The exit code is what says whether the command worked; a stdin nobody read
      // says nothing.
      child.stdin.on('error', () => {});
      child.stdin.end(`${payload}\n`);

      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error(`the wake command did not finish in ${timeoutMs}ms`));
        }, timeoutMs);
        child.on('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.on('close', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
      });
      if (code !== 0) throw new Error(`the wake command exited ${code}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ''}`);
      return ok('command', { exitCode: code });
    },
  };
}

/** The one-line human summary a notification carries. */
export function eventHeadline(event) {
  const who = event.actor?.kind ? `the ${event.actor.kind}` : 'somebody';
  switch (event.type) {
    case 'plan_decision_submitted':
      return `${who} decided: ${event.payload?.type ?? event.payload?.action ?? 'a decision'}`;
    case 'plan_question_created':
      return `${who} commented — it blocks until you acknowledge it`;
    case 'plan_question_replied':
      return `${who} replied in a question thread`;
    case 'plan_reply_created':
      return `${who} published a reply spool`;
    default:
      return `${event.type}`;
  }
}

/**
 * A macOS notification, for when the human is the one who should react.
 *
 * The fallback rather than the mechanism: a notification cannot resume an agent, it can
 * only tell somebody to. Silently a no-op off macOS, because a watch that died on a
 * Linux box for want of osascript would be worse than one that just does not chime.
 */
export function notifySink({ platform = process.platform, log } = {}) {
  return {
    name: 'notify',
    describe: () => (platform === 'darwin' ? 'notify: macOS notification' : 'notify: (not macOS — no-op)'),
    async deliver(event) {
      if (platform !== 'darwin') return ok('notify', { skipped: 'not macOS' });
      const title = 'Spool';
      const subtitle = event.planSpoolId ?? '';
      const body = eventHeadline(event);
      const escape = (s) => String(s).replace(/["\\]/g, '\\$&');
      const script = `display notification "${escape(body)}" with title "${escape(title)}" subtitle "${escape(subtitle)}"`;
      await new Promise((resolve, reject) => {
        const child = spawn('osascript', ['-e', script], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))));
      });
      log?.(`[wake:notify] ${body}`);
      return ok('notify', {});
    },
  };
}

/** Write the event to a stream. Always on, so a watch is never silent about its work. */
export function logSink(write) {
  return {
    name: 'log',
    describe: () => 'log: stderr',
    async deliver(event) {
      write(`[wake] ${event.at} ${event.type} plan=${event.planSpoolId} — ${eventHeadline(event)}\n`);
      return ok('log', {});
    },
  };
}
