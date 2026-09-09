// `spool setup`: save installation preferences. Connected machines write the key's
// config on the platform; offline machines (and `--local`) write ~/.spool.json.
// Interactive on a TTY; fully non-interactive with flags or --yes.
import { createInterface } from "node:readline";
import {
  readPrefs, writePrefs, effectivePrefs, saveConfig, resolveHosted,
  CHOICES, DEFAULTS, PREFS_PATH, SETUP_KEYS,
} from "../config/prefs.mjs";

const mask = (t) => (t ? `${String(t).slice(0, 6)}…` : "(none)");
const hostLabel = (host) => String(host).replace(/^https?:\/\//, "").replace(/\/$/, "");

function validate(key, value) {
  if (key === "host") return value; // free-form
  if (!CHOICES[key].includes(value)) {
    throw new Error(`invalid ${key} "${value}"; choose one of: ${CHOICES[key].join(", ")}`);
  }
  return value;
}

// Print the effective config: resolved preferences (with source) + host/token, token masked.
export async function printConfig(cfg) {
  const eff = await effectivePrefs();
  console.log("spool preferences (effective):");
  for (const key of Object.keys(DEFAULTS)) {
    const { value, source, label } = eff[key];
    const tag = source === "platform" && label ? `platform: ${label}` : source;
    console.log(`  ${key.padEnd(8)} ${value ?? "(none)"}  [${tag}]`);
  }
  console.log(`  host     ${cfg.host || "(none)"}`);
  console.log(`  token    ${mask(cfg.token)}`);
  if (cfg.openaiKey) console.log(`  openai   ${mask(cfg.openaiKey)}`);
  if (cfg.openrouterKey) console.log(`  openrtr  ${mask(cfg.openrouterKey)}`);
  const hosted = await resolveHosted();
  if (hosted) console.log(`Managed on ${hostLabel(hosted.host)} > API keys`);
}

// The questions, unchanged. Defaults come from the effective config, so a connected
// machine offers what the key already runs with. Returns only the answered keys.
async function promptAll() {
  const eff = await effectivePrefs();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q, def) =>
    new Promise((res) => rl.question(`${q} [${def ?? ""}]: `, (a) => res(a.trim() || def || "")));
  const patch = {};
  try {
    for (const key of SETUP_KEYS) {
      const def = eff[key].value ?? DEFAULTS[key];
      const ans = validate(key, await ask(`${key} (${CHOICES[key].join("/")})`, def));
      if (ans) patch[key] = ans;
    }
    // No host question: the hosted platform is the default. Self-hosters use
    // --host, SPOOL_HOST, or edit ~/.spool.json directly.
  } finally {
    rl.close();
  }
  return patch;
}

export async function runSetup(opts = {}) {
  if (opts.show) return printConfig(await readPrefs());

  const flags = { browser: opts.browser, target: opts.target, engine: opts.engine };
  const anyFlag = Object.values(flags).some((v) => v != null) || opts.host != null;
  const interactive = !!process.stdin.isTTY && !opts.yes && !anyFlag;

  let patch = {};
  if (interactive) {
    patch = await promptAll();
  } else {
    for (const [key, value] of Object.entries(flags)) {
      if (value != null) patch[key] = validate(key, value);
    }
  }

  // The host is where this machine publishes, not something a key can carry.
  if (opts.host != null) {
    await writePrefs({ ...(await readPrefs()), host: opts.host });
    console.log(`Saved host to ${PREFS_PATH}.`);
  }

  if (Object.keys(patch).length) {
    const connected = !!(await resolveHosted());
    const saved = await saveConfig(patch, { local: !!opts.local });
    if (saved.where === "platform") {
      console.log(`Saved to the platform for key "${saved.label || "this key"}". This machine and any agent using that key pick it up on the next run.`);
    } else if (connected) {
      console.log(`Saved locally to ${PREFS_PATH}. The key config on the platform is unchanged.`);
    } else {
      console.log("Saved locally. Run spool login to keep this on the platform.");
    }
  }

  console.log("");
  await printConfig(await readPrefs());
}
