import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { resolveConfig } from "../publish/publish.mjs";
import { fetchProjectKnowledge } from "../pr/pr.mjs";

const run = promisify(execFile);

// Seed-oriented scaffold the agent authors to warm a project's shared knowledge
// before any guide exists. `_instructions` is ignored server-side (never sent).
const SEED_INSTRUCTIONS =
  "Seed this project's shared knowledge so future guides and recordings start warm. Survey the repo " +
  "(README, docs, code layout) and author: one set_overview; set_subsystem for each major module a reader " +
  "needs (5-15); set_term for domain vocabulary; then BOOT THE APP and verify it runs, and record what you " +
  "learned as set_recording topics (run: exact command+port+env needs; auth: dev-login or test-account shape, " +
  "never secret values; record-tips: what flows demo well; gotchas: flaky bits, pre-warm needs). One add_decision " +
  "only if the repo embodies a foundational decision worth recording. Ops: set_overview{text<=500}, " +
  "set_subsystem{name<=80,text<=1000}, remove_subsystem{name}, set_term{term<=60,text<=500}, remove_term{term}, " +
  "set_recording{topic<=80,text<=1000}, remove_recording{topic}, add_decision{what<=300,why<=500}, remove_decision{index}. " +
  "UPDATE existing entries rather than duplicating; knowledge.json shows what is already known. Then run: spool init --apply";

const seedScaffold = () => ({ _instructions: SEED_INSTRUCTIONS, ops: [] });

// Detect the current repo's GitHub owner/name via gh. Owner/name lowercased
// (GitHub is case-insensitive). Any failure → a clear "run inside a repo" error.
async function detectRepo() {
  await run("gh", ["--version"]).catch(() => {
    throw new Error("gh CLI not found on PATH — install it and `gh auth login` first");
  });
  let info;
  try {
    const { stdout } = await run("gh", ["repo", "view", "--json", "owner,name"]);
    info = JSON.parse(stdout);
  } catch {
    throw new Error("run inside a GitHub repo with gh authenticated");
  }
  const owner = String(info?.owner?.login || "").toLowerCase();
  const name = String(info?.name || "").toLowerCase();
  if (!owner || !name) throw new Error("run inside a GitHub repo with gh authenticated");
  return { owner, name };
}

// One-line state of the fetched store, mirroring the `spool pr` scaffold summary.
function knowledgeSummaryLine(knowledge) {
  const subsystemCount = Object.keys(knowledge.subsystems || {}).length;
  const termCount = Object.keys(knowledge.vocabulary || {}).length;
  const recordingTopics = Object.keys(knowledge.recording || {});
  const decisionCount = (knowledge.decisions || []).length;
  const empty =
    !knowledge.overview && subsystemCount === 0 && termCount === 0 && recordingTopics.length === 0 && decisionCount === 0;
  return empty
    ? `  knowledge.json  empty (nothing seeded yet)`
    : `  knowledge.json  overview ${knowledge.overview ? "yes" : "no"}, ${subsystemCount} subsystem(s), ${termCount} term(s), ${recordingTopics.length} recording topic(s), ${decisionCount} decision(s)`;
}

// Bare `spool init`: scaffold spool/project/ (no --apply) or POST the authored seed
// ops to the project knowledge store (--apply). Slugged `init <slug>` is unrelated.
export async function initProject({ apply } = {}) {
  return apply ? applyProject() : scaffoldProject();
}

// Fetch the current store as a read-only reference and write the seed ops file the
// agent authors. Refuses to overwrite an ops file that already has authored ops.
async function scaffoldProject() {
  const { owner, name } = await detectRepo();
  const workdir = resolve(process.cwd(), "spool", "project");
  const opsPath = join(workdir, "knowledge-ops.json");
  if (existsSync(opsPath)) {
    try {
      const parsed = JSON.parse(await readFile(opsPath, "utf8"));
      if (Array.isArray(parsed?.ops) && parsed.ops.length) {
        console.error(
          `${opsPath} already has ${parsed.ops.length} op(s) — not overwriting. Run \`spool init --apply\`, or reset it to ops: [] first.`
        );
        process.exit(1);
      }
    } catch {
      /* malformed existing file: overwrite with a fresh scaffold */
    }
  }
  await mkdir(workdir, { recursive: true });

  const knowledge = await fetchProjectKnowledge(owner, name);
  await writeFile(join(workdir, "knowledge.json"), JSON.stringify(knowledge, null, 2) + "\n");
  await writeFile(opsPath, JSON.stringify(seedScaffold(), null, 2) + "\n");

  console.log(
    [
      `Scaffolded spool/project for ${owner}/${name}`,
      `${knowledgeSummaryLine(knowledge)}  (read-only reference)`,
      `  knowledge-ops.json  seed ops file — author it`,
      "",
      "Next:",
      "  1. Survey the repo (README, docs, code layout).",
      "  2. Author knowledge-ops.json: one set_overview, set_subsystem per major module, set_term for vocabulary (UPDATE existing entries; knowledge.json shows what is known).",
      "  3. BOOT the app and confirm it serves, then record set_recording topics (run, auth, record-tips, gotchas).",
      "  4. spool init --apply",
    ].join("\n")
  );
  return workdir;
}

// Read the authored ops, POST them with the spk token, then reset the ops file so a
// re-run cannot double-apply. Non-200 prints the server's error body and exits 1.
async function applyProject() {
  const { owner, name } = await detectRepo();
  const workdir = resolve(process.cwd(), "spool", "project");
  const opsPath = join(workdir, "knowledge-ops.json");
  if (!existsSync(opsPath)) {
    throw new Error(`no ${opsPath} — run \`spool init\` first, then author it`);
  }
  let parsed;
  try {
    parsed = JSON.parse(await readFile(opsPath, "utf8"));
  } catch (e) {
    throw new Error(`${opsPath} is not valid JSON: ${e.message}`);
  }
  const ops = parsed?.ops;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error(
      `${opsPath} has no ops — author it first (survey the repo, add set_overview/set_subsystem/set_term/set_recording), then \`spool init --apply\``
    );
  }
  if (!ops.every((o) => o && typeof o === "object" && typeof o.op === "string")) {
    throw new Error(`${opsPath} ops must each be an object with a string "op" field`);
  }

  const { host, token } = await resolveConfig();
  if (!host || !token) {
    throw new Error("missing host/token — set SPOOL_HOST + SPOOL_PUBLISH_TOKEN (env), pass them, or write ~/.spool.json");
  }

  const res = await fetch(`${host}/api/projects/knowledge`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ owner, repo: name, ops }),
  });
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    console.error(`seed failed: ${res.status} ${res.statusText}`);
    if (text) console.error(text);
    process.exit(1);
  }

  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    /* tolerate a non-JSON 200 body */
  }
  const applied = Number(json.applied) || 0;
  const skipped = Array.isArray(json.skipped) ? json.skipped.length : Number(json.skipped) || 0;
  if (json.knowledge) await writeFile(join(workdir, "knowledge.json"), JSON.stringify(json.knowledge, null, 2) + "\n");
  // Reset ops to prevent a re-run re-applying the same batch.
  await writeFile(opsPath, JSON.stringify(seedScaffold(), null, 2) + "\n");

  const projectUrl = `${host}/dashboard/p/${owner}/${name}`;
  console.log(
    [
      `seeded: ${applied} op(s) applied, ${skipped} skipped`,
      `  project: ${projectUrl}`,
      `  knowledge-ops.json reset to ops: [] (applied ops cleared to prevent double-apply)`,
    ].join("\n")
  );
  return { applied, skipped, url: projectUrl };
}
