// `spool reply <parent>` — start a child spool that answers one moment of a plan.
//
// The command does one thing before it writes anything: it reads the parent. A reply
// is only useful if it lands back on the moment it addresses, so the parent's id, its
// active revision, its state and the things it can be anchored to all come from the
// host rather than from what the caller typed. That is also what stops the two
// failures the roadmap names — an orphan reply (no parent) and a cross-plan reply
// (anchors that belong to somebody else's proposal).
//
// See CONTRACTS.md "Replies".

import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { resolveConfig } from '../publish/publish.mjs';
import { formatDiagnostics } from './schema.mjs';
import { PLAN_FILE } from './plan.mjs';
import { REPLY_FILE, REPLY_KINDS, REPLY_KIND_STATES, REPLY_VERSION, checkReplyAnchor, validateReply } from './reply.mjs';
import { PROOF_MODES, proofFromOptions } from './proof.mjs';

// A published watch link (…/l/<id>) or a bare spool id, as opposed to a workdir.
const WATCH_URL = /^https?:\/\/[^\s]+\/l\/([A-Za-z0-9_-]{16,})\/?$/;
const SPOOL_ID = /^[A-Za-z0-9_-]{16,}$/;

/** Which of the three parent forms this is: a watch URL, a spool id, or a workdir. */
export function parseParent(input) {
  const url = String(input || '').match(WATCH_URL);
  if (url) return { id: url[1], host: new URL(input).origin };
  if (SPOOL_ID.test(input) && !existsSync(resolve(input))) return { id: input, host: null };
  return { dir: resolve(input) };
}

// The published id of a workdir, from the receipt `spool publish` left in it.
async function publishedId(dir) {
  const pub = join(dir, 'share', 'published.json');
  if (!existsSync(pub)) return {};
  try {
    const published = JSON.parse(await readFile(pub, 'utf8'));
    return { id: published.id ?? null, host: published.url ? new URL(published.url).origin : null };
  } catch {
    return {};
  }
}

async function getJson(url, token) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
  if (!res.ok) return { ok: false, status: res.status, body: await res.text().catch(() => '') };
  return { ok: true, data: await res.json() };
}

/**
 * Everything a reply is checked against: the parent's identity, its active revision,
 * its state, and the ids a reply may anchor to.
 *
 * The discussion is a narrower read than the plan (`plan.read_questions` is not the
 * unlisted link's reach), so a caller that cannot see the questions gets no question
 * list rather than an empty one — an anchor it cannot verify is left to the server.
 */
export async function readParent(input, { host, token } = {}) {
  const target = parseParent(input);
  let id = target.id ?? null;
  let origin = target.host ?? null;
  if (target.dir) {
    const found = await publishedId(target.dir);
    id = found.id ?? null;
    origin = origin ?? found.host ?? null;
    if (!id) {
      throw new Error(
        `reply: ${target.dir} has not been published, so there is nothing to reply to.\n` +
          '       publish the plan first (`spool publish <dir>`), then reply to its watch link.'
      );
    }
  }
  if (!id) throw new Error(`reply: "${input}" is not a watch link, a spool id, or a published workdir`);

  const cfg = await resolveConfig({ host: host || origin, token });
  const plan = await getJson(`${cfg.host}/api/plans/${id}`, cfg.token);
  if (!plan.ok) {
    if (plan.status === 404) throw new Error(`reply: no plan spool ${id} on ${cfg.host} — a reply needs a published plan parent`);
    throw new Error(`reply: ${cfg.host}/api/plans/${id} returned ${plan.status} ${plan.body}`);
  }

  const questions = await getJson(`${cfg.host}/api/plans/${id}/questions`, cfg.token);
  const live = questions.ok
    ? questions.data.questions.filter((q) => q.status === 'open' || q.status === 'answered')
    : null;

  return {
    host: cfg.host,
    token: cfg.token,
    spoolId: plan.data.spoolId,
    revisionId: plan.data.revisionId,
    revision: plan.data.revision,
    status: plan.data.status,
    goal: plan.data.goal,
    watch: plan.data.links?.watch ?? `${cfg.host}/l/${id}`,
    approach: plan.data.approach ?? [],
    evidence: plan.data.evidence ?? [],
    questions: live,
    questionIds: live ? live.map((q) => q.id) : null,
  };
}

// mm:ss or a bare number of seconds, as a reviewer reads a video clock.
function clock(value, label) {
  const text = String(value).trim();
  const mmss = text.match(/^(\d+):([0-5]?\d(?:\.\d+)?)$/);
  const n = mmss ? Number(mmss[1]) * 60 + Number(mmss[2]) : Number(text);
  if (!Number.isFinite(n) || n < 0) throw new Error(`reply: ${label} must be seconds or mm:ss (got "${value}")`);
  return Math.round(n * 1000) / 1000;
}

/** The anchors the flags asked for, in the order a reader meets them. */
export function anchorsFromOptions(opts) {
  const anchors = [];
  if (opts.question) anchors.push({ type: 'question', questionId: String(opts.question).trim() });
  if (opts.chapter) anchors.push({ type: 'chapter', chapterId: String(opts.chapter).trim() });
  if (opts.approach) anchors.push({ type: 'approach', approachId: String(opts.approach).trim() });
  if (opts.evidence) anchors.push({ type: 'evidence', evidenceId: String(opts.evidence).trim() });
  if (opts.range) {
    const [from, to] = String(opts.range).split(/\s*[-–]\s*|\.\./);
    if (!from || !to) throw new Error('reply: --range must be "start-end", for example 12-24 or 0:12-0:24');
    anchors.push({ type: 'range', start: clock(from, '--range start'), end: clock(to, '--range end') });
  }
  return anchors;
}

/**
 * Scaffold the child workdir: reply.json and nothing else. A reply is a recording,
 * so the rest of the workdir is built by the ordinary commands.
 *
 * A workdir that already holds plan.json is refused: publishing it would open a
 * SECOND plan lifecycle, which is exactly the overwrite that "revision is lineage"
 * exists to prevent. A revision's recording is named through
 * `POST /api/plans/{id}/publish` instead.
 */
export async function writeReply({ workdir, reply, force = false }) {
  const path = join(workdir, REPLY_FILE);
  if (existsSync(path) && !force) throw new Error(`${path} already exists — edit it, or pass --force to overwrite it`);
  if (existsSync(join(workdir, PLAN_FILE))) {
    throw new Error(
      `${workdir} holds ${PLAN_FILE}, so it is a plan of its own, not a reply.\n` +
        '       record the reply in a fresh workdir; a revision names its recording through `POST /api/plans/{id}/publish`.'
    );
  }
  await mkdir(workdir, { recursive: true });
  await writeFile(path, JSON.stringify(reply, null, 2) + '\n');
  return path;
}

/**
 * `spool reply <parent>`. Returns the process exit code: 0 written, 1 refused.
 */
export async function replyCmd(parent, opts = {}) {
  const kind = String(opts.kind || 'answer');
  if (!REPLY_KINDS.includes(kind)) {
    console.error(`[reply] --kind must be one of ${REPLY_KINDS.join(', ')} (got "${kind}")`);
    return 1;
  }
  // A status reply carries a report this command has no flags for, and a status spool
  // with no verdict is the progress video R5.4 exists to remove. One way to record one.
  if (kind === 'status') {
    console.error('[reply] a status reply carries a verdict, so it has its own command: `spool status <parent> --verdict on_plan|changed|blocked`');
    return 1;
  }

  if (opts.mode && !PROOF_MODES.includes(opts.mode)) {
    console.error(`[reply] --mode must be one of ${PROOF_MODES.join(', ')} (got "${opts.mode}")`);
    return 1;
  }

  let facts;
  let anchors;
  let proof = null;
  try {
    facts = await readParent(parent, { host: opts.host, token: opts.token });
    anchors = anchorsFromOptions(opts);
    // The enumeration is built from the parent's OWN approach steps, read a moment ago,
    // so a proof cannot claim a step the plan does not have or quietly skip one it does.
    if (kind === 'proof') proof = proofFromOptions(opts.verifies, opts.deviation, opts, facts);
  } catch (e) {
    console.error(`[reply] ${e.message}`);
    return 1;
  }
  if (kind !== 'proof' && (opts.verifies?.length || opts.deviation?.length || opts.override?.length || opts.mode)) {
    console.error(`[reply] --verifies/--deviation/--override/--mode describe a proof; this is a "${kind}" reply`);
    return 1;
  }

  const slug = `${kind}-${facts.spoolId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, '')}`;

  const descriptor = {
    version: REPLY_VERSION,
    kind: 'reply',
    replyKind: kind,
    parent: {
      spoolId: facts.spoolId,
      revisionId: facts.revisionId,
      revision: facts.revision,
      watch: facts.watch,
    },
    anchors,
    summary: opts.summary ? String(opts.summary).trim() : null,
    ...(proof ? { proof } : {}),
  };

  const report = validateReply(descriptor, facts);
  if (!report.ok) {
    console.error(`[reply] cannot reply to ${facts.watch}:`);
    console.error(formatDiagnostics(report));
    if (report.errors.some((e) => e.code === 'wrong-state')) {
      console.error(
        `[reply] the plan is ${facts.status}; a "${kind}" reply is for a plan that is ${REPLY_KIND_STATES[kind].join(', ')}.`
      );
    }
    return 1;
  }
  if (report.warnings.length) console.error(formatDiagnostics({ warnings: report.warnings }));

  const workdir = opts.dir ? resolve(process.cwd(), opts.dir) : resolve(process.cwd(), 'spool', slug);
  let path;
  try {
    path = await writeReply({ workdir, reply: descriptor, force: opts.force });
  } catch (e) {
    console.error(`[reply] ${e.message}`);
    return 1;
  }

  if (opts.json) {
    console.log(JSON.stringify({ workdir, file: path, reply: descriptor, parent: { status: facts.status, goal: facts.goal } }, null, 2));
    return 0;
  }

  const rel = relative(process.cwd(), workdir) || '.';
  console.log(`Created ${join(rel, REPLY_FILE)} — a ${kind} to plan revision ${facts.revision} (${facts.status})`);
  console.log(`Parent: ${facts.watch}`);
  if (anchors.length) {
    for (const a of anchors) console.log(`About:  ${a.type} ${a.questionId ?? a.chapterId ?? a.approachId ?? a.evidenceId ?? `${a.start}–${a.end}s`}`);
  } else {
    console.log('About:  the plan as a whole (pass --question/--chapter/--approach/--evidence to land on a moment)');
  }
  if (proof) {
    console.log(`Proves: outcome ${proof.outcome.status}, ${proof.approach.map((s) => `${s.id} ${s.status}`).join(', ')}`);
    for (const d of proof.deviations) console.log(`Differs: ${d.from}${d.id ? ` ${d.id}` : ''} — ${d.summary}`);
    if (proof.override) console.log(`Override: ${proof.override.reason}`);
  }
  console.log('Next:');
  console.log(`  1. Record the reply:  spool live ${rel}   (or author ${join(rel, 'steps.mjs')})`);
  console.log(`  2. Publish it:        spool publish ${rel}`);
  console.log('     The reply appears on the parent plan and opens at the moment it addresses.');
  return 0;
}

/** Print the parent's live questions, so an agent can pick a `--question` id. */
export async function listParentQuestions(parent, opts = {}) {
  const facts = await readParent(parent, { host: opts.host, token: opts.token });
  if (!facts.questions) {
    return `plan ${facts.spoolId}: this credential cannot read the discussion (a reply still works; the server checks the anchor).`;
  }
  if (!facts.questions.length) return `plan ${facts.spoolId}: no open questions.`;
  return facts.questions
    .map((q) => `${q.id}  [${q.status}] ${q.anchor?.label ? `(${q.anchor.type} ${q.anchor.label}) ` : ''}${q.body}`)
    .join('\n');
}
