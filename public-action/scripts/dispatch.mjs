#!/usr/bin/env node
// notify mode: hand the host one event and let it generate the video. The runner does
// no recording, no rendering and no authoring, so this whole file is a POST.
import { appendFileSync } from "node:fs";

export const ENDPOINT = "/api/actions/v1/dispatch";

export function parsePayload(raw) {
  const text = (raw || "").trim();
  if (!text) return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("payload is not valid JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("payload must be a JSON object");
  return value;
}

export function buildBody(env) {
  const event = (env.SPOOL_EVENT || "").trim();
  if (!event) throw new Error('notify mode needs an event, e.g. event: "pull_request.merged"');
  return {
    event,
    repository: env.SPOOL_REPOSITORY || null,
    ref: env.SPOOL_REF || null,
    sha: env.SPOOL_SHA || null,
    runUrl: env.SPOOL_RUN_URL || null,
    payload: parsePayload(env.SPOOL_PAYLOAD),
  };
}

// Failures here are configuration mistakes far more often than outages, so each status
// gets the sentence that names the fix rather than a bare code.
export function explain(status, serverError) {
  if (status === 404)
    return `${serverError || "no generator at " + ENDPOINT}. This Spool host does not serve server-side generation yet — use mode: cli.`;
  if (status === 401) return "the token was rejected. Mint a fresh one at /dashboard and update the SPOOL_TOKEN secret.";
  if (status === 402) return serverError || "this account is over its published-spool limit.";
  if (status === 429) return serverError || "this account is over its monthly generation limit.";
  return serverError || `the host answered ${status}`;
}

export function writeOutputs(result, env = process.env) {
  if (!env.GITHUB_OUTPUT) return;
  const lines = [
    `id=${result.id ?? ""}`,
    `url=${result.url ?? ""}`,
    `job-id=${result.jobId ?? ""}`,
  ];
  appendFileSync(env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

async function main(env = process.env, fetchImpl = fetch) {
  const host = (env.SPOOL_HOST || "https://spoolkit.dev").trim().replace(/\/+$/, "");
  const res = await fetchImpl(`${host}${ENDPOINT}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.SPOOL_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(buildBody(env)),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(explain(res.status, body?.error));
  writeOutputs(body, env);
  console.log(body.url ? `spool queued: ${body.url}` : "spool queued");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.log(`::error::${e.message}`);
    process.exit(1);
  });
}

export { main };
