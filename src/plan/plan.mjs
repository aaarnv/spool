// Plan Spool packet I/O: read plan.json + evidence.json out of a workdir,
// validate them, and serialize the published copy into the share/ bundle.
// See CONTRACTS.md "Plan Spools".

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { CHAPTER_IDS, PLAN_VERSION, formatDiagnostics, validatePacket } from './schema.mjs';
import { resolveEvidence } from './evidence.mjs';

export const PLAN_FILE = 'plan.json';
export const EVIDENCE_FILE = 'evidence.json';

/** True when the workdir carries a plan packet. Non-plan spools stay untouched. */
export function hasPlan(workdir) {
  return existsSync(join(resolve(workdir), PLAN_FILE));
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

/**
 * The packet a reader should open for `input`: the workdir's own plan.json, or
 * the published copy in a share/ bundle. `spool read` takes either, so both
 * lookups live here rather than in every caller.
 */
export function findPlanPath(input) {
  const d = resolve(input);
  for (const rel of [PLAN_FILE, join('share', PLAN_FILE)]) {
    if (existsSync(join(d, rel))) return join(d, rel);
  }
  return null;
}

/** Parse whichever packet findPlanPath located, or null when there is none. */
export async function loadPlan(input) {
  const path = findPlanPath(input);
  if (!path) return null;
  return { path, plan: await readJson(path) };
}

/**
 * Read and validate the packet in a workdir.
 * Returns { present, ok, plan, evidence, errors, warnings }. A workdir with no
 * plan.json returns { present: false, ok: true } so every caller can gate on it
 * unconditionally.
 */
export async function readPlanPacket(workdir) {
  const dir = resolve(workdir);
  const planPath = join(dir, PLAN_FILE);
  if (!existsSync(planPath)) return { present: false, ok: true, plan: null, evidence: null, errors: [], warnings: [] };

  let plan;
  try {
    plan = await readJson(planPath);
  } catch (e) {
    return {
      present: true,
      ok: false,
      plan: null,
      evidence: null,
      errors: [{ path: PLAN_FILE, code: 'invalid-json', message: `${PLAN_FILE} is not valid JSON: ${e.message}` }],
      warnings: [],
    };
  }

  const evidencePath = join(dir, EVIDENCE_FILE);
  let evidence = null;
  if (existsSync(evidencePath)) {
    try {
      evidence = await readJson(evidencePath);
    } catch (e) {
      return {
        present: true,
        ok: false,
        plan,
        evidence: null,
        errors: [{ path: EVIDENCE_FILE, code: 'invalid-json', message: `${EVIDENCE_FILE} is not valid JSON: ${e.message}` }],
        warnings: [],
      };
    }
  }

  const res = validatePacket({ plan, evidence });
  return { present: true, ok: res.ok, plan, evidence, errors: res.errors, warnings: res.warnings };
}

/**
 * Gate a stage (record, vo, render, share, publish) on a valid packet.
 * Prints an actionable report and returns false when the packet is invalid;
 * returns true for a valid packet AND for a workdir that has no plan at all.
 */
export async function checkPlanGate(workdir, stage) {
  const packet = await readPlanPacket(workdir);
  if (!packet.present) return true;
  if (packet.ok) {
    if (packet.warnings.length) {
      console.error(`[plan] ${packet.warnings.length} warning(s) in ${join(workdir, PLAN_FILE)}:`);
      console.error(formatDiagnostics({ warnings: packet.warnings }));
    }
    return true;
  }
  console.error(`[plan] ${join(workdir, PLAN_FILE)} is invalid — fix it before ${stage}.`);
  console.error(formatDiagnostics(packet));
  console.error(`[plan] ${packet.errors.length} error(s), ${packet.warnings.length} warning(s). Contract: CONTRACTS.md "Plan Spools".`);
  return false;
}

/**
 * Build the published copy of a packet: the plan with its chapters resolved,
 * its risks normalized to claims, and its evidence resolved to published
 * descriptors (redacted, pinned where possible, degraded where not).
 * Pure — deterministic for a given packet, so bundles diff cleanly.
 *
 * `resolved` maps an evidence id to whether its ref was found in the repository
 * checkout; see writeSharePlan.
 */
export function buildSharePlan({ plan, evidence = null, resolved = null }) {
  const links = plan.links || {};
  const chapters = Array.isArray(plan.chapters) && plan.chapters.length
    ? plan.chapters.map((c) => ({ id: c.id, title: c.title ?? null }))
    : CHAPTER_IDS.map((id) => ({ id, title: null }));

  // Risks are authored as strings or as claims; a renderer should not have to
  // branch on that, so the published copy is always claims.
  const risks = (plan.risks || []).map((r) =>
    typeof r === 'string'
      ? { claim: r, evidence: [], chapterId: null }
      : { claim: r.claim, evidence: r.evidence ?? [], chapterId: r.chapterId ?? null }
  );

  return {
    version: PLAN_VERSION,
    kind: 'plan',
    goal: plan.goal,
    outcome: plan.outcome,
    chapters,
    currentState: plan.currentState ?? [],
    approach: plan.approach,
    alternatives: plan.alternatives ?? [],
    ...(plan.alternatives?.length ? {} : { noAlternativesReason: plan.noAlternativesReason }),
    assumptions: plan.assumptions ?? [],
    risks,
    decision: plan.decision,
    links,
    evidence: resolveEvidence(evidence, { links, resolved }),
  };
}

/**
 * The plan block stamped into share/spool.json, and therefore the block the
 * watch page renders. It repeats the published packet's static proposal so a
 * viewer needs one fetch, and points at the files that hold the full copy.
 * The mutable decision status is never stamped here: it lives in the database,
 * so an immutable blob can never contradict it.
 */
export function planSummary(sharePlan, { evidence = false } = {}) {
  return {
    file: PLAN_FILE,
    ...(evidence ? { evidenceFile: EVIDENCE_FILE } : {}),
    version: sharePlan.version,
    goal: sharePlan.goal,
    outcome: sharePlan.outcome,
    chapters: sharePlan.chapters,
    currentState: sharePlan.currentState,
    approach: sharePlan.approach,
    alternatives: sharePlan.alternatives,
    ...(sharePlan.noAlternativesReason ? { noAlternativesReason: sharePlan.noAlternativesReason } : {}),
    assumptions: sharePlan.assumptions,
    risks: sharePlan.risks,
    decision: { type: sharePlan.decision.type, prompt: sharePlan.decision.prompt, options: sharePlan.decision.options },
    evidence: sharePlan.evidence,
    links: sharePlan.links,
  };
}

/**
 * Nearest enclosing git checkout of a workdir, or null.
 * Evidence refs are repository-relative, so this is where they resolve.
 */
export function repoRoot(from) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * Check every file/image ref against the checkout the workdir lives in.
 * Returns { [id]: { exists, bundled } }, or null when there is no checkout to
 * check against: unknown must never be published as "missing".
 *
 * `bundled` marks a ref that resolves inside the spool workdir itself — a
 * keyframe, a captured artifact. Those ship in the share bundle and are not
 * repository files, so a repository permalink for one would 404.
 */
export function resolveRefs(workdir, evidence) {
  const root = repoRoot(workdir);
  const items = (evidence?.items || []).filter((i) => i.kind === 'file' || i.kind === 'image');
  if (!root || items.length === 0) return null;
  const dir = resolve(workdir);
  const out = {};
  for (const item of items) {
    if (item.visibility === 'private' || typeof item.ref !== 'string') continue;
    const target = resolve(root, item.ref.trim());
    const inside = relative(root, target);
    // A ref that escapes the checkout is never "found", whatever is on disk.
    const contained = inside !== '' && !inside.startsWith('..') && !isAbsolute(inside);
    const within = relative(dir, target);
    out[item.id] = {
      exists: contained && existsSync(target),
      bundled: within !== '' && !within.startsWith('..') && !isAbsolute(within),
    };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Write share/plan.json (and share/evidence.json when the workdir has one) for
 * a validated packet. Returns the summary the share bundle's spool.json points
 * at, or null when the workdir carries no plan.
 */
export async function writeSharePlan(workdir, shareDir) {
  const packet = await readPlanPacket(workdir);
  if (!packet.present) return null;
  if (!packet.ok) {
    const detail = formatDiagnostics(packet);
    throw new Error(`share: ${join(workdir, PLAN_FILE)} is invalid, so the published copy would lie:\n${detail}`);
  }
  const resolved = resolveRefs(workdir, packet.evidence);
  const sharePlan = buildSharePlan({ ...packet, resolved });
  await writeFile(join(shareDir, PLAN_FILE), JSON.stringify(sharePlan, null, 2) + '\n');
  if (packet.evidence) {
    // The published bundle carries the RESOLVED descriptors, never the authored
    // file: redaction, withheld private refs and degraded states are applied
    // once, here, so no consumer can read the raw version by mistake.
    const published = { version: PLAN_VERSION, kind: 'evidence', items: sharePlan.evidence };
    await writeFile(join(shareDir, EVIDENCE_FILE), JSON.stringify(published, null, 2) + '\n');
  }
  return planSummary(sharePlan, { evidence: Boolean(packet.evidence) });
}

/** Short human digest of a published plan, for `spool read`. */
export function planDigest(sharePlan) {
  const lines = [];
  lines.push('plan:');
  lines.push(`  goal:     ${sharePlan.goal}`);
  lines.push(`  outcome:  ${sharePlan.outcome}`);
  lines.push('  approach:');
  for (const step of sharePlan.approach || []) lines.push(`    - ${step.id}: ${step.summary}`);
  if (sharePlan.alternatives?.length) {
    lines.push('  alternatives:');
    for (const alt of sharePlan.alternatives) lines.push(`    - ${alt.id}: ${alt.summary}`);
  } else if (sharePlan.noAlternativesReason) {
    lines.push(`  alternatives: none — ${sharePlan.noAlternativesReason}`);
  }
  if (sharePlan.risks?.length) {
    lines.push('  risks:');
    for (const r of sharePlan.risks) lines.push(`    - ${typeof r === 'string' ? r : r.claim}`);
  }
  lines.push(`  decision: [${sharePlan.decision?.type}] ${sharePlan.decision?.prompt}`);
  lines.push(`    options: ${(sharePlan.decision?.options || []).join(', ')}`);
  if (sharePlan.evidence?.length) {
    lines.push('  evidence:');
    // A degraded descriptor prints its state, never a broken link: a reading
    // agent must be able to tell "withheld" from "here it is".
    for (const e of sharePlan.evidence) {
      const body = e.status === 'available' ? (e.url || 'excerpt only') : `${e.status} (${e.reason})`;
      // Plain language first, the link second: the same order a card uses.
      lines.push(`    - ${e.id} (${e.kind}): ${e.summary?.text || body}`);
      if (e.summary?.text && e.status === 'available' && e.url) lines.push(`        ${e.url}`);
    }
  }
  return lines.join('\n');
}
