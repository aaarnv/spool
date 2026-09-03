// `status_report` — where the approved work is.
//
// This is the one tool with no route behind it, and the reason is the product rule
// rather than a gap: a status spool is a `kind: "status"` REPLY, and a reply is a
// published child recording (CONTRACTS.md "Implementation status"). There is no way to
// post a status without a video, because the video is the point. So the tool does what
// `spool status` does — read the parent from the host, build the report, refuse one that
// contradicts itself, and scaffold the workdir — and then says which two commands
// finish it.
//
// It calls the CLI's own modules rather than the CLI, because `spool status --json`
// writes to stdout and stdout is this process's JSON-RPC channel.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { formatDiagnostics } from '../../src/plan/schema.mjs';
import { REPLY_FILE, REPLY_KIND_STATES, REPLY_VERSION, validateReply } from '../../src/plan/reply.mjs';
import { readParent, writeReply } from '../../src/plan/reply-cmd.mjs';
import { buildStatusReport, statusDigest, statusHeadline } from '../../src/plan/status.mjs';
import { statusStepsFile } from '../../src/plan/status-template.mjs';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export async function statusScaffold(ctx, args) {
  const report = buildStatusReport({
    verdict: args.verdict,
    planValid: args.planValid !== false,
    reason: args.reason ?? (args.verdict === 'blocked' ? 'blocker' : 'milestone'),
    completed: args.completed ?? [],
    changed: args.changed,
    blocked: args.blocked,
    next: args.next,
  });

  let facts;
  try {
    facts = await readParent(args.parent, { host: ctx.cfg.host, token: ctx.cfg.token });
  } catch (e) {
    return { isError: true, text: `status_report could not read the parent plan: ${e.message}`, json: { error: e.message } };
  }

  const descriptor = {
    version: REPLY_VERSION,
    kind: 'reply',
    replyKind: 'status',
    parent: { spoolId: facts.spoolId, revisionId: facts.revisionId, revision: facts.revision, watch: facts.watch },
    anchors: Array.isArray(args.anchors) ? args.anchors : [],
    summary: args.summary ? String(args.summary).trim() : statusHeadline(report),
    status: report,
  };

  const validated = validateReply(descriptor, facts);
  if (!validated.ok) {
    const wrongState = validated.errors.some((e) => e.code === 'wrong-state');
    return {
      isError: true,
      text: [
        `status_report refused: a status cannot be recorded on ${facts.watch} as it stands.`,
        formatDiagnostics(validated),
        wrongState
          ? `the plan is ${facts.status}; a status reports work the plan approved, so it needs ${REPLY_KIND_STATES.status.join(' or ')}.`
          : null,
      ]
        .filter(Boolean)
        .join('\n'),
      json: { ok: false, errors: validated.errors, warnings: validated.warnings, parent: { status: facts.status } },
    };
  }

  const slug = `status-${facts.spoolId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  if (!args.dir && !SLUG_RE.test(slug)) {
    return { isError: true, text: `status_report could not derive a workdir name from ${facts.spoolId}; pass "dir".`, json: { error: 'bad slug' } };
  }
  const workdir = args.dir ? resolve(process.cwd(), args.dir) : resolve(process.cwd(), 'spool', slug);

  let file;
  let stepsPath = null;
  try {
    file = await writeReply({ workdir, reply: descriptor, force: !!args.force });
    // Never overwrite a narration an agent already authored; --force is the only way.
    const steps = join(workdir, 'steps.mjs');
    if (!existsSync(steps) || args.force) {
      await writeFile(steps, statusStepsFile(report, facts, {}));
      stepsPath = steps;
    }
  } catch (e) {
    return { isError: true, text: `status_report could not write the workdir: ${e.message}`, json: { error: e.message } };
  }

  return {
    text: [
      `status: ${statusDigest(report)}`,
      `plan: ${facts.watch} (revision ${facts.revision}, ${facts.status})`,
      `wrote ${join(workdir, REPLY_FILE)}${stepsPath ? ' and steps.mjs' : ''}`,
      'This is NOT published yet. A status is a recording:',
      `  1. record it:  spool live ${workdir}`,
      `  2. publish it: spool publish ${workdir}`,
      validated.warnings.length ? formatDiagnostics({ warnings: validated.warnings }) : null,
    ]
      .filter(Boolean)
      .join('\n'),
    json: {
      published: false,
      workdir,
      file,
      steps: stepsPath,
      reply: descriptor,
      parent: { spoolId: facts.spoolId, status: facts.status, revision: facts.revision, watch: facts.watch },
      warnings: validated.warnings,
    },
  };
}
