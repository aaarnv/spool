#!/usr/bin/env node
// Write the runner's Spool credential to ~/.spool.json. Both modes need it: the CLI
// reads it to publish and to voice, and notify mode uses the same host it records.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_HOST = "https://spoolkit.dev";

export function nextConfig(existing, { host, token }) {
  const prev = existing && typeof existing === "object" ? existing : {};
  return { ...prev, host, token };
}

export function readConfig(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

export function normalizeHost(raw) {
  const host = (raw || "").trim().replace(/\/+$/, "") || DEFAULT_HOST;
  let url;
  try {
    url = new URL(host);
  } catch {
    throw new Error(`host is not a URL: ${host}`);
  }
  if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1")
    throw new Error(`host must be https (got ${url.protocol}//)`);
  return host;
}

export function normalizeConcurrency(raw) {
  const n = Number.parseInt((raw || "").trim(), 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return String(Math.min(n, 8));
}

function main(env = process.env) {
  const token = (env.SPOOL_TOKEN || "").trim();
  if (!token) throw new Error("token is empty — pass the SPOOL_TOKEN secret to this action");
  // Keeps the credential out of the job log even if a later step echoes it.
  console.log(`::add-mask::${token}`);
  if (!token.startsWith("spk_"))
    console.log("::warning::the token does not look like a Spool token (spk_...)");

  const host = normalizeHost(env.SPOOL_HOST);
  const path = join(homedir(), ".spool.json");
  writeFileSync(path, `${JSON.stringify(nextConfig(readConfig(path), { host, token }))}\n`, { mode: 0o600 });

  const concurrency = normalizeConcurrency(env.SPOOL_RENDER_CONCURRENCY_INPUT);
  if (concurrency && env.GITHUB_ENV) appendFileSync(env.GITHUB_ENV, `SPOOL_RENDER_CONCURRENCY=${concurrency}\n`);

  console.log(`connected to ${host} (mode: ${env.SPOOL_MODE || "cli"})`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exit(1);
  }
}

export { main };
