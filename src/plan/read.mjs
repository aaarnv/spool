// `spool read --plan`: the agent-facing side of a Plan Spool. Returns the active
// revision, its decision status, the approved plan content and the next action the
// reader is allowed to take, so a second agent can decide whether it may start work
// without watching the video. See CONTRACTS.md "Agent read payload".

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveConfig } from '../publish/publish.mjs';
import { appendJournal, journalRecord, journalRoot } from '../reliability/journal.mjs';
import { fetchWithRetry } from '../reliability/retry.mjs';
import { classify } from '../reliability/signals.mjs';
import { findPlanPath } from './plan.mjs';
import { statusDigest } from './status.mjs';

// A published watch link (…/l/<id>) or a bare spool id, as opposed to a workdir.
const WATCH_URL = /^https?:\/\/[^\s]+\/l\/([A-Za-z0-9_-]{16,})\/?$/;
const SPOOL_ID = /^[A-Za-z0-9_-]{16,}$/;

/** Bumped only for a breaking change; new fields are additive. Mirrors READ_PAYLOAD_VERSION. */
export const READ_PAYLOAD_VERSION = 1;

export function parseTarget(input) {
  const url = String(input || '').match(WATCH_URL);
  if (url) return { id: url[1], host: new URL(input).origin };
  if (SPOOL_ID.test(input) && !existsSync(resolve(input))) return { id: input, host: null };
  return { dir: resolve(input) };
}

/**
 * Read whatever a local target holds: the packet, the resolved evidence beside it, the
 * publish receipt, and the narration.
 *
 * Both shapes of local target are the same bundle seen from a different directory — a
 * workdir (`plan.json` + `share/`) or the `share/` bundle on its own, which is what an
 * agent gets when a plan travels without its workdir. Resolving the bundle dir from the
 * packet's own path covers both without a second lookup.
 */
async function loadLocal(dir) {
  const planPath = findPlanPath(dir);
  if (!planPath) return null;
  const bundle = basename(dirname(planPath)) === 'share' ? dirname(planPath) : join(dir, 'share');
  const read = async (path) => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch {
      return null; // unreadable sidecar: the packet is still worth returning
    }
  };
  const transcriptPath = join(bundle, 'transcript.txt');
  return {
    plan: JSON.parse(await readFile(planPath, 'utf8')),
    evidence: (await read(join(bundle, 'evidence.json')))?.items ?? null,
    published: await read(join(bundle, 'published.json')),
    transcript: existsSync(transcriptPath) ? transcriptPath : null,
  };
}

const planFields = (plan) => ({
  goal: plan.goal,
  outcome: plan.outcome,
  approach: plan.approach || [],
  risks: plan.risks || [],
  assumptions: plan.assumptions || [],
  alternatives: plan.alternatives || [],
});

/**
 * The offline payload: the same shape the host returns, from the bundle alone.
 *
 * `status` is never invented. An unpublished packet is a `draft` and an unreachable host
 * leaves the status `unknown` — both carry a `nextAction` that refuses implementation,
 * because the one mistake this command must not enable is treating a plan nobody decided
 * on as an approved one.
 */
function localPayload(local, { status = 'draft', spoolId = null, error = null } = {}) {
  const plan = local.plan;
  const next =
    status === 'draft'
      ? {
          action: 'publish_plan',
          endpoint: null,
          reason: 'This plan is not published yet: build and publish it to open a decision.',
        }
      : {
          action: 'none',
          endpoint: null,
          reason: 'The decision status could not be read, so this plan must not be treated as approved.',
        };
  return {
    payloadVersion: READ_PAYLOAD_VERSION,
    spoolId,
    kind: 'plan',
    revision: null,
    revisionId: null,
    status,
    decision: null,
    actor: 'agent',
    nextAction: next,
    // The matrix lives on the host, so a local read cannot enumerate capabilities. Empty
    // means "not evaluated here", and `nextAction` carries the answer that matters.
    may: [],
    ...planFields(plan),
    evidence: local.evidence ?? plan.evidence ?? [],
    // Where the work is (R5.4) lives on the host, like the decision: a bundle is the
    // proposal, not its progress.
    implementation: null,
    openQuestions: [],
    links: { ...(plan.links || {}), watch: local.published?.url ?? null, transcript: local.transcript, proof: null },
    ...(error ? { error } : {}),
  };
}

/**
 * Resolve a plan target (workdir, share bundle, watch URL, or spool id) to the canonical
 * machine payload. Falls back to the local packet when the plan is unpublished, when
 * `--offline` is asked for, or when the host is unreachable — an offline agent still
 * learns the plan, just not its status.
 */
export async function readPlan(input, opts = {}) {
  const target = parseTarget(input);

  let id = target.id ?? null;
  let host = target.host ?? null;
  let local = null;

  if (target.dir) {
    local = await loadLocal(target.dir);
    if (!local) throw new Error(`read --plan: no plan.json in ${target.dir} (run \`spool plan init\` first)`);
    if (local.published) {
      id = local.published.id ?? null;
      if (local.published.url) {
        try {
          host = new URL(local.published.url).origin;
        } catch {
          /* malformed receipt: fall back to the configured host */
        }
      }
    }
  }

  // `--offline` is the bundle's own answer, asked for on purpose: no network, no
  // credentials, no failure mode. It is a refusal to guess, not a degraded read.
  if (opts.offline) {
    if (!local) throw new Error('read --plan --offline: needs a workdir or share/ bundle, not a watch URL or spool id');
    return localPayload(local, id ? { status: 'unknown', spoolId: id, error: 'offline: decision status not read' } : {});
  }

  if (!id) return localPayload(local);

  const cfg = await resolveConfig({ host: opts.host || host, token: opts.token });
  const url = `${cfg.host}/api/plans/${id}`;
  // The token identifies the agent that recorded the plan. Without it the host answers as
  // it would to a link holder — the plan, but no open questions — so an agent reading its
  // own plan would silently miss the work blocking it. An anonymous read still works.
  //
  // It goes out only to the configured host, or to one named on purpose with --host or
  // --token. A watch URL and a share bundle both carry an origin the reader did not
  // choose, and agents read what they are handed, so an unqualified send would let any
  // pasted link collect the credential.
  const configured = await resolveConfig({});
  const trusted = !!opts.token || !!opts.host || cfg.host === configured.host;
  const headers = { accept: 'application/json' };
  if (cfg.token && trusted) headers.authorization = `Bearer ${cfg.token}`;

  // The one read an agent makes before it decides whether it may start work, so it
  // is bounded and retried rather than left to hang on an unresponsive host: a GET
  // is idempotent, and an agent waiting forever is the worst of the failure modes.
  // Every attempt is journalled (roadmap R6.3) because "how often does an agent get
  // the real decision status?" is the reliability number that matters most.
  const startedAt = Date.now();
  // Rooted at the workdir being read when there is one, so a read of a plan in
  // another checkout is journalled in that checkout rather than in this one.
  const startedIn = journalRoot(target.dir || process.cwd());
  const journal = (outcome, { reason = null, attempts = 1, detail = null } = {}) =>
    appendJournal(
      startedIn,
      journalRecord({
        at: new Date(startedAt).toISOString(),
        operation: 'agent_read',
        outcome,
        reason,
        attempts,
        ms: Date.now() - startedAt,
        target: id,
        detail,
      })
    );

  let res;
  let attempts = 1;
  try {
    ({ value: res, attempts } = await fetchWithRetry(url, { headers }, { attempts: 3, timeoutMs: 10_000 }));
  } catch (e) {
    // Two different failures arrive here. A host that never answered throws a network
    // error. A host that kept answering with a retryable status exhausts the retry and
    // carries its last response on the error, and that case must be recorded as what it
    // was — a 500, not a network failure — and must say so to the agent reading it.
    const status = Number(e.value?.status) || null;
    const attempted = e.attempts ?? 3;
    const reason = status ? (status >= 500 ? 'http_5xx' : 'http_4xx') : classify('agent_read', e);
    const why = status
      ? `host answered ${status} on every attempt (${attempted})`
      : `host unreachable: ${e.message}`;
    await journal('failed', { reason, attempts: attempted, detail: why });
    if (local) return localPayload(local, { status: 'unknown', spoolId: id, error: why });
    throw new Error(`read --plan: ${url} failed (${why})`);
  }
  if (res.status === 404) {
    await journal('failed', { reason: 'not_found', attempts });
    if (local) return localPayload(local, { status: 'unknown', spoolId: id, error: 'not a plan spool on this host' });
    throw new Error(`read --plan: no plan spool ${id} on ${cfg.host}`);
  }
  if (!res.ok) {
    await journal('failed', { reason: res.status >= 500 ? 'http_5xx' : 'http_4xx', attempts, detail: `${res.status}` });
    throw new Error(`read --plan: ${url} returned ${res.status} ${await res.text().catch(() => '')}`);
  }
  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    await journal('failed', { reason: 'unreadable', attempts, detail: e.message });
    throw new Error(`read --plan: ${url} returned a body that is not json (${e.message})`);
  }
  await journal(attempts > 1 ? 'retried' : 'ok', { attempts });
  // A local bundle knows where its own narration is; prefer that over a fetch.
  if (local?.transcript) payload.links = { ...(payload.links || {}), transcript: local.transcript };
  return payload;
}

/**
 * The narration, on explicit request only (roadmap R4.1).
 *
 * The default read is a digest plus references, because narration is the one part of a
 * plan an agent already has in structured form — re-reading it as prose costs context and
 * adds nothing. `links.transcript` is a path in a local bundle and a URL on a host.
 */
export async function readTranscript(payload) {
  const ref = payload?.links?.transcript;
  if (!ref) return null;
  if (!/^https?:\/\//.test(ref)) return existsSync(ref) ? await readFile(ref, 'utf8') : null;
  // Unauthenticated on purpose: the hosted transcript is a public blob with the same
  // reach as the watch link, so the credential has no business travelling to it.
  const res = await fetch(ref).catch(() => null);
  return res?.ok ? await res.text() : null;
}

// Human digest: status and next action first, because that is the question an agent is
// asking. Everything below them is the plan it would act on.
export function planDigest(payload) {
  const lines = [];
  const rev = payload.revision ? ` (revision ${payload.revision})` : '';
  lines.push(`plan: ${payload.status}${rev}`);
  if (payload.decision) {
    const { action, at, notes, optionId } = payload.decision;
    lines.push(`decision: ${action}${optionId ? ` → ${optionId}` : ''}${at ? ` at ${at}` : ''}`);
    if (notes) lines.push(`  notes: ${notes}`);
  }
  if (payload.nextAction) {
    const { action, endpoint, reason } = payload.nextAction;
    lines.push(`next: ${action}${endpoint ? ` — ${endpoint.method} ${endpoint.path}` : ''}`);
    if (reason) lines.push(`  ${reason}`);
  }
  // Where the work is (R5.4). It sits with the decision rather than with the plan
  // content: an agent picking a plan up mid-flight asks "was this started, and did it
  // stay on plan?" before it reads a single approach step.
  if (payload.implementation) {
    const s = payload.implementation;
    lines.push(`work: ${statusDigest(s)}`);
    if (s.at) lines.push(`  reported: ${s.at}${s.current === false ? ' (on an earlier revision)' : ''}`);
    if (s.watch) lines.push(`  watch:    ${s.watch}`);
  }
  lines.push('');
  lines.push(`goal:    ${payload.goal}`);
  lines.push(`outcome: ${payload.outcome}`);
  if (payload.approach?.length) {
    lines.push('');
    lines.push('approach:');
    for (const s of payload.approach) lines.push(`  ${s.id}: ${s.summary}`);
  }
  if (payload.risks?.length) {
    lines.push('');
    lines.push('risks:');
    for (const r of payload.risks) lines.push(`  - ${typeof r === 'string' ? r : r.claim}`);
  }
  // Evidence travels by reference: the label, the plain-language line and the ref,
  // never the excerpt. An agent opens the ones it needs.
  if (payload.evidence?.length) {
    lines.push('');
    lines.push('evidence:');
    for (const e of payload.evidence) {
      const state = e.status && e.status !== 'available' ? ` [${e.status}]` : '';
      lines.push(`  ${e.id}: ${e.label ?? e.kind ?? ''}${state}`);
      if (e.summary?.text) lines.push(`    ${e.summary.text}`);
      if (e.ref) lines.push(`    ${e.ref}`);
    }
  }
  // Open questions are work, not trivia: an agent has to answer them before the plan
  // can move, so each one is printed with the moment it is about and where to reply.
  if (payload.openQuestions?.length) {
    lines.push('');
    lines.push(`open questions: ${payload.openQuestions.length}`);
    for (const q of payload.openQuestions) {
      const anchor = q.anchor ? `${q.anchor.type}: ${q.anchor.label}` : 'unanchored';
      lines.push(`  [${anchor}] ${q.body}`);
      if (q.replyTo) lines.push(`    reply: POST ${q.replyTo}`);
    }
  }
  // The far end of the chain (roadmap R5.1). An agent that reads a plan already proved
  // must not implement it again, and the deviations say what the last one actually did.
  if (payload.proofs?.length) {
    lines.push('');
    lines.push(`proofs: ${payload.proofs.length}`);
    for (const p of payload.proofs) {
      lines.push(`  ${p.watch}${p.current ? '' : ' (proves an earlier revision)'}`);
      if (p.headline) lines.push(`    ${p.headline}`);
      if (p.summary) lines.push(`    ${p.summary}`);
      for (const d of p.deviations ?? []) {
        lines.push(`    differs: ${d.from}${d.id ? ` ${d.id}` : ''} — ${d.summary}`);
      }
    }
  }
  const links = payload.links || {};
  const shown = Object.entries(links).filter(([, v]) => v);
  if (shown.length) {
    lines.push('');
    lines.push('links:');
    for (const [k, v] of shown) lines.push(`  ${k}: ${v}`);
  }
  if (payload.error) {
    lines.push('');
    lines.push(`note: ${payload.error}`);
  }
  return lines.join('\n');
}
