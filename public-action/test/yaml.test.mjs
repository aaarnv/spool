import assert from "node:assert/strict";
import test from "node:test";
import { parseActionYml } from "./support/yaml.mjs";

test("reads nested maps, sequences and inline heads", () => {
  const doc = parseActionYml(["runs:", "  using: composite", "  steps:", "    - name: one", "      shell: bash"].join("\n"));
  assert.deepEqual(doc.runs, { using: "composite", steps: [{ name: "one", shell: "bash" }] });
});

test("folds a > block onto one line and keeps a | block's newlines", () => {
  const doc = parseActionYml(["a: >", "  one", "  two", "b: |", "  x", "  y"].join("\n"));
  assert.equal(doc.a, "one two\n");
  assert.equal(doc.b, "x\ny\n");
});

test("keeps comment characters inside a | block", () => {
  const doc = parseActionYml(["run: |", "  # a shell comment", "  echo hi"].join("\n"));
  assert.equal(doc.run, "# a shell comment\necho hi\n");
});

test("drops a trailing comment but not a quoted or mid-word hash", () => {
  const doc = parseActionYml(['a: value # note', "b: 'x # y'", "c: a#b"].join("\n"));
  assert.equal(doc.a, "value");
  assert.equal(doc.b, "x # y");
  assert.equal(doc.c, "a#b");
});

test("unquotes strings and reads booleans, numbers and empty strings", () => {
  const doc = parseActionYml(['a: "true"', "b: true", "c: 2", 'd: ""'].join("\n"));
  assert.equal(doc.a, "true");
  assert.equal(doc.b, true);
  assert.equal(doc.c, 2);
  assert.equal(doc.d, "");
});

test("keeps an expression value intact", () => {
  const doc = parseActionYml("value: ${{ steps.dispatch.outputs.id }}");
  assert.equal(doc.value, "${{ steps.dispatch.outputs.id }}");
});

test("refuses a line that is not a mapping entry", () => {
  assert.throws(() => parseActionYml("a: 1\nnot a mapping\n"), /expected "key: value"/);
});
