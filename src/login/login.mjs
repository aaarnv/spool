import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { resolveConfig } from "../publish/publish.mjs";
import { readPrefs, writePrefs, DEFAULT_HOST } from "../config/prefs.mjs";
import { probeToken } from "../config/probe.mjs";
import { launch } from "../open/open.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Read the spk_ token from stdin; reject anything without the spk_ prefix.
async function promptToken() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = (await rl.question("Paste your spk_ token: ")).trim();
    if (!raw.startsWith("spk_")) {
      console.error("That doesn't look like a spool token (expected an spk_ prefix). Get one at https://spoolkit.dev/dashboard.");
      process.exit(1);
    }
    return raw;
  } finally {
    rl.close();
  }
}

// Device flow: request a code, open the verify URL, poll until approved. Returns
// the granted token, or exits 1 on expiry/timeout. Transient poll errors retry.
async function deviceFlow(host, open) {
  const startRes = await fetch(`${host}/api/cli/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ label: hostname() }),
  });
  if (startRes.status === 429) {
    console.error("Too many login attempts right now — wait a minute and run `spool login` again.");
    process.exit(1);
  }
  if (!startRes.ok) {
    console.error(`Couldn't start login: ${startRes.status} ${startRes.statusText}. Check the host and try again (or use \`spool login --paste\`).`);
    process.exit(1);
  }
  const { code, device, verifyUrl, interval, expiresIn } = await startRes.json();

  console.log(`\nConfirm this code in your browser: ${code}\n`);
  console.log(`  ${verifyUrl}\n`);
  if (open) launch(verifyUrl);
  console.log("Waiting for approval…");

  const stepMs = Math.max(1, Number(interval) || 3) * 1000;
  const deadline = Date.now() + Math.max(1, Number(expiresIn) || 300) * 1000;
  while (Date.now() < deadline) {
    await sleep(stepMs);
    let res;
    try {
      res = await fetch(`${host}/api/cli/login/poll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ device }),
      });
    } catch {
      continue; // transient network blip: keep polling until the deadline
    }
    if (res.status === 404 || res.status === 410) break; // expired/claimed
    if (!res.ok) continue;
    const body = await res.json().catch(() => ({}));
    if (body.status === "approved" && body.token) return body.token;
  }
  console.error("Login code expired — run `spool login` again.");
  process.exit(1);
}

// Write host+token to ~/.spool.json (preserving other prefs), then validate.
async function writeAndValidate(host, token) {
  const prefs = await readPrefs();
  const hadToken = !!prefs.token;
  await writePrefs({ ...prefs, host, token });
  if (hadToken) {
    console.log("Replaced the token in ~/.spool.json (the previous token stays valid until revoked on the dashboard).");
  }

  let valid = false;
  try {
    const { ok, status } = await probeToken(host, token);
    valid = ok;
    if (!ok) console.log(`Token saved but validation failed (status ${status}) — run \`spool doctor\`.`);
  } catch {
    console.log("Token saved but validation could not run (host unreachable) — run `spool doctor`.");
  }
  if (valid) console.log("✓ Connected.");

  console.log(
    [
      "",
      "Next:",
      "  • Record your first spool:  spool live spool/my-demo --url http://localhost:3000",
      "  • Working with an agent? Hand it skills/spool/SKILL.md.",
      "  • Check your environment any time:  spool doctor",
    ].join("\n")
  );
}

export async function login({ host: hostFlag, paste = false, open = true } = {}) {
  const cfg = await resolveConfig().catch(() => ({}));
  const host = (hostFlag || cfg.host || DEFAULT_HOST).replace(/\/$/, "");

  const token = paste ? await promptToken() : await deviceFlow(host, open);
  await writeAndValidate(host, token);
}
