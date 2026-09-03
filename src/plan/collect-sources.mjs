// Where evidence comes from: git, a test command, and the recording artifacts
// in the workdir.
//
// This module does the I/O and nothing else. It returns plain observations —
// changed files, a commit, a finished test run, parsed console events, keyframe
// paths — and src/plan/collect.mjs turns those into descriptors. The split is
// what lets the adapter rules be tested against adversarial fixtures without a
// repository, a browser or a shell.

import { execFile, spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { repoRoot } from './plan.mjs';

const run = promisify(execFile);

// A patch is bounded again by the adapter; this is only the read budget, so one
// enormous generated file cannot make the collector hold a repository in memory.
const PATCH_READ_MAX = 64 * 1024;
// Kept from the END of a test run: the failing assertion and the totals are there.
const OUTPUT_KEEP_MAX = 256 * 1024;
const TEST_TIMEOUT_MS = 10 * 60 * 1000;

async function git(root, args, { max = 8 * 1024 * 1024 } = {}) {
  try {
    const { stdout } = await run('git', ['-C', root, ...args], { maxBuffer: max });
    return stdout;
  } catch (e) {
    // `git diff --no-index` exits 1 when the files differ, which is exactly the
    // case we ask it about — so output the command produced still counts.
    // Anything else (no repository, unknown ref) degrades to null.
    return e?.stdout ? e.stdout : null;
  }
}

/** Repo-root-relative POSIX path for a file, or null when it escapes the checkout. */
export function repoRelative(root, file) {
  const rel = relative(root, resolve(file));
  if (!rel || rel.startsWith('..') || rel.includes(`..${sep}`)) return null;
  return rel.split(sep).join('/');
}

// --- git --------------------------------------------------------------------

/**
 * The commit the work sits on: SHA, branch and subject.
 * Returns null outside a repository, or on a checkout with no commit yet.
 */
export async function readCommit(cwd = process.cwd()) {
  const root = repoRoot(cwd);
  if (!root) return null;
  const sha = (await git(root, ['rev-parse', 'HEAD']))?.trim();
  if (!sha) return null;
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null;
  const subject = (await git(root, ['log', '-1', '--format=%s']))?.trim() || null;
  return { root, sha, branch: branch === 'HEAD' ? null : branch, subject };
}

/**
 * Changed files with their diffs.
 *
 * With `base`, the range `base...HEAD` — what a pull request shows. Without it,
 * the working tree against HEAD, plus untracked files (diffed against nothing,
 * so a new file still shows the lines it added).
 */
export async function readChangedFiles({ cwd = process.cwd(), base = null, max = 50 } = {}) {
  const root = repoRoot(cwd);
  if (!root) return null;
  const range = base ? [`${base}...HEAD`] : ['HEAD'];

  const named = await git(root, ['diff', '--name-status', ...range]);
  if (named === null) return null;
  const numstat = parseNumstat(await git(root, ['diff', '--numstat', ...range]));

  const files = [];
  for (const line of named.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split('\t');
    const path = paths[paths.length - 1];
    if (!path) continue;
    files.push({ path, status, ...(numstat.get(path) || {}) });
  }

  if (!base) {
    const untracked = (await git(root, ['ls-files', '--others', '--exclude-standard'])) || '';
    for (const path of untracked.split('\n').map((l) => l.trim()).filter(Boolean)) {
      files.push({ path, status: '?', insertions: null, deletions: null });
    }
  }

  // Biggest change first, so the cap below drops the smallest edits rather than the
  // last paths in the alphabet. Untracked files have no line counts yet — their
  // patch is read after the cap — so they are ranked by their size on disk, which
  // is what a brand-new file's change size amounts to.
  for (const file of files) if (file.insertions === null || file.insertions === undefined) file.bytes = fileBytes(root, file.path);
  files.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path));
  const kept = files.slice(0, max);
  for (const file of files) delete file.bytes;
  for (const file of kept) file.patch = await readPatch(root, file, range);
  return { root, files: kept, total: files.length };
}

// One line is about 40 bytes, so a byte count and a line count rank the same set
// the same way. This only ORDERS the cap; nothing published reads it.
const BYTES_PER_LINE = 40;
const rank = (f) =>
  Number.isFinite(f.insertions) || Number.isFinite(f.deletions)
    ? (f.insertions ?? 0) + (f.deletions ?? 0)
    : Math.round((f.bytes ?? 0) / BYTES_PER_LINE);

function fileBytes(root, path) {
  try {
    return statSync(join(root, path)).size;
  } catch {
    // Deleted, or outside the checkout. It ranks last rather than failing the read.
    return 0;
  }
}

function parseNumstat(stdout) {
  const out = new Map();
  for (const line of String(stdout || '').split('\n')) {
    const m = line.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
    if (!m) continue;
    // "-" is git's marker for a binary file: it has no line counts to publish.
    const num = (v) => (v === '-' ? null : Number(v));
    out.set(m[3], { insertions: num(m[1]), deletions: num(m[2]) });
  }
  return out;
}

async function readPatch(root, file, range) {
  const args = file.status === '?'
    ? ['diff', '--no-index', '--no-color', '--', '/dev/null', file.path]
    : ['diff', '--no-color', ...range, '--', file.path];
  const patch = await git(root, args, { max: PATCH_READ_MAX * 4 });
  if (!patch) return null;
  // Drop the "diff --git a/x b/x" header block: it repeats the path the
  // descriptor's ref already carries, and the hunks are what the claim rests on.
  const at = patch.indexOf('\n@@');
  const body = at === -1 ? patch : patch.slice(at + 1);
  return body.slice(0, PATCH_READ_MAX);
}

// --- test runs --------------------------------------------------------------

/**
 * Run a command and report how it went.
 *
 * stdout and stderr are captured together, in order, because a test run's
 * meaning is in that interleaving. Only the last OUTPUT_KEEP_MAX bytes are kept,
 * and the adapter bounds and redacts what is published from them.
 *
 * The command inherits the environment, because tests need it — nothing about
 * that environment is ever published: only this command's own output is, and it
 * is redacted on the way into the descriptor.
 */
export function runTestCommand({ cwd = process.cwd(), command, timeoutMs = TEST_TIMEOUT_MS, onData = null } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn('bash', ['-lc', command], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let timedOut = false;
    const collect = (chunk) => {
      const text = String(chunk);
      if (onData) onData(text);
      output = (output + text).slice(-OUTPUT_KEEP_MAX);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    const finish = (exitCode) => {
      clearTimeout(timer);
      done({ command, exitCode, durationMs: Date.now() - started, output, timedOut });
    };
    child.on('error', (e) => finish(e.code === 'ENOENT' ? 127 : 1));
    child.on('close', (code, signal) => finish(code === null ? (signal ? 137 : 1) : code));
  });
}

// --- recording artifacts ----------------------------------------------------

const readJson = async (path) => {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * The command that produced this workdir's console log.
 * A `console` ref names the command behind the output, so guessing would put a
 * command in the packet that never ran.
 */
export async function recordingCommand(workdir, dirRef) {
  const timeline = await readJson(join(workdir, 'timeline.json'));
  if (timeline?.target === 'os') return `spool live ${dirRef} --target os`;
  const steps = join(workdir, 'steps.mjs');
  if (existsSync(steps)) {
    const headOfFile = (await readFile(steps, 'utf8')).slice(0, 200);
    if (headOfFile.includes('generated by spool live')) return `spool live ${dirRef}`;
  }
  return `spool record ${dirRef}`;
}

/** Parsed console.jsonl events, or null when the workdir has no log. */
export async function readConsoleLog(workdir) {
  const path = join(workdir, 'console.jsonl');
  if (!existsSync(path)) return null;
  const events = [];
  for (const raw of (await readFile(path, 'utf8')).split('\n')) {
    if (!raw.trim()) continue;
    try {
      events.push(JSON.parse(raw));
    } catch {
      // A truncated final line is normal for an interrupted take; skip it.
    }
  }
  return events;
}

const FRAME_RE = /^step_(\d+)\.png$/;

/**
 * Keyframes in the workdir, with the step each one belongs to and the page the
 * recording drove.
 *
 * A live take writes `keyframes/`; a built spool writes `share/frames/`. Both
 * live inside the workdir and ship in the share bundle, which is why the
 * descriptors they become never get a repository permalink.
 */
export async function readKeyframes(workdir) {
  const dir = ['keyframes', join('share', 'frames')].map((d) => join(workdir, d)).find((d) => existsSync(d));
  if (!dir) return null;
  const root = repoRoot(workdir) || workdir;
  const timeline = await readJson(join(workdir, 'timeline.json'));
  const steps = Array.isArray(timeline?.steps) ? timeline.steps : [];

  const frames = [];
  for (const name of (await readdir(dir)).sort()) {
    const m = name.match(FRAME_RE);
    if (!m) continue;
    const step = Number(m[1]);
    const ref = repoRelative(root, join(dir, name));
    if (!ref) continue;
    const meta = steps.find((s) => s?.i === step) || null;
    frames.push({ ref, step, name: meta?.name ?? null, chapterId: meta?.chapterId ?? null });
  }
  return { frames, url: timeline?.url ?? null };
}
