import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";

const run = promisify(execFile);

// gh pr view fields fetched into pr.json (the guide's grounding metadata).
const PR_FIELDS =
  "number,title,body,url,author,baseRefName,headRefName,additions,deletions,changedFiles,files,commits";
const BODY_MAX = 10000;

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

  const rel = `spool/pr-${number}`;
  console.log(
    [
      `Scaffolded ${workdir}`,
      `  pr.json     ${info.changedFiles} file(s), +${info.additions}/-${info.deletions}`,
      `  diff.patch  ${diffOut.length} bytes`,
      `  tour.json   ${stops.length} placeholder stop(s) — author it (see the spool skill)`,
      "",
      "Next:",
      `  1. Author tour.json (reorder narratively, write prose, set mode, delete _instructions).`,
      `  2. spool live ${rel} --url <app-url or file:///abs/explainer.html>   (name each /step after its stop id)`,
      `  3. spool finish ${rel}`,
      `  4. spool publish ${rel} --pr ${number}`,
    ].join("\n")
  );
  return workdir;
}
