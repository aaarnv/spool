// One merged pull request, reduced to the facts a recap can be written from.
//
// The recap lane has no repository checkout and no author machine: everything the
// script knows about the change arrives through three GitHub reads (the pull request,
// its files, its commits). So this module is the whole input surface, and its only
// real job is to make that surface BOUNDED — a 400-file refactor and a one-line fix
// have to produce prompts of comparable size, or the authoring stage either truncates
// mid-hunk or costs more than the video is worth.
//
// The caps are per-file first and total second, in that order on purpose. Trimming the
// total alone would spend the whole budget on whichever file GitHub listed first and
// leave the rest of the change invisible; capping each file first means a wide change
// arrives as a wide change. Everything dropped is said out loud in `truncation`, which
// rides into the prompt — a script written from a partial diff must know it is partial.

/** Files carried into the prompt. Past this the change is summarized, not read. */
export const MAX_FILES = 40;
/** Patch bytes kept per file. A hunk longer than this is cut with a marker. */
export const MAX_FILE_BYTES = 6000;
/** Patch bytes kept across all files. */
export const MAX_TOTAL_BYTES = 60_000;
/** Commit subjects carried. They are the author's own summary of their own work. */
export const MAX_COMMITS = 30;
/** Pull request body characters kept. */
export const MAX_BODY_CHARS = 4000;

const str = (v) => (typeof v === 'string' ? v : '');
const int = (v) => (Number.isFinite(v) ? Number(v) : 0);

/** Cut to a byte budget on a line boundary, so a patch never ends mid-hunk. */
function clip(patch, budget) {
  const buf = Buffer.from(patch, 'utf8');
  if (buf.length <= budget) return { text: patch, cut: 0 };
  const kept = buf.subarray(0, budget).toString('utf8');
  const text = kept.slice(0, Math.max(0, kept.lastIndexOf('\n')));
  return { text, cut: buf.length - Buffer.from(text, 'utf8').length };
}

/**
 * Apply the caps to GitHub's file list.
 *
 * Files are taken in GitHub's own order (its diff order), not sorted by size: the
 * order a reviewer sees is the order the change reads in, and re-ranking by line count
 * would put a lockfile ahead of the change it belongs to.
 *
 * Pure — every cap is a test with no network (test/recap-pr.test.mjs).
 */
export function capFiles(rawFiles) {
  const files = [];
  const truncation = [];
  let total = 0;
  let droppedFiles = 0;

  for (const f of rawFiles) {
    const filename = str(f?.filename);
    if (!filename) continue;
    if (files.length >= MAX_FILES) {
      droppedFiles += 1;
      continue;
    }
    const entry = {
      path: filename,
      status: str(f?.status) || 'modified',
      additions: int(f?.additions),
      deletions: int(f?.deletions),
      patch: '',
    };
    const patch = str(f?.patch);
    if (patch) {
      const room = Math.min(MAX_FILE_BYTES, MAX_TOTAL_BYTES - total);
      const { text, cut } = room > 0 ? clip(patch, room) : { text: '', cut: patch.length };
      // A budget too small to hold one whole line buys nothing, and a zero-length patch
      // beside a "900 more bytes" note reads as a bug. Say the diff is not shown.
      if (!text) entry.patchOmitted = true;
      else {
        entry.patch = text;
        total += Buffer.from(text, 'utf8').length;
        if (cut > 0) entry.patchTruncated = cut;
      }
    }
    files.push(entry);
  }

  if (droppedFiles) truncation.push(`${droppedFiles} more changed file(s) are not shown`);
  const shortened = files.filter((f) => f.patchTruncated || f.patchOmitted).length;
  if (shortened) truncation.push(`${shortened} file diff(s) were shortened to fit`);
  return { files, truncation };
}

/**
 * Everything the recap authoring stage reads, fetched with an installation token.
 *
 * `fetchImpl` and `api` exist for the tests; production passes neither. A missing
 * files or commits response is not fatal — a recap written from the title, the body
 * and the file list is thinner but still true, while a failed job produces nothing.
 */
export async function fetchPullRequest({ owner, repo, number, token, fetchImpl = fetch, api = 'https://api.github.com' }) {
  const get = async (path, allowEmpty) => {
    const res = await fetchImpl(`${api}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'spool-recap',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      if (allowEmpty) return null;
      throw new Error(`GitHub GET ${path} failed: ${res.status}`);
    }
    return res.json();
  };

  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`;
  const pr = await get(base, false);
  const [rawFiles, rawCommits] = await Promise.all([
    get(`${base}/files?per_page=100`, true),
    get(`${base}/commits?per_page=100`, true),
  ]);

  const { files, truncation } = capFiles(Array.isArray(rawFiles) ? rawFiles : []);
  const commitList = Array.isArray(rawCommits) ? rawCommits : [];
  const commits = commitList
    .slice(0, MAX_COMMITS)
    .map((c) => str(c?.commit?.message).split('\n')[0].slice(0, 200))
    .filter(Boolean);
  if (commitList.length > MAX_COMMITS) truncation.push(`${commitList.length - MAX_COMMITS} more commit(s) are not shown`);

  const body = str(pr?.body);
  if (body.length > MAX_BODY_CHARS) truncation.push('the pull request description was shortened');

  return {
    repo: `${owner}/${repo}`,
    number: Number(number),
    title: str(pr?.title),
    body: body.slice(0, MAX_BODY_CHARS),
    author: str(pr?.user?.login) || null,
    url: str(pr?.html_url) || `https://github.com/${owner}/${repo}/pull/${number}`,
    baseRef: str(pr?.base?.ref) || null,
    mergeCommitSha: str(pr?.merge_commit_sha) || null,
    mergedAt: str(pr?.merged_at) || null,
    additions: int(pr?.additions),
    deletions: int(pr?.deletions),
    changedFiles: int(pr?.changed_files) || files.length,
    commits,
    files,
    truncation,
  };
}

/** Files carried into the diagram prompt, ranked by churn. */
export const DIAGRAM_FILES = 12;
/** Changed lines kept per file for the diagram prompt. */
export const DIAGRAM_LINES = 24;
/**
 * Characters of trimmed diff the diagram prompt may carry, about 1.2k tokens.
 *
 * Halved from 8000 after aaarnv/spool-web#6: the diagram stage took 861s there, and a
 * bigger diff buys more identifiers to misplace rather than a better picture. The diff
 * stays — a box holding a real identifier is the point — it is just bounded.
 */
export const DIAGRAM_DIFF_CHARS = 4000;

/**
 * The diff as the DIAGRAMMER sees it: changed lines only, biggest files first.
 *
 * The script stage reads the whole capped diff because it is writing prose about the
 * change. The diagram stage needs something different and much smaller — the actual
 * identifiers, values and states it must draw inside its boxes — so context lines,
 * the description and the commit list are all dropped and only `+`/`-` lines and the
 * hunk headers that name the enclosing function survive.
 */
export function renderDiagramDiff(pr, budget = DIAGRAM_DIFF_CHARS) {
  const ranked = (pr.files || [])
    .filter((f) => f.patch)
    .slice()
    .sort((a, b) => (b.additions + b.deletions) - (a.additions + a.deletions))
    .slice(0, DIAGRAM_FILES);

  const blocks = [];
  let used = 0;
  for (const f of ranked) {
    const kept = [];
    for (const line of f.patch.split('\n')) {
      if (/^(\+\+\+ b\/|--- a\/)/.test(line)) continue;
      if (line.startsWith('@@')) {
        const ctx = line.slice(line.lastIndexOf('@@') + 2).trim();
        if (ctx) kept.push(`  in ${ctx}`);
        continue;
      }
      if (line[0] !== '+' && line[0] !== '-') continue;
      kept.push(line.trimEnd().slice(0, 160));
      if (kept.length >= DIAGRAM_LINES) break;
    }
    if (!kept.length) continue;
    const block = [`--- ${f.path} (+${f.additions} -${f.deletions})`, ...kept].join('\n');
    if (used + block.length > budget) break;
    blocks.push(block);
    used += block.length + 2;
  }
  if (!blocks.length) return '';
  return [
    `${pr.repo}#${pr.number}: ${pr.title}`,
    `${pr.changedFiles} file(s), +${pr.additions} -${pr.deletions}`,
    '',
    ...blocks,
  ].join('\n');
}

/** The fetched pull request as the prompt sees it: a diff, not a JSON blob. */
export function renderDiff(pr) {
  const lines = [
    `PULL REQUEST ${pr.repo}#${pr.number}: ${pr.title}`,
    `merged into ${pr.baseRef ?? 'the default branch'} by ${pr.author ?? 'an author'}`,
    `${pr.changedFiles} file(s), +${pr.additions} -${pr.deletions}`,
  ];
  if (pr.body) lines.push('', 'DESCRIPTION:', pr.body);
  if (pr.commits.length) lines.push('', 'COMMITS:', ...pr.commits.map((c) => `- ${c}`));
  lines.push('', 'CHANGED FILES:');
  for (const f of pr.files) {
    lines.push('', `--- ${f.path} (${f.status}, +${f.additions} -${f.deletions})`);
    if (f.patch) lines.push(f.patch);
    if (f.patchTruncated) lines.push(`… ${f.patchTruncated} more bytes of this diff are not shown`);
    if (f.patchOmitted) lines.push('… this file diff is not shown');
  }
  if (pr.truncation.length) {
    lines.push('', 'WHAT YOU ARE NOT SEEING:', ...pr.truncation.map((t) => `- ${t}`));
  }
  return lines.join('\n');
}
