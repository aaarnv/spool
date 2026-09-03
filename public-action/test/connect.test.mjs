import assert from "node:assert/strict";
import test from "node:test";
import { nextConfig, normalizeConcurrency, normalizeHost } from "../scripts/connect.mjs";

test("keeps unrelated config keys when it writes the credential", () => {
  const out = nextConfig({ openaiKey: "sk-x", host: "https://old", token: "spk_old" }, { host: "https://new", token: "spk_new" });
  assert.deepEqual(out, { openaiKey: "sk-x", host: "https://new", token: "spk_new" });
});

test("starts from an empty object when there is no config", () => {
  assert.deepEqual(nextConfig(null, { host: "https://h", token: "t" }), { host: "https://h", token: "t" });
});

test("trims a trailing slash and falls back to the default host", () => {
  assert.equal(normalizeHost("https://spoolkit.dev/"), "https://spoolkit.dev");
  assert.equal(normalizeHost(""), "https://spoolkit.dev");
  assert.equal(normalizeHost(undefined), "https://spoolkit.dev");
});

test("refuses a plaintext host but allows localhost", () => {
  assert.throws(() => normalizeHost("http://example.com"), /must be https/);
  assert.equal(normalizeHost("http://localhost:3000"), "http://localhost:3000");
  assert.throws(() => normalizeHost("not a url"), /not a URL/);
});

test("caps render concurrency and ignores a value that is not a count", () => {
  assert.equal(normalizeConcurrency("2"), "2");
  assert.equal(normalizeConcurrency("99"), "8");
  assert.equal(normalizeConcurrency("0"), null);
  assert.equal(normalizeConcurrency(""), null);
  assert.equal(normalizeConcurrency("lots"), null);
});
