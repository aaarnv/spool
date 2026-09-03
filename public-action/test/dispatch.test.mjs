import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ENDPOINT, buildBody, explain, main, parsePayload, writeOutputs } from "../scripts/dispatch.mjs";

const env = (over = {}) => ({
  SPOOL_TOKEN: "spk_test",
  SPOOL_HOST: "https://spoolkit.dev",
  SPOOL_EVENT: "pull_request.merged",
  SPOOL_PAYLOAD: '{"number":7}',
  SPOOL_REPOSITORY: "acme/app",
  SPOOL_REF: "refs/heads/main",
  SPOOL_SHA: "abc123",
  SPOOL_RUN_URL: "https://github.com/acme/app/actions/runs/1",
  ...over,
});

test("reads an object payload and treats an empty one as no payload", () => {
  assert.deepEqual(parsePayload('{"a":1}'), { a: 1 });
  assert.deepEqual(parsePayload(""), {});
  assert.deepEqual(parsePayload("   "), {});
});

test("refuses a payload that is not a JSON object", () => {
  assert.throws(() => parsePayload("[1]"), /must be a JSON object/);
  assert.throws(() => parsePayload("7"), /must be a JSON object/);
  assert.throws(() => parsePayload("null"), /must be a JSON object/);
  assert.throws(() => parsePayload("{oops"), /not valid JSON/);
});

test("carries the run's identity alongside the event", () => {
  assert.deepEqual(buildBody(env()), {
    event: "pull_request.merged",
    repository: "acme/app",
    ref: "refs/heads/main",
    sha: "abc123",
    runUrl: "https://github.com/acme/app/actions/runs/1",
    payload: { number: 7 },
  });
});

test("refuses to dispatch without an event", () => {
  assert.throws(() => buildBody(env({ SPOOL_EVENT: "  " })), /needs an event/);
});

test("a 404 points the operator at cli mode", () => {
  assert.match(explain(404), /does not serve server-side generation yet — use mode: cli/);
  assert.match(explain(401), /Mint a fresh one/);
  assert.equal(explain(402, "over the free cap"), "over the free cap");
  assert.equal(explain(500), "the host answered 500");
});

test("writes the three outputs, blank when the host omitted them", () => {
  const file = join(mkdtempSync(join(tmpdir(), "spool-action-")), "out");
  writeOutputs({ id: "abc", url: "https://spoolkit.dev/l/abc" }, { GITHUB_OUTPUT: file });
  assert.equal(readFileSync(file, "utf8"), "id=abc\nurl=https://spoolkit.dev/l/abc\njob-id=\n");
});

test("posts the event to the versioned endpoint with the bearer token", async () => {
  const seen = {};
  const fetchImpl = async (url, init) => {
    seen.url = url;
    seen.init = init;
    return { ok: true, json: async () => ({ id: "abc", url: "https://spoolkit.dev/l/abc", jobId: "j1" }) };
  };
  await main(env(), fetchImpl);
  assert.equal(seen.url, `https://spoolkit.dev${ENDPOINT}`);
  assert.equal(seen.init.headers.authorization, "Bearer spk_test");
  assert.equal(JSON.parse(seen.init.body).payload.number, 7);
});

test("surfaces the host's own error text on a refusal", async () => {
  const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ error: "upgrade to keep publishing" }) });
  await assert.rejects(() => main(env(), fetchImpl), /upgrade to keep publishing/);
});
