import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveConfig } from "../publish/publish.mjs";

const run = promisify(execFile);

// The knowledge store shape returned when nothing is stored yet or the fetch degrades.
const emptyStore = () => ({ version: 1, overview: null, subsystems: {}, vocabulary: {}, recording: {}, decisions: [] });

// Scaffold the agent authors: durable repo truths this PR changes, not PR narration.
// `_instructions` is ignored at publish (see PR-GUIDE-CONTRACT.md Project knowledge).
const KNOWLEDGE_OPS_SCAFFOLD = {
  _instructions:
    "Record durable truths this PR changes about the repo, not PR narration. knowledge.json shows the current store: UPDATE existing entries rather than duplicating. Ops: set_overview{text<=500}, set_subsystem{name<=80,text<=1000}, remove_subsystem{name}, set_term{term<=60,text<=500}, remove_term{term}, set_recording{topic<=80,text<=1000}, remove_recording{topic}, add_decision{what<=300,why<=500}. recording topics (run, auth, record-tips, gotchas) hold operational memory: how to boot this repo's app, dev-login tricks, pre-warm needs, flaky elements. Server stamps pr+date. Leave ops:[] if nothing durable changed. This _instructions field is ignored at publish.",
  ops: [],
};

// Best-effort read of the project's accumulated knowledge store for this repo. Missing
// config, a slow/absent server, or any non-200 all degrade to the empty store.
async function fetchProjectKnowledge(owner, repo) {
  const { host, token } = await resolveConfig();
  if (!host || !token) return emptyStore();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(
      `${host}/api/projects/knowledge?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
      { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal }
    );
    if (!res.ok) return emptyStore();
    const json = await res.json();
    return json.knowledge ?? emptyStore();
  } catch {
    return emptyStore();
  } finally {
    clearTimeout(timer);
  }
}

// gh pr view fields fetched into pr.json (the guide's grounding metadata).
const PR_FIELDS =
  "number,title,body,url,author,baseRefName,headRefName,additions,deletions,changedFiles,files,commits," +
  "headRefOid,headRepositoryOwner,headRepository,isCrossRepository";
const BODY_MAX = 10000;

// Context-capture caps (see PR-GUIDE-CONTRACT.md context.json).
const CONTEXT_FILE_MAX = 100 * 1024; // per file/doc text
const CONTEXT_ISSUE_BODY_MAX = 5120; // per issue body
const CONTEXT_PACK_MAX = 6 * 1024 * 1024; // running total while assembling
const CONTEXT_MAX_DOCS = 10;
const CONTEXT_MAX_ISSUES = 5;

// gh api exits non-zero with "HTTP 404" on stderr for a missing path (deleted file).
function isNotFound(err) {
  return /HTTP 404|Not Found/i.test(`${err?.stderr || ""}${err?.message || ""}`);
}

/**
 * Best-effort deep context for the guide bundle. Every piece is independently
 * guarded: a failure omits that piece (or marks it), never fails the scaffold.
 * Uses `gh api` raw accept for file bodies (avoids base64 + the 1MB JSON cap).
 */
async function buildContextRaw(info, owner, repo) {
  const sha = info.headRefOid;
  const big = { maxBuffer: 32 * 1024 * 1024 };
  const raw = (p) => run("gh", ["api", p, "-H", "Accept: application/vnd.github.raw+json"], big);
  const json = (p) => run("gh", ["api", p], big);
  const slice = (s) => (s.length > CONTEXT_FILE_MAX ? s.slice(0, CONTEXT_FILE_MAX) : s);
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  let total = 0;

  let readme = null;
  try {
    const { stdout } = await raw(`repos/${owner}/${repo}/readme?ref=${sha}`);
    const text = slice(stdout);
    let path = "README.md";
    try {
      path = (await json(`repos/${owner}/${repo}/readme?ref=${sha}`).then((r) => r.stdout)).trim();
      path = JSON.parse(path).path || "README.md";
    } catch {
      /* keep default path */
    }
    readme = { path, text };
    total += bytes(text);
  } catch {
    readme = null;
  }

  const docs = [];
  try {
    const { stdout } = await json(`repos/${owner}/${repo}/contents/docs?ref=${sha}`);
    const entries = JSON.parse(stdout);
    const mds = (Array.isArray(entries) ? entries : [])
      .filter((e) => e.type === "file" && /\.md$/i.test(e.name))
      .slice(0, CONTEXT_MAX_DOCS);
    for (const e of mds) {
      try {
        const { stdout: txt } = await raw(`repos/${owner}/${repo}/contents/${encodeURI(e.path)}?ref=${sha}`);
        const text = slice(txt);
        if (total + bytes(text) > CONTEXT_PACK_MAX) break;
        total += bytes(text);
        docs.push({ path: e.path, text });
      } catch {
        /* skip this doc */
      }
    }
  } catch {
    /* no docs/ dir */
  }

  const files = {};
  for (const f of info.files || []) {
    const p = f.path;
    try {
      const { stdout: txt } = await raw(`repos/${owner}/${repo}/contents/${encodeURI(p)}?ref=${sha}`);
      const text = slice(txt);
      if (total + bytes(text) > CONTEXT_PACK_MAX) {
        files[p] = { omitted: "too-large" };
        continue;
      }
      total += bytes(text);
      files[p] = { text };
    } catch (err) {
      files[p] = { omitted: isNotFound(err) ? "deleted" : "fetch-failed" };
    }
  }

  const commits = (info.commits || []).map((c) => ({
    sha: c.oid,
    message: c.messageHeadline + (c.messageBody ? "\n\n" + c.messageBody : ""),
  }));

  const issues = [];
  const refText = [info.body || "", ...commits.map((c) => c.message)].join("\n");
  const nums = [...new Set([...refText.matchAll(/(?:^|\s)#(\d+)\b/g)].map((m) => m[1]))].slice(0, CONTEXT_MAX_ISSUES);
  for (const n of nums) {
    try {
      const { stdout } = await json(`repos/${owner}/${repo}/issues/${n}`);
      const issue = JSON.parse(stdout);
      issues.push({ number: issue.number, title: issue.title, body: (issue.body || "").slice(0, CONTEXT_ISSUE_BODY_MAX) });
    } catch {
      /* skip failed issue lookup */
    }
  }

  return {
    version: 1,
    brief: null,
    pr: { owner, repo, headRefOid: sha, isCrossRepository: !!info.isCrossRepository },
    readme,
    docs,
    files,
    related: [],
    commits,
    issues,
  };
}

// The context.md scaffold: a product-brief template the agent authors, then
// removes every TODO line. Its text becomes context.json `brief` at publish.
const CONTEXT_MD_TEMPLATE = [
  "# Product brief (TODO: author this, then remove every TODO line)",
  "TODO: What is this product, in two sentences?",
  "TODO: What does the subsystem this PR touches do, and where does it sit?",
  "TODO: Key vocabulary a reader needs (concepts, not code identifiers).",
  "TODO: How does this change fit the product's direction?",
  "",
].join("\n");

// Parse a PR number or a GitHub PR URL. A URL also yields owner/repo so gh can
// target a repo other than the current directory's default.
function parsePrArg(prArg) {
  const s = String(prArg).trim();
  if (/^\d+$/.test(s)) return { number: s, repo: null };
  const m = s.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (m) return { number: m[2], repo: m[1] };
  throw new Error(`not a PR number or GitHub PR URL: ${prArg}`);
}

// Stable slug used as both the tour stop id and (per the skill) the recorded live
// step name it maps to. Derived from the file path so placeholders are unique.
function slugFromPath(path) {
  return (
    String(path)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "stop"
  );
}

/**
 * Fetch a GitHub PR via gh and scaffold a guide workdir the agent then authors.
 * Writes spool/pr-<n>/{pr.json,diff.patch,tour.json}. Refuses to overwrite an
 * existing tour.json (same guard as `spool init`).
 */
export async function preparePr(prArg, opts = {}) {
  const { number, repo } = parsePrArg(prArg);
  await run("gh", ["--version"]).catch(() => {
    throw new Error("gh CLI not found on PATH — install it and `gh auth login` first");
  });
  const repoArgs = repo ? ["--repo", repo] : [];

  const workdir = resolve(opts.cwd || process.cwd(), "spool", `pr-${number}`);
  const tourPath = join(workdir, "tour.json");
  if (existsSync(tourPath)) {
    console.error(`${tourPath} already exists — not overwriting.`);
    process.exit(1);
  }
  await mkdir(workdir, { recursive: true });

  const { stdout: viewOut } = await run("gh", ["pr", "view", number, ...repoArgs, "--json", PR_FIELDS]);
  const info = JSON.parse(viewOut);
  if (typeof info.body === "string" && info.body.length > BODY_MAX) {
    info.body = info.body.slice(0, BODY_MAX);
    info.bodyTruncated = true;
  }
  await writeFile(join(workdir, "pr.json"), JSON.stringify(info, null, 2) + "\n");

  const { stdout: diffOut } = await run("gh", ["pr", "diff", number, ...repoArgs], { maxBuffer: 64 * 1024 * 1024 });
  await writeFile(join(workdir, "diff.patch"), diffOut);

  // Deep context for the watch-page bundle. Owner/repo come from the PR URL so we
  // target the base repo (fork head commits are reachable there by headRefOid).
  const urlMatch = String(info.url || "").match(/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/);
  const owner = urlMatch ? urlMatch[1] : null;
  const rname = urlMatch ? urlMatch[2] : null;
  let context = null;
  if (owner && rname && info.headRefOid) {
    context = await buildContextRaw(info, owner, rname).catch((e) => {
      console.error(`[pr] context capture failed: ${e.message}`);
      return null;
    });
  }
  if (context) {
    await writeFile(join(workdir, "context.json"), JSON.stringify(context, null, 2) + "\n");
    await writeFile(join(workdir, "context.md"), CONTEXT_MD_TEMPLATE);
  }

  const stops = (info.files || []).map((f) => ({
    id: slugFromPath(f.path),
    heading: "",
    prose: "",
    files: [{ path: f.path }],
  }));
  const tour = {
    version: 1,
    pr: Number(number),
    mode: null,
    _instructions:
      "Author this tour, then delete this _instructions field. Reorder stops into narrative reading " +
      "order (why the change exists, the entrypoint, the core change, the ripples, the tests), not the " +
      "alphabetical or diff order they arrive in. Write why-first prose that guides comprehension; it is " +
      "NOT a code review (no verdicts, no bug hunting). Each stop id doubles as the recorded live step " +
      "name that illustrates it, so keep ids as clean slugs. Set mode to \"walkthrough\" (you recorded " +
      "the running feature) or \"explainer\" (you recorded a self-contained explainer.html).",
    stops,
  };
  await writeFile(tourPath, JSON.stringify(tour, null, 2) + "\n");

  // Cross-PR project knowledge: fetch the accumulated store as a read-only reference for
  // the authoring agent, and scaffold the ops file it writes back. Owner/repo lowercased
  // (GitHub is case-insensitive); a degraded fetch leaves the empty store in front of it.
  const knowledge = await fetchProjectKnowledge(String(owner || "").toLowerCase(), String(rname || "").toLowerCase());
  await writeFile(join(workdir, "knowledge.json"), JSON.stringify(knowledge, null, 2) + "\n");
  await writeFile(join(workdir, "knowledge-ops.json"), JSON.stringify(KNOWLEDGE_OPS_SCAFFOLD, null, 2) + "\n");

  const rel = `spool/pr-${number}`;
  const contextLines = context
    ? [
        `  context.json  ${Object.keys(context.files).length} changed-file(s) captured, readme ${context.readme ? "yes" : "no"}, ${context.docs.length} doc(s), ${context.issues.length} issue(s)`,
        `  context.md    product-brief template — author it`,
      ]
    : [];

  const subsystemCount = Object.keys(knowledge.subsystems || {}).length;
  const termCount = Object.keys(knowledge.vocabulary || {}).length;
  const recordingTopics = Object.keys(knowledge.recording || {});
  const decisionCount = (knowledge.decisions || []).length;
  const knowledgeEmpty =
    !knowledge.overview && subsystemCount === 0 && termCount === 0 && recordingTopics.length === 0 && decisionCount === 0;
  const knowledgeLine = knowledgeEmpty
    ? `  knowledge.json  empty (first guide for this repo)`
    : `  knowledge.json  overview ${knowledge.overview ? "yes" : "no"}, ${subsystemCount} subsystem(s), ${termCount} term(s), ${recordingTopics.length} recording topic(s), ${decisionCount} decision(s)`;

  // Author steps are numbered sequentially; context and knowledge each add one.
  let n = 1;
  const authorSteps = [`  ${n++}. Author tour.json (reorder narratively, write prose, set mode, delete _instructions).`];
  if (context) {
    authorSteps.push(
      `  ${n++}. Author context.md (product brief; remove every TODO line) and curate context.json "related" (files a reader needs beyond the diff).`
    );
  }
  authorSteps.push(
    `  ${n++}. Author knowledge-ops.json: read knowledge.json first, then record durable truths this PR changes about the repo (UPDATE existing entries). Leave ops:[] if nothing durable changed.`
  );
  if (recordingTopics.length) {
    authorSteps.push(`     Read knowledge.json recording topics before recording: ${recordingTopics.join(", ")}`);
  }
  authorSteps.push(`  ${n++}. spool live ${rel} --url <app-url or file:///abs/explainer.html>   (name each /step after its stop id)`);
  authorSteps.push(`  ${n++}. spool finish ${rel}`);
  authorSteps.push(`  ${n++}. spool publish ${rel} --pr ${number}`);

  console.log(
    [
      `Scaffolded ${workdir}`,
      `  pr.json     ${info.changedFiles} file(s), +${info.additions}/-${info.deletions}`,
      `  diff.patch  ${diffOut.length} bytes`,
      `  tour.json   ${stops.length} placeholder stop(s) — author it (see the spool skill)`,
      ...contextLines,
      knowledgeLine,
      "",
      "Next:",
      ...authorSteps,
    ].join("\n")
  );
  return workdir;
}
