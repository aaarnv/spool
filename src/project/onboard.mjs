// Bare `spool init`: the first run on a machine and on a repo, in one command.
// Each step prints one line and skips itself when already satisfied, so a re-run on a
// set-up machine is a short receipt rather than a wizard.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runChecks } from "../doctor/doctor.mjs";
import { readPrefs, writePrefs, DEFAULTS, SETUP_KEYS, PREFS_PATH } from "../config/prefs.mjs";
import { printConfig } from "../setup/setup.mjs";
import { login } from "../login/login.mjs";
import { detectRepo, scaffoldProject } from "./init.mjs";

// The App's public install page. The CLI cannot ask the host whether the App covers a
// given repo (no repo-scoped route reads an spk token), so the link is unconditional.
const INSTALL_URL = "https://github.com/apps/spoolkit/installations/new";

const step = (n, label, detail) => console.log(`${n}. ${label.padEnd(12)} ${detail}`);
const note = (text) => console.log(`   ${text}`);
const mask = (t) => `${String(t).slice(0, 6)}…`;

// True when the seed ops file already holds authored ops, so scaffolding would refuse.
async function opsAuthored(opsPath) {
  if (!existsSync(opsPath)) return false;
  try {
    const parsed = JSON.parse(await readFile(opsPath, "utf8"));
    return Array.isArray(parsed?.ops) && parsed.ops.length > 0;
  } catch {
    return false;
  }
}

// Step 1. The same checks `spool doctor` runs. A fail on node/ffmpeg/chromium stops
// onboarding with that check's own fix hint; warnings (openai key, gh) never do.
async function stepEnvironment() {
  const results = await runChecks();
  const fails = results.filter((r) => r.status === "fail");
  const warns = results.filter((r) => r.status === "warn");
  if (fails.length) {
    step(1, "environment", `${fails.length} check(s) failing`);
    for (const f of fails) {
      note(`✗ ${f.name}  ${f.detail}`);
      if (f.hint) note(`  → ${f.hint}`);
    }
    console.log("\nFix those, then run `spool init` again.");
    return false;
  }
  step(1, "environment", `ok (${results.length} checks, ${warns.length} warning(s))`);
  return true;
}

// Step 2. Connect this machine. Browser device flow by default, `--paste` for headless.
// A non-TTY cannot answer either prompt, so it prints the command and stops.
async function stepLogin({ doLogin, paste }) {
  const prefs = await readPrefs();
  if (prefs.token) {
    step(2, "login", `connected (${prefs.host || "no host"}, ${mask(prefs.token)})`);
    return true;
  }
  if (!doLogin) {
    step(2, "login", "skipped (--no-login), publishing and hosted voice stay off");
    return true;
  }
  if (!process.stdin.isTTY) {
    step(2, "login", "not connected, and this is not a terminal");
    note("→ run `spool login` (or `spool login --paste` with an spk_ token), then `spool init` again");
    return false;
  }
  step(2, "login", "not connected, starting login");
  await login({ paste });
  return true;
}

// Step 3. Write the shipped defaults when no preference has ever been set, then show the
// effective config the way `spool setup --show` does.
async function stepPrefs() {
  const cfg = await readPrefs();
  const anySet = SETUP_KEYS.some((k) => cfg[k] != null && cfg[k] !== "");
  if (anySet) {
    step(3, "preferences", "already set");
  } else {
    const next = { ...cfg };
    for (const k of SETUP_KEYS) next[k] = DEFAULTS[k];
    await writePrefs(next);
    step(3, "preferences", `defaults written to ${PREFS_PATH}`);
  }
  console.log("");
  await printConfig(await readPrefs());
  console.log("");
}

// Steps 5 and 6 only mean something inside a GitHub repo, so step 4 decides whether
// they run at all.
async function stepRepo() {
  try {
    const repo = await detectRepo();
    step(4, "repository", `${repo.owner}/${repo.name}`);
    return repo;
  } catch (e) {
    step(4, "repository", `not detected (${e.message})`);
    note("steps 5 and 6 need a GitHub repo, so they are skipped");
    return null;
  }
}

// Step 6. Scaffold the seed files so the follow-up command is real, but never apply:
// the ops are the agent's to author, and applying writes to the shared project store.
async function stepSeed() {
  const opsPath = resolve(process.cwd(), "spool", "project", "knowledge-ops.json");
  if (await opsAuthored(opsPath)) {
    step(6, "knowledge", "spool/project/knowledge-ops.json already authored");
    note("→ apply it with: spool init --apply");
    return;
  }
  await scaffoldProject({ quiet: true });
  step(6, "knowledge", "scaffolded spool/project, which seeds what this repo is so later recordings start warm");
  note("→ author spool/project/knowledge-ops.json (overview, subsystems, terms, how to run the app)");
  note("→ then apply it with: spool init --apply");
}

export async function onboard({ doLogin = true, paste = false } = {}) {
  console.log("spool init: first run\n");

  if (!(await stepEnvironment())) return 1;
  if (!(await stepLogin({ doLogin, paste }))) return 1;
  await stepPrefs();

  const repo = await stepRepo();
  if (repo) {
    step(5, "github app", "install it so a merged PR becomes a recap automatically");
    note(INSTALL_URL);
    await stepSeed();
  }

  console.log(
    [
      "",
      "Next:",
      "  spool live spool/<slug> --url <app-url>   record a walkthrough as you drive it",
      "  merge a PR to get a recap",
    ].join("\n")
  );
  return 0;
}
