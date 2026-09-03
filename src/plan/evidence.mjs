// Evidence descriptors: the rules that make a reference safe to publish.
//
// A descriptor names evidence; it never carries the source itself. This module
// owns the three things the rest of the packet layer must not duplicate:
//
//   * ref rules per kind   — what a file / url / commit / test ref may look like
//   * redaction            — what must never reach a share bundle
//   * resolution           — the URL a viewer can open, and the degraded state
//                            published when there is none
//
// src/plan/schema.mjs imports the rules, src/plan/plan.mjs imports resolution.
// Nothing here imports back, so this module stays a leaf.
//
// See CONTRACTS.md "Plan Spools" -> "evidence.json".

export const EVIDENCE_KINDS = ['file', 'url', 'image', 'test', 'commit', 'console'];
export const EVIDENCE_VISIBILITIES = ['public', 'private'];

// What a renderer must show. Every published descriptor carries exactly one.
//   available — open item.url, or read item.excerpt
//   unpinned  — show item.ref as text; no immutable URL exists
//   missing   — the ref did not resolve in the repository checkout
//   private   — withheld: label and kind only
export const EVIDENCE_STATUSES = ['available', 'unpinned', 'missing', 'private'];

// An excerpt is a display aid, never the source of truth: bounded so a packet
// cannot quietly become a copy of the repository.
export const EXCERPT_MAX_LINES = 20;
export const EXCERPT_MAX_CHARS = 1200;

// A summary is the plain-language line a reviewer reads BEFORE the excerpt: what
// the source showed, in words, so code and command output stay on demand. One
// sentence, so a card cannot turn into a second excerpt.
export const SUMMARY_MAX_CHARS = 240;

// Caps for a whole bundle, not just one descriptor: a plan that attaches a
// hundred diffs is a repository copy by another route.
export const EVIDENCE_MAX_ITEMS = 40;
export const EVIDENCE_MAX_TOTAL_CHARS = 24000;

export const REDACTED = '[redacted]';

// The ref shapes a JSON Schema `pattern` can carry, so the portable schema in
// src/plan/evidence.schema.json rejects the same obvious mistakes this module
// does. They are strings for that reason. The rules a pattern cannot express
// (URL credentials, private hosts, per-kind messages) stay in checkRef.
export const REF_PATTERNS = {
  commit: '^[0-9a-fA-F]{7,40}$',
  url: '^https?://[^\\s]+$',
  // A repository-relative path: no scheme, no absolute or home prefix, no ".."
  // segment, no backslash, no control character, no leading space.
  path: '^(?![A-Za-z][A-Za-z0-9+.\\-]*:)(?![/~])(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\\\s\\u0000-\\u001f][^\\\\\\u0000-\\u001f]*$',
};

// Control characters, including line breaks: a ref carrying one can smuggle a
// second line into a command, a shell invocation, or a rendered link.
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SHA_RE = new RegExp(REF_PATTERNS.commit);
const URL_SHAPE_RE = new RegExp(REF_PATTERNS.url);
const PATH_RE = new RegExp(REF_PATTERNS.path);
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABS_RE = /^[a-z]:[\\/]/i;
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

// --- redaction -------------------------------------------------------------

// Secret shapes are masked wherever text is published: a label, a ref, an
// excerpt or a URL query value. The list is deliberately shape-based, so an
// unknown provider's token still trips a rule if it looks like a credential.
const SECRET_PATTERNS = [
  // URL userinfo: https://user:token@host/...
  [/(:\/\/)[^/@\s:]+:[^/@\s]+@/g, `$1${REDACTED}@`],
  // an auth scheme and the credential behind it: "Bearer <token>"
  [/\b(bearer|basic|token)\s+(?!\[redacted\])[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // key=value pairs in commands, URLs and paths
  [/\b((?:api[_-]?key|access[_-]?token|auth|authorization|client[_-]?secret|passwd|password|pwd|secret|signature|sig|token)\s*[=:]\s*)(?!\s|\[redacted\])[^\s&"'`;]+/gi, `$1${REDACTED}`],
  // An environment assignment whose NAME says credential, whatever the prefix:
  // a collector reads real command output, where the name is the only signal
  // that FOO_BAR_TOKEN=abcd is not an ordinary setting.
  [/\b([A-Za-z0-9_.-]*(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|ACCESS_KEY)[A-Za-z0-9_.-]*\s*[=:]\s*)(?!\s|\[redacted\])[^\s&"'`;]+/gi, `$1${REDACTED}`],
  // The same names again, with the value merely SEPARATED BY A SPACE — how a CLI
  // takes a flag or a positional argument, and how a config file written in the
  // key-space-value style reads: `aws_secret_access_key wJalrXU…`, `--token ghp_…`.
  // Nothing anchors the value here, so the VALUE has to look like a credential or
  // every sentence that says "token" would lose its next word. Two guards: at least
  // 12 characters of the token alphabet, and at least one digit or symbol among
  // them — which a credential always has and an English word never does.
  [
    /\b((?:api[_-]?key|access[_-]?token|auth|authorization|client[_-]?secret|passwd|password|pwd|secret|signature|sig|token|[A-Za-z0-9_.-]*(?:secret|token|password|passwd|credential|private[_-]?key|api[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)[ \t]+)(?!\[redacted\])(?=[A-Za-z0-9._~+/=-]{12,}(?![A-Za-z0-9._~+/=-]))(?=[A-Za-z._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]+/gi,
    `$1${REDACTED}`,
  ],
  // provider token shapes
  [/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, REDACTED],
  [/\bsk-(?:[A-Za-z0-9-]+-)?[A-Za-z0-9]{16,}/g, REDACTED],
  [/\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g, REDACTED],
  [/\bnpm_[A-Za-z0-9]{30,}/g, REDACTED],
  [/\bAIza[A-Za-z0-9_-]{30,}/g, REDACTED],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED],
  [/\bAKIA[0-9A-Z]{16}\b/g, REDACTED],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // home directories name the machine's user; the path is not evidence anyone
  // else can open, so it leaks an identity for nothing.
  [/(\/(?:Users|home)\/)[^/\s]+/g, `$1${REDACTED}`],
  [/([A-Za-z]:\\Users\\)[^\\\s]+/g, `$1${REDACTED}`],
];

/**
 * Mask secret-shaped substrings.
 * Returns { text, redacted } so a caller can tell a reviewer that something was
 * withheld rather than silently changing what they read.
 */
export function redact(value) {
  if (typeof value !== 'string') return { text: value, redacted: false };
  let text = value;
  for (const [re, replacement] of SECRET_PATTERNS) text = text.replace(re, replacement);
  return { text, redacted: text !== value };
}

/** Bound an excerpt to the published limits. Returns null for empty input. */
export function boundExcerpt(value) {
  if (!isText(value)) return null;
  const lines = String(value).replace(/\s+$/, '').split('\n');
  let truncated = false;
  let out = lines;
  if (out.length > EXCERPT_MAX_LINES) {
    out = out.slice(0, EXCERPT_MAX_LINES);
    truncated = true;
  }
  let text = out.join('\n');
  if (text.length > EXCERPT_MAX_CHARS) {
    text = text.slice(0, EXCERPT_MAX_CHARS);
    truncated = true;
  }
  const masked = redact(text);
  return { text: masked.text, truncated, redacted: masked.redacted };
}

/**
 * Bound an excerpt to its LAST lines instead of its first.
 * Command output puts the answer at the end — the failing assertion, the totals
 * line — so a head-truncated test excerpt would publish the setup and drop the
 * result. Returns the same shape as boundExcerpt.
 */
export function boundExcerptTail(value) {
  if (!isText(value)) return null;
  const lines = String(value).replace(/\s+$/, '').split('\n');
  const kept = lines.slice(-EXCERPT_MAX_LINES);
  const bounded = boundExcerpt(kept.join('\n'));
  if (!bounded) return null;
  return { ...bounded, truncated: bounded.truncated || kept.length < lines.length };
}

/**
 * Bound a plain-language summary to one published line.
 * Line breaks collapse: a summary is read before the excerpt, in a card that
 * gives it one line, so a multi-line value would only push the source further
 * down the page.
 */
export function boundSummary(value) {
  if (!isText(value)) return null;
  const flat = String(value).replace(/\s+/g, ' ').trim();
  const clipped = flat.length > SUMMARY_MAX_CHARS ? `${flat.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…` : flat;
  const masked = redact(clipped);
  return { text: masked.text, truncated: clipped !== flat, redacted: masked.redacted };
}

// --- hosts and refs --------------------------------------------------------

/**
 * True for a host only the author's machine or network can reach.
 * A private host in a share bundle is a dead link for the reviewer and a hint
 * about internal infrastructure for everyone else.
 */
export function isPrivateHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0') return true;
  if (/(^|\.)(local|internal|localdomain|home|lan|corp|intranet|test|invalid|example)$/.test(host)) return true;
  if (!host.includes('.')) return true; // a bare hostname resolves only inside one network
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = v4.slice(1).map(Number);
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  if (/^f[cd][0-9a-f]{2}:/.test(host) || /^fe80:/.test(host)) return true;
  return false;
}

/** Parse an absolute http(s) URL. Returns null for anything else. */
export function parseHttpUrl(value) {
  if (!isText(value) || CONTROL_CHARS.test(value)) return null;
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return url;
}

/**
 * Check a ref against the rules for its kind.
 * Returns { code, message } for a problem, or null when the ref is usable.
 * `code` is one of: invalid-ref, private-ref.
 */
export function checkRef(kind, ref) {
  const bad = (code, message) => ({ code, message });
  if (!isText(ref)) return bad('invalid-ref', 'ref must be a non-empty string');
  if (CONTROL_CHARS.test(ref)) return bad('invalid-ref', 'ref must not contain control characters or line breaks');
  const value = ref.trim();

  if (kind === 'url') {
    const url = URL_SHAPE_RE.test(value) ? parseHttpUrl(value) : null;
    if (!url) return bad('invalid-ref', 'a url ref must be an absolute http(s) URL (other schemes are not published)');
    if (url.username || url.password) return bad('invalid-ref', 'a url ref must not carry credentials; publish the URL without user:password');
    if (isPrivateHost(url.hostname)) {
      return bad('private-ref', `a url ref on a private host (${url.hostname}) is not reachable by a reviewer; set "visibility": "private" to publish it as withheld, or point at a public URL`);
    }
    return null;
  }

  if (kind === 'commit') {
    if (!SHA_RE.test(value)) return bad('invalid-ref', 'a commit ref must be a git SHA (7 to 40 hex characters)');
    return null;
  }

  if (kind === 'file' || kind === 'image') {
    if (SCHEME_RE.test(value)) return bad('invalid-ref', `a ${kind} ref must be a repository-relative path, not a URL (use kind "url" for links)`);
    if (value.startsWith('/') || value.startsWith('~') || WINDOWS_ABS_RE.test(value)) {
      return bad('private-ref', `a ${kind} ref must be repository-relative; an absolute path names the author's machine, not the repository`);
    }
    if (value.includes('\\')) return bad('invalid-ref', `a ${kind} ref must use forward slashes`);
    if (value.split('/').includes('..')) return bad('invalid-ref', `a ${kind} ref must stay inside the repository (no ".." segments)`);
    // Catch-all, so this function and REF_PATTERNS.path cannot disagree.
    if (!PATH_RE.test(value)) return bad('invalid-ref', `a ${kind} ref must be a plain repository-relative path`);
    return null;
  }

  // test | console: the ref is the command that produced the output.
  if (value.includes('\n')) return bad('invalid-ref', `a ${kind} ref must be a single-line command`);
  return null;
}

// --- URL construction ------------------------------------------------------

// owner/repo out of "aaarnv/spool", "https://github.com/aaarnv/spool" or a .git
// clone URL. Anything else is not a GitHub repo we can build permalinks for.
function githubRepo(repo) {
  const m = String(repo || '').match(/^(?:(?:https?:\/\/|git@)github\.com[/:])?([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}

// Encode per path segment: a ref is authored text, so "?", "#" and friends must
// never be able to add a query, a fragment or a new path to the built URL.
const encodePath = (p) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');

/** Copy a URL with secret-shaped query and fragment values masked. */
export function sanitizeHttpUrl(url) {
  const out = new URL(url.toString());
  out.username = '';
  out.password = '';
  for (const key of [...out.searchParams.keys()]) {
    const masked = redact(`${key}=${out.searchParams.get(key)}`);
    if (masked.redacted) out.searchParams.set(key, REDACTED);
  }
  if (out.hash) out.hash = redact(out.hash).text;
  return out.toString();
}

/**
 * The immutable URL a reviewer can open for a descriptor, or null.
 * A URL is only built when it can be pinned: an unpinned blob URL drifts away
 * from what the agent actually looked at, which makes the evidence a lie.
 */
export function evidenceUrl(item, links = {}) {
  const kind = item?.kind;
  const ref = isText(item?.ref) ? item.ref.trim() : '';
  if (!ref) return null;

  if (kind === 'url') {
    const url = parseHttpUrl(ref);
    if (!url || url.username || url.password || isPrivateHost(url.hostname)) return null;
    return sanitizeHttpUrl(url);
  }

  const repo = githubRepo(links.repo);
  if (!repo) return null;
  const base = `https://github.com/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.name)}`;

  if (kind === 'commit') return SHA_RE.test(ref) ? `${base}/commit/${encodeURIComponent(ref)}` : null;
  if (kind !== 'file' && kind !== 'image') return null;
  if (checkRef(kind, ref)) return null;

  const commit = isText(item.revision) ? item.revision.trim() : isText(links.commit) ? links.commit.trim() : '';
  if (!SHA_RE.test(commit)) return null;
  return `${base}/blob/${encodeURIComponent(commit)}${'/' + encodePath(ref)}${lineFragment(item.lines)}`;
}

function lineFragment(lines) {
  if (!Array.isArray(lines) || !Number.isInteger(lines[0]) || lines[0] < 1) return '';
  const start = lines[0];
  const end = Number.isInteger(lines[1]) && lines[1] >= start ? lines[1] : null;
  return end && end !== start ? `#L${start}-L${end}` : `#L${start}`;
}

// --- resolution ------------------------------------------------------------

/**
 * Build the published form of one descriptor.
 *
 * `exists` is true/false when the caller checked the repository checkout, and
 * null when it could not. Unknown never reports "missing": a plan authored
 * outside a checkout would otherwise mark every file as gone.
 *
 * `bundled` is true for a path that lives inside the spool workdir — a keyframe,
 * a captured artifact. Those travel with the share bundle and are never in the
 * repository, so building a repository permalink for one would publish a link
 * that 404s.
 *
 * Never throws. A descriptor that cannot be published becomes a degraded state
 * a renderer can show, which is the whole point: missing or private evidence
 * must read as "withheld", not as a broken page.
 */
export function resolveEvidenceItem(item, { links = {}, exists = null, bundled = false } = {}) {
  const base = {
    id: item?.id ?? null,
    kind: item?.kind ?? null,
    label: redact(item?.label ?? '').text || null,
    chapterIds: Array.isArray(item?.chapterIds) ? [...item.chapterIds] : [],
  };

  const refCheck = checkRef(item?.kind, item?.ref);
  const declaredPrivate = item?.visibility === 'private';
  if (declaredPrivate || refCheck?.code === 'private-ref') {
    return {
      ...base,
      ref: null,
      revision: null,
      url: null,
      summary: null,
      excerpt: null,
      lines: null,
      status: 'private',
      reason: declaredPrivate
        ? 'the author marked this source private, so only its label is published'
        : 'the ref names a private host or an absolute path, so it is withheld',
    };
  }

  const maskedRef = redact(String(item?.ref ?? '').trim());
  const revision = isText(item?.revision) ? item.revision.trim() : isText(links.commit) ? links.commit.trim() : null;
  const summary = boundSummary(item?.summary);
  const excerpt = boundExcerpt(item?.excerpt);
  const url = refCheck || bundled ? null : evidenceUrl(item, links);

  const published = {
    ...base,
    ref: maskedRef.text || null,
    revision,
    url,
    summary,
    excerpt,
    lines: Array.isArray(item?.lines) ? [...item.lines] : null,
  };

  if (exists === false) {
    return {
      ...published,
      url: null,
      status: 'missing',
      reason: 'the ref did not resolve in the repository checkout when this plan was published',
    };
  }
  // A summary counts: the product default is plain language first, so a source
  // a reviewer can read about in words is available to them even when nothing
  // links to it.
  if (url || excerpt || summary) return { ...published, status: 'available', reason: null };
  return { ...published, status: 'unpinned', reason: refCheck ? refCheck.message : unpinnedReason(item?.kind) };
}

// Why a well-formed ref has no URL. A `test` or `console` ref names a command and
// its output, which no repository can address, so blaming a missing repo or
// commit would send the author to fix something that would not help.
function unpinnedReason(kind) {
  if (kind === 'test' || kind === 'console') {
    return `a ${kind} ref names a command and its output, which has no immutable URL — add a summary or an excerpt to publish what it showed`;
  }
  return 'no immutable URL could be built for this ref (the plan has no repo or commit to pin it to)';
}

/**
 * Published form of a whole evidence bundle, in authored order.
 *
 * `resolved` maps an evidence id to what the caller learned about its ref in the
 * checkout: `true`/`false` for found/not found, or `{ exists, bundled }` when the
 * caller also knows the path is a spool artifact rather than a repository file.
 */
export function resolveEvidence(evidence, { links = {}, resolved = null } = {}) {
  const items = Array.isArray(evidence?.items) ? evidence.items : [];
  return items.map((item) => {
    const found = resolved && Object.prototype.hasOwnProperty.call(resolved, item?.id) ? resolved[item.id] : null;
    const fact = typeof found === 'object' && found !== null ? found : { exists: found, bundled: false };
    return resolveEvidenceItem(item, { links, exists: fact.exists ?? null, bundled: Boolean(fact.bundled) });
  });
}
