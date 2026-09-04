// Build a project's knowledge base from its repository, with no coding agent in the loop.
//
// `spool init` asks an agent sitting in a checkout to survey the repo and author seed ops.
// The GitHub App has neither the agent nor the checkout, so this stage reads what GitHub
// can serve — the file tree, the README, the docs — and asks the model for the same ops
// the agent would have written. The PROMPT is imported from init.mjs rather than copied:
// two wordings of "what a seed should contain" drift apart, and the CLI path is the one
// that has been calibrated.
//
// What this stage cannot do is the half `spool init` gets for free: it never boots the
// app, so it authors no `set_recording` topics worth trusting. That is stated in the
// prompt below rather than left for the model to discover, and it is why the button and
// `spool init` both stay in the product.
//
// Everything read is BOUNDED, for the reason src/recap/pr.mjs is: a monorepo and a
// one-file library have to produce prompts of comparable size.
import { SEED_INSTRUCTIONS } from './init.mjs';
import { complete, DEFAULT_SCRIPT, resolveKey } from '../packet/author.mjs';

/** Tree entries carried into the prompt. Past this the layout is summarized, not listed. */
export const MAX_PATHS = 2000;
/** Markdown files read from docs/. */
export const MAX_DOCS = 12;
/** Characters kept per document. */
export const MAX_DOC_CHARS = 8000;
/** Characters kept across the README and every doc together. */
export const MAX_TOTAL_CHARS = 60_000;
/** The knowledge route validates against the same cap (web/lib/knowledgeOps.ts OPS_MAX). */
export const MAX_OPS = 20;

const str = (v) => (typeof v === 'string' ? v : '');

/** GitHub reads, all through one token and one shape. `null` on any miss. */
function reader({ owner, repo, token, fetchImpl = fetch, api = 'https://api.github.com' }) {
  const headers = (accept) => ({
    accept,
    authorization: `Bearer ${token}`,
    'user-agent': 'spool-seed',
    'x-github-api-version': '2022-11-28',
  });
  return async (path, { raw = false } = {}) => {
    const res = await fetchImpl(`${api}${path}`, {
      headers: headers(raw ? 'application/vnd.github.raw' : 'application/vnd.github+json'),
    });
    if (!res.ok) return null;
    return raw ? await res.text() : await res.json();
  };
}

/**
 * Everything the model is shown about a repository: its layout and its prose.
 *
 * The tree is read at the default branch, recursively, in one call — GitHub's own
 * `truncated` flag says when it gave up, and that is passed through rather than hidden,
 * because a seed written from half a monorepo should say so.
 */
export async function readRepository({ owner, repo, token, fetchImpl, api, log = () => {} }) {
  const get = reader({ owner, repo, token, fetchImpl, api });
  const meta = await get(`/repos/${owner}/${repo}`);
  if (!meta) throw new Error(`cannot read ${owner}/${repo} with this token`);
  const branch = str(meta.default_branch) || 'main';

  const tree = await get(`/repos/${owner}/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
  const entries = Array.isArray(tree?.tree) ? tree.tree : [];
  const paths = entries.filter((e) => e?.type === 'blob').map((e) => str(e.path)).filter(Boolean);
  const truncated = Boolean(tree?.truncated) || paths.length > MAX_PATHS;

  let budget = MAX_TOTAL_CHARS;
  const clip = (text) => {
    const kept = str(text).slice(0, Math.min(MAX_DOC_CHARS, budget));
    budget -= kept.length;
    return kept;
  };

  const readme = clip(await get(`/repos/${owner}/${repo}/readme`, { raw: true }));
  // Markdown directly under docs/, in tree order. A nested docs tree is a site, and its
  // index pages say less per character than the top level does.
  const docPaths = paths.filter((p) => /^docs\/[^/]+\.mdx?$/i.test(p)).slice(0, MAX_DOCS);
  const docs = [];
  for (const path of docPaths) {
    if (budget <= 0) break;
    const text = clip(await get(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, { raw: true }));
    if (text.trim()) docs.push({ path, text });
  }
  log(`seed: ${owner}/${repo}@${branch} — ${paths.length} path(s), README ${readme ? 'yes' : 'no'}, ${docs.length} doc(s)`);
  return {
    owner, repo, branch,
    description: str(meta.description),
    language: str(meta.language),
    paths: paths.slice(0, MAX_PATHS),
    truncated,
    readme,
    docs,
  };
}

/** The repository, as one prompt. Pure, so the shape is testable without a network. */
export function renderRepository(repository) {
  const lines = [`REPOSITORY: ${repository.owner}/${repository.repo} (default branch ${repository.branch})`];
  if (repository.description) lines.push(`DESCRIPTION: ${repository.description}`);
  if (repository.language) lines.push(`PRIMARY LANGUAGE: ${repository.language}`);
  lines.push('', `FILE TREE (${repository.paths.length} path(s)${repository.truncated ? ', TRUNCATED — the repository is larger than this' : ''}):`);
  lines.push(...repository.paths.map((p) => `- ${p}`));
  if (repository.readme) lines.push('', 'README:', repository.readme);
  for (const doc of repository.docs) lines.push('', `${doc.path.toUpperCase()}:`, doc.text);
  return lines.join('\n');
}

// What the CLI's prompt assumes and this lane cannot deliver, plus the exact JSON shape.
// Said here rather than by editing SEED_INSTRUCTIONS: the CLI path really can boot the app,
// and it hands its prompt to a coding agent that has read the skill doc. A bare model call
// has neither, and without the shape spelled out it answers `{"set_overview": {...}}`.
const NO_CHECKOUT =
  'You are reading this repository through the GitHub API. There is NO checkout and NO running app, so you ' +
  'CANNOT boot anything: author set_recording topics ONLY where the README or docs state the command, port or ' +
  'sign-in shape outright, and omit them entirely rather than guessing. Author from what the tree and the prose ' +
  `actually show, never from what a project of this kind usually has. Return at most ${MAX_OPS} ops, ordered: ` +
  'set_overview first, then set_subsystem, then set_term, then any set_recording.\n\n' +
  'SHAPE: every op is a FLAT object whose "op" field names the operation. The op name is never a key. ' +
  'Exactly these shapes, and no others:\n' +
  '  {"op":"set_overview","text":"..."}\n' +
  '  {"op":"set_subsystem","name":"...","text":"..."}\n' +
  '  {"op":"set_term","term":"...","text":"..."}\n' +
  '  {"op":"set_recording","topic":"...","text":"..."}\n' +
  '  {"op":"add_decision","what":"...","why":"..."}\n' +
  'Return {"ops": [ ... ]} and nothing else.';

async function draft({ repository, model, key, extra = '', log }) {
  const apiKey = await resolveKey(key);
  if (!apiKey) throw new Error('seeding needs OPENAI_API_KEY (env, ./.env, or "openaiKey" in ~/.spool.json)');
  const cfg = model ? { model, effort: null } : DEFAULT_SCRIPT;
  const ops = await complete({
    key: apiKey,
    model: cfg.model,
    effort: cfg.effort,
    system: [SEED_INSTRUCTIONS, NO_CHECKOUT, extra].filter(Boolean).join('\n\n'),
    user: renderRepository(repository),
    envelope: 'ops',
  });
  const kept = ops.slice(0, MAX_OPS);
  log(`seed: authored ${ops.length} op(s) with ${cfg.model}${kept.length < ops.length ? `, kept ${kept.length}` : ''}`);
  return kept;
}

/**
 * Author one repository's seed ops.
 *
 * Returns the raw op array. It is NOT validated here, and no cap is re-stated in the
 * worker: `validateKnowledgeOps` on the web side is the one validator, and a second copy
 * of its numbers would be a second thing to keep in step. `repairSeedOps` is how a draft
 * that busts one gets a second try, with the server's own finding as the instruction —
 * the same draft/lint/repair shape the packet and recap authors use, with the route
 * playing the linter.
 */
export async function authorSeedOps({ repository, model, key, log = console.error } = {}) {
  return draft({ repository, model, key, log });
}

/** Re-author after the knowledge route refused a draft. One finding, one retry. */
export async function repairSeedOps({ repository, finding, model, key, log = console.error } = {}) {
  log(`seed: the knowledge route refused the draft (${finding}) — re-authoring once`);
  return draft({
    repository, model, key, log,
    extra: `Your previous answer was REJECTED by the validator with: "${finding}". Fix exactly that and stay ` +
      'inside every stated limit. Rewrite the offending text to fit rather than cutting it off mid-sentence.',
  });
}

/** Read the repository, then author its seed ops. The whole stage, in one call. */
export async function seedProject({ owner, repo, token, model, key, fetchImpl, api, log } = {}) {
  const repository = await readRepository({ owner, repo, token, fetchImpl, api, log });
  const ops = await authorSeedOps({ repository, model, key, log });
  return { repository, ops };
}
