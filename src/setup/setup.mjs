// `spool setup`: write installation preferences to ~/.spool.json. Interactive on a
// TTY; fully non-interactive with flags or --yes. Unspecified keys keep their values.
import { createInterface } from "node:readline";
import { readPrefs, writePrefs, effectivePrefs, CHOICES, DEFAULTS, PREFS_PATH } from "../config/prefs.mjs";

const mask = (t) => (t ? `${String(t).slice(0, 6)}…` : "(none)");

function validate(key, value) {
  if (key === "bg" || key === "host") return value; // free-form
  if (!CHOICES[key].includes(value)) {
    throw new Error(`invalid ${key} "${value}"; choose one of: ${CHOICES[key].join(", ")}`);
  }
  return value;
}

// Print the effective config: resolved preferences (with source) + host/token, token masked.
async function printConfig(cfg) {
  const eff = await effectivePrefs();
  console.log("spool preferences (effective):");
  for (const key of Object.keys(DEFAULTS)) {
    const { value, source } = eff[key];
    console.log(`  ${key.padEnd(8)} ${value ?? "(none)"}  [${source}]`);
  }
  console.log(`  host     ${cfg.host || "(none)"}`);
  console.log(`  token    ${mask(cfg.token)}`);
  if (cfg.openaiKey) console.log(`  openai   ${mask(cfg.openaiKey)}`);
}

async function promptAll(cfg) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) =>
    new Promise((res) => rl.question(`${q} [${def ?? ""}]: `, (a) => res(a.trim() || def || "")));
  const next = { ...cfg };
  try {
    for (const key of Object.keys(CHOICES)) {
      const def = cfg[key] ?? DEFAULTS[key];
      const ans = validate(key, await ask(`${key} (${CHOICES[key].join("/")})`, def));
      if (ans) next[key] = ans;
    }
    const bg = await ask("bg (render background, blank for none)", cfg.bg ?? "");
    if (bg) next.bg = bg;
    else delete next.bg;
    // No host question: the hosted platform is the default. Self-hosters use
    // --host, SPOOL_HOST, or edit ~/.spool.json directly.
  } finally {
    rl.close();
  }
  return next;
}

export async function runSetup(opts = {}) {
  const cfg = await readPrefs();
  if (opts.show) return printConfig(cfg);

  const flags = { browser: opts.browser, target: opts.target, engine: opts.engine, bg: opts.bg, host: opts.host };
  const anyFlag = Object.values(flags).some((v) => v != null);
  const interactive = !!process.stdin.isTTY && !opts.yes && !anyFlag;

  let next;
  if (interactive) {
    next = await promptAll(cfg);
  } else {
    next = { ...cfg };
    for (const [k, v] of Object.entries(flags)) {
      if (v == null) continue;
      next[k] = k === "host" ? v : validate(k, v);
    }
  }

  await writePrefs(next);
  console.log(`Saved preferences to ${PREFS_PATH}\n`);
  await printConfig(next);
}
