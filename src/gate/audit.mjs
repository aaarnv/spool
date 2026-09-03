// The gate's audit trail. Every run that implements without an approved plan is
// recorded — under every policy, including `advisory` (FR-19) — so "who started work
// nobody approved?" is a question with an answer.
//
// Two places, on purpose. The local log is append-only, offline, and works with no
// account: it is the record the machine that ran the command keeps. The plan event is
// the durable one a reviewer can read later, and it is best-effort: a network problem
// must never decide whether an implementation may proceed.

import { randomUUID } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fetchWithRetry } from '../reliability/retry.mjs';

export const AUDIT_DIR = '.spool';
export const AUDIT_FILE = 'audit.jsonl';

/** The one line the local log appends. Bounded, and never the file contents. */
export function auditRecord({ at, outcome, policy, via, risk, plan, command, paths, reason, actor = 'cli' }) {
  return {
    at,
    event: outcome.event,
    decision: outcome.decision,
    policy,
    policyVia: via,
    reasons: outcome.reasons,
    enforced: outcome.enforced,
    bypassed: outcome.bypassed,
    highRisk: Boolean(risk?.highRisk),
    riskWhy: risk?.why || [],
    command: command || null,
    // A count, not the list: the log records that work happened, never what is in it.
    pathCount: paths?.length ?? 0,
    plan: {
      target: plan?.target ?? null,
      spoolId: plan?.spoolId ?? null,
      revisionId: plan?.revisionId ?? null,
      status: plan?.status ?? null,
      revision: plan?.revision ?? null,
      decisionType: plan?.decisionType ?? null,
      watch: plan?.watch ?? null,
    },
    reason: reason || null,
    actor,
  };
}

/** Append one record to `<root>/.spool/audit.jsonl`, creating the directory. */
export async function appendAudit(root, record) {
  const path = join(root, AUDIT_DIR, AUDIT_FILE);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, JSON.stringify(record) + '\n');
  return path;
}

const watchOrigin = (watch) => {
  try {
    return watch ? new URL(watch).origin : null;
  } catch {
    return null;
  }
};

/**
 * Mirror the record onto the plan, as the `implementation_started` event.
 *
 * The event carries the policy, whether it was bypassed, and the plan status the gate
 * saw — never the command, never a path. What a machine is building is not the
 * server's business; that an approval was skipped is.
 *
 * Returns `{ sent, status?, error? }` and never throws: the gate has already decided.
 */
export async function sendPlanEvent(record, { host = null, token = null } = {}) {
  if (!record.plan?.spoolId) return { sent: false, error: 'plan is not published' };
  let cfg;
  try {
    const { resolveConfig } = await import('../publish/publish.mjs');
    // The event belongs to the host that holds the plan, which is the host the watch
    // link names — not whichever host this machine happens to publish to.
    cfg = await resolveConfig({ host: host || watchOrigin(record.plan.watch), token });
  } catch (e) {
    return { sent: false, error: e.message };
  }
  if (!cfg.token) return { sent: false, error: 'no account connected (run `spool login`)' };

  // Two endpoints, because they are two different facts: the approved work started,
  // or work started anyway. Only the first one moves the plan to `implementing`.
  const leg = record.bypassed ? 'bypass' : 'start';
  const url = `${cfg.host}/api/plans/${record.plan.spoolId}/implementation/${leg}`;
  // A bypass always says why. An advisory run has no human reason to give — nobody was
  // asked — so it reports the policy and the gap it proceeded through, which is the
  // truthful answer to "why did this start without an approval?".
  const reason =
    record.reason || (record.bypassed ? `${record.policy} policy: started without an approved plan (${record.reasons.join(', ')})` : null);
  // ONE key for every attempt of this event. The server dedupes on it, so a retry
  // after a dropped response records the same start rather than a second one —
  // regenerating it per attempt is what turns a retry into a double write (R6.3).
  const idempotencyKey = randomUUID();
  const body = JSON.stringify({
    revisionId: record.plan.revisionId,
    policy: record.policy,
    bypassed: record.bypassed,
    reason,
    highRisk: record.highRisk,
    idempotencyKey,
  });
  try {
    const { value: res, attempts } = await fetchWithRetry(
      url,
      { method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' }, body },
      // The gate has already decided; this call only records it. A slow host must
      // never hold up an implementation, so each attempt gets five seconds and there
      // are two of them.
      { attempts: 2, timeoutMs: 5000, baseMs: 300 }
    );
    if (!res.ok) return { sent: false, status: res.status, attempts, error: (await res.text().catch(() => '')).slice(0, 200) };
    return { sent: true, status: res.status, attempts };
  } catch (e) {
    return { sent: false, attempts: e.attempts ?? 1, error: e.message };
  }
}
