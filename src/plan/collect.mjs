// Evidence adapters: turn what an agent actually did into descriptors.
//
// An agent that changed files, ran a test and recorded a browser has already
// produced the proof behind its claims. These adapters are what put that proof
// into evidence.json without the agent retyping it — and without any of it
// arriving unredacted or unbounded.
//
// Every function here is PURE: it takes an observation somebody already
// gathered and returns authored descriptors. The gathering (git, a child
// process, the workdir) lives in collect-sources.mjs, so this module can be
// tested against adversarial fixtures with no repository, no browser and no
// network. See CONTRACTS.md "Plan Spools" -> "Evidence adapters".

import {
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_TOTAL_CHARS,
  boundExcerpt,
  boundExcerptTail,
  boundSummary,
  isPrivateHost,
  parseHttpUrl,
  redact,
} from './evidence.mjs';

// Per-collector caps. Bounded by construction: a run that touched 300 files
// attaches the first DIFF_MAX_FILES of them and says so, rather than pasting a
// repository into a review page.
export const DIFF_MAX_FILES = 12;
export const KEYFRAME_MAX = 8;
export const CONSOLE_MAX_EVENTS = 12;

const CONSOLE_ERROR_KINDS = ['pageerror', 'requestfailed'];

// Where each collector's evidence BELONGS in the plan, when the caller does not
// say. A descriptor that names a chapter has declared its place, so a collected
// packet passes `spool plan validate --strict` without forcing the agent to cite
// twelve diffs one at a time. --chapter overrides all of them for a run.
export const COLLECTOR_CHAPTER = {
  diff: 'approach',      // the change itself is the approach, made concrete
  commit: 'context',     // where the work sits today
  test: 'outcome',       // whether the outcome holds
  console: 'risks',      // what went wrong on the page, or did not
  keyframe: 'outcome',   // what the screen looks like after the work
  url: 'context',
};

const anchor = (chapterIds, fallback) => (chapterIds?.length ? chapterIds : [fallback]);

// Published strings, not the {text, truncated} shape: evidence.json holds what an
// author could have typed, and `spool share` bounds it again on the way out.
const line = (v) => boundSummary(v)?.text ?? null;
const head = (v) => boundExcerpt(v)?.text ?? null;
const tail = (v) => boundExcerptTail(v)?.text ?? null;
// One line, no control characters: a ref or a label carrying a newline can
// smuggle a second line into a rendered link or a printed command.
const clean = (v) => redact(String(v ?? '').replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim()).text;

/** A kebab-case id derived from text, unique against ids already taken. */
export function evidenceId(prefix, text, taken = new Set()) {
  const slug = String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(-3)
    .join('-');
  const base = slug ? `${prefix}-${slug}` : prefix;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// --- changed files and diffs ------------------------------------------------

/**
 * One `file` descriptor per changed file, each carrying a bounded excerpt of its
 * own diff.
 *
 * `files` is [{ path, status, insertions, deletions, patch }] as gathered from
 * git. `revision` pins every descriptor to the commit the diff was read at, so
 * the published link shows the reviewer the lines the agent actually changed.
 *
 * Returns { items, total, dropped } — `dropped` is never silent: the caller
 * prints it, because "12 of 300 files" and "12 files" are different claims.
 *
 * The cap keeps the BIGGEST changes, not the first ones alphabetically. A cap that
 * takes files in path order publishes `.github/` and drops `src/` on any change wide
 * enough to hit it — the reviewer then reads twelve descriptors that argue nothing.
 */
export function diffEvidence({ files = [], revision = null, chapterIds = [], max = DIFF_MAX_FILES } = {}) {
  const taken = new Set();
  const kept = [...files]
    .sort((a, b) => changeSize(b) - changeSize(a) || String(a?.path ?? '').localeCompare(String(b?.path ?? '')))
    .slice(0, Math.max(0, max));
  const items = kept.map((file) => {
    const path = clean(file?.path);
    const id = evidenceId('ev-diff', path, taken);
    taken.add(id);
    return descriptor({
      id,
      kind: 'file',
      label: `Diff: ${path}`,
      ref: path,
      revision,
      summary: diffSummary(file, path),
      excerpt: head(file?.patch),
      chapterIds: anchor(chapterIds, COLLECTOR_CHAPTER.diff),
    });
  });
  return { items, total: files.length, dropped: Math.max(0, files.length - kept.length) };
}

/**
 * How much a file changed, for ranking against the cap.
 * git's line counts when it has them; the patch's own changed lines when it does
 * not (a binary file, or an untracked one diffed against nothing). Never negative,
 * so a file with neither still ranks below every file with either.
 */
function changeSize(file) {
  const ins = Number.isFinite(file?.insertions) ? file.insertions : null;
  const del = Number.isFinite(file?.deletions) ? file.deletions : null;
  if (ins !== null || del !== null) return (ins ?? 0) + (del ?? 0);
  const patch = typeof file?.patch === 'string' ? file.patch : '';
  if (!patch) return 0;
  let n = 0;
  for (const line of patch.split('\n')) if (/^[+-]/.test(line) && !/^(\+\+\+|---)/.test(line)) n += 1;
  return n;
}

const DIFF_STATUS = {
  A: 'Added', M: 'Changed', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Retyped', U: 'Unmerged', '?': 'New, untracked',
};

function diffSummary(file, path) {
  const verb = DIFF_STATUS[String(file?.status ?? '').charAt(0).toUpperCase()] || 'Changed';
  const ins = Number.isFinite(file?.insertions) ? file.insertions : null;
  const del = Number.isFinite(file?.deletions) ? file.deletions : null;
  const counts = ins === null && del === null ? '' : ` (+${ins ?? 0} −${del ?? 0})`;
  return line(`${verb} ${path}${counts}.`);
}

// --- commit and branch ------------------------------------------------------

/**
 * The commit the work sits on: one `commit` descriptor, with the branch and the
 * changed-file roll-up as the plain-language line.
 *
 * A branch name is not a ref — branches move — so it is published as text on a
 * descriptor pinned to the SHA, never as the thing a link points at.
 */
export function commitEvidence({ sha, branch = null, subject = null, changedFiles = [], chapterIds = [] } = {}) {
  if (!/^[0-9a-fA-F]{7,40}$/.test(String(sha ?? ''))) return { items: [] };
  const short = String(sha).slice(0, 7);
  const where = branch ? `Branch ${clean(branch)} at ${short}` : `Commit ${short}`;
  const files = changedFiles.length ? ` — ${plural(changedFiles.length, 'changed file')}.` : '.';
  return {
    items: [
      descriptor({
        id: 'ev-commit',
        kind: 'commit',
        label: subject ? `Commit ${short}: ${clean(subject)}` : `Commit ${short}`,
        ref: String(sha),
        revision: String(sha),
        summary: line(`${where}${subject ? `: ${clean(subject)}` : ''}${files}`),
        excerpt: changedFiles.length ? head(changedFiles.map((p) => clean(p)).join('\n')) : null,
        chapterIds: anchor(chapterIds, COLLECTOR_CHAPTER.commit),
      }),
    ],
  };
}

// --- test runs --------------------------------------------------------------

/**
 * One `test` descriptor: the command, whether it passed, how long it took, and a
 * bounded TAIL of its output.
 *
 * The tail, not the head: a test run puts the answer at the end — the failing
 * assertion, the totals line — so head truncation would publish the setup and
 * drop the result the claim rests on.
 */
export function testEvidence({ command, exitCode = null, durationMs = null, output = '', chapterIds = [], id = null } = {}) {
  const cmd = clean(command);
  if (!cmd) return { items: [] };
  const passed = exitCode === 0;
  const verdict = exitCode === null ? 'did not report an exit code' : passed ? `passed (exit 0)` : `failed (exit ${exitCode})`;
  const took = Number.isFinite(durationMs) ? ` in ${(durationMs / 1000).toFixed(1)} s` : '';
  return {
    items: [
      descriptor({
        id: id || evidenceId('ev-test', cmd),
        kind: 'test',
        label: `Test run: ${cmd}`,
        ref: cmd,
        summary: line(`${cmd} ${verdict}${took}.`),
        excerpt: tail(output),
        chapterIds: anchor(chapterIds, COLLECTOR_CHAPTER.test),
      }),
    ],
    passed,
  };
}

// --- browser console --------------------------------------------------------

const isConsoleError = (e) =>
  CONSOLE_ERROR_KINDS.includes(e?.kind) || (e?.kind === 'console' && e?.level === 'error');
const isConsoleWarning = (e) => e?.kind === 'console' && (e?.level === 'warning' || e?.level === 'warn');

/**
 * One `console` descriptor for what the browser reported during the recording.
 *
 * A clean console is evidence too — it is the proof behind "this change breaks
 * nothing on the page" — so the descriptor is emitted either way, with the tally
 * as its plain-language line and the errors themselves as the excerpt.
 */
export function consoleEvidence({ command, events = [], chapterIds = [], max = CONSOLE_MAX_EVENTS } = {}) {
  const cmd = clean(command);
  if (!cmd) return { items: [] };
  const errors = events.filter(isConsoleError);
  const warnings = events.filter(isConsoleWarning);
  const counted = [
    plural(errors.filter((e) => e.kind === 'pageerror').length, 'page error'),
    plural(errors.filter((e) => e.kind === 'requestfailed').length, 'failed request'),
    plural(errors.filter((e) => e.kind === 'console').length, 'console error'),
  ].join(', ');
  const summary = errors.length
    ? `The recording logged ${counted} (${plural(warnings.length, 'warning')}) over ${plural(events.length, 'event')}.`
    : `The recording logged no errors and no failed requests over ${plural(events.length, 'event')} (${plural(warnings.length, 'warning')}).`;

  return {
    items: [
      descriptor({
        id: 'ev-console',
        kind: 'console',
        label: 'Browser console during the recording',
        ref: cmd,
        summary: line(summary),
        // The FIRST errors, not the last: a page error usually causes the ones
        // after it, so the head is where the cause is.
        excerpt: errors.length ? head(errors.slice(0, max).map(consoleLine).join('\n')) : null,
        chapterIds: anchor(chapterIds, COLLECTOR_CHAPTER.console),
      }),
    ],
    errors: errors.length,
    warnings: warnings.length,
  };
}

function consoleLine(e) {
  const t = Number.isFinite(e?.t) ? `[${e.t.toFixed(2)}s] ` : '';
  const kind = e?.kind === 'console' ? `console.${clean(e.level) || 'log'}` : clean(e?.kind);
  return `${t}${kind}: ${clean(e?.text)}`;
}

// --- keyframes and the recorded URL -----------------------------------------

/**
 * `image` descriptors for the keyframes, plus one `url` descriptor for the page
 * the recording drove.
 *
 * A keyframe lives in the spool workdir, which ships in the share bundle and is
 * not a repository file — `resolveRefs` marks it bundled so no repository
 * permalink is invented for it. A dev-server URL is published as a private
 * descriptor: it is real, and a reviewer cannot open it.
 */
export function keyframeEvidence({ frames = [], url = null, chapterIds = [], max = KEYFRAME_MAX } = {}) {
  const taken = new Set();
  // Frames anchored to a chapter carry the plan's claims; they win the budget.
  const ordered = [...frames].sort((a, b) => Number(Boolean(b?.chapterId)) - Number(Boolean(a?.chapterId)));
  const kept = ordered.slice(0, Math.max(0, max)).sort((a, b) => (a?.step ?? 0) - (b?.step ?? 0));
  const items = kept.map((frame) => {
    const ref = clean(frame?.ref);
    const id = evidenceId('ev-frame', ref, taken);
    taken.add(id);
    const name = clean(frame?.name);
    const step = Number.isFinite(frame?.step) ? `Step ${frame.step}` : 'Keyframe';
    return descriptor({
      id,
      kind: 'image',
      label: name ? `${step}: ${name}` : step,
      ref,
      summary: line(`The recorded screen at ${step.toLowerCase()}${name ? `, “${name}”` : ''}.`),
      chapterIds: frame?.chapterId ? [frame.chapterId] : anchor(chapterIds, COLLECTOR_CHAPTER.keyframe),
    });
  });

  const site = urlEvidence({ url, chapterIds });
  return { items: [...items, ...site.items], total: frames.length, dropped: Math.max(0, frames.length - kept.length) };
}

function urlEvidence({ url, chapterIds }) {
  const parsed = parseHttpUrl(url);
  if (!parsed) return { items: [] };
  const priv = isPrivateHost(parsed.hostname);
  return {
    items: [
      descriptor({
        id: 'ev-recorded-url',
        kind: 'url',
        label: priv ? `Recorded against a local server (${parsed.hostname})` : `Recorded page: ${parsed.host}`,
        ref: parsed.toString(),
        // A private host cannot be opened by a reviewer, so the descriptor says
        // so instead of publishing a dead link and a hint about the network.
        ...(priv ? { visibility: 'private' } : { summary: line(`The recording drove ${parsed.toString()}.`) }),
        chapterIds: anchor(chapterIds, COLLECTOR_CHAPTER.url),
      }),
    ],
  };
}

// --- assembly ---------------------------------------------------------------

/** Drop null fields so a collected descriptor reads like a hand-authored one. */
function descriptor(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  return out;
}

/** Published text a descriptor costs against the per-plan budget. */
const weigh = (item) => (item?.summary?.length ?? 0) + (item?.excerpt?.length ?? 0);

/**
 * Merge collected descriptors into an existing bundle.
 *
 * Re-collecting REPLACES a descriptor with the same id in place, so a plan claim
 * that cites `ev-test-npm-test` keeps citing the same run after the test is run
 * again. Nothing is ever removed: a descriptor a claim cites must not vanish
 * because a later collection filled the budget.
 *
 * Returns { evidence, added, replaced, skipped } — `skipped` names the
 * descriptors the per-plan cap refused, so the caller can print them.
 */
export function mergeEvidence(existing, incoming, { maxItems = EVIDENCE_MAX_ITEMS, maxChars = EVIDENCE_MAX_TOTAL_CHARS } = {}) {
  const items = Array.isArray(existing?.items) ? existing.items.map((i) => ({ ...i })) : [];
  const index = new Map(items.map((item, i) => [item?.id, i]));
  let chars = items.reduce((sum, item) => sum + weigh(item), 0);
  const added = [];
  const replaced = [];
  const skipped = [];

  for (const item of incoming) {
    const at = index.get(item.id);
    if (at !== undefined) {
      chars += weigh(item) - weigh(items[at]);
      items[at] = item;
      replaced.push(item.id);
      continue;
    }
    if (items.length >= maxItems) {
      skipped.push({ id: item.id, reason: `the plan already carries ${maxItems} descriptors` });
      continue;
    }
    if (chars + weigh(item) > maxChars) {
      skipped.push({ id: item.id, reason: `the plan's summaries and excerpts would exceed ${maxChars} chars` });
      continue;
    }
    chars += weigh(item);
    index.set(item.id, items.length);
    items.push(item);
    added.push(item.id);
  }

  return {
    evidence: { version: existing?.version ?? 1, kind: 'evidence', items },
    added,
    replaced,
    skipped,
  };
}
