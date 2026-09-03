import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";
import { parseActionYml } from "./support/yaml.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const action = parseActionYml(readFileSync(join(root, "action.yml"), "utf8"));

test("declares the metadata GitHub requires of an action", () => {
  for (const key of ["name", "description", "runs", "inputs", "outputs"]) assert.ok(action[key], `missing ${key}`);
  assert.equal(action.runs.using, "composite");
  assert.ok(Array.isArray(action.runs.steps) && action.runs.steps.length > 0);
});

test("every step names itself and declares a shell or a uses", () => {
  for (const step of action.runs.steps) {
    assert.ok(step.name || step.uses, "a step has neither name nor uses");
    if (step.run !== undefined) assert.equal(step.shell, "bash", `run step "${step.name}" declares no bash shell`);
    assert.ok(!(step.run !== undefined && step.uses !== undefined), "a step cannot both run and use");
  }
});

test("token is the only required input", () => {
  const required = Object.entries(action.inputs)
    .filter(([, spec]) => spec.required === true)
    .map(([name]) => name);
  assert.deepEqual(required, ["token"]);
});

test("every optional input carries a default", () => {
  for (const [name, spec] of Object.entries(action.inputs)) {
    if (spec.required === true) continue;
    assert.notEqual(spec.default, undefined, `${name} is optional with no default`);
  }
});

test("every input and output is documented", () => {
  for (const [name, spec] of Object.entries(action.inputs))
    assert.ok(spec.description, `input ${name} has no description`);
  for (const [name, spec] of Object.entries(action.outputs))
    assert.ok(spec.description, `output ${name} has no description`);
});

test("outputs bind to the dispatch step, which exists", () => {
  const ids = action.runs.steps.map((s) => s.id).filter(Boolean);
  assert.ok(ids.includes("dispatch"));
  for (const [name, spec] of Object.entries(action.outputs))
    assert.match(spec.value, /steps\.dispatch\.outputs\./, `output ${name} is not wired to the dispatch step`);
});

test("cli steps are gated on cli mode and dispatch on notify mode", () => {
  const named = (n) => action.runs.steps.find((s) => s.name === n);
  assert.match(named("Ask Spool to generate the video").if, /mode == 'notify'/);
  for (const name of ["Set up node 20", "Install the spool CLI", "Install ffmpeg", "Install chromium"])
    assert.match(named(name).if, /mode == 'cli'/, `${name} is not gated on cli mode`);
  assert.equal(named("Connect this runner to Spool").if, undefined, "connect must run in both modes");
});

test("the CLI comes from the public npm registry, never from a repository", () => {
  const install = action.runs.steps.find((s) => s.name === "Install the spool CLI");
  assert.match(install.run, /@spoolkit\/cli/);
  for (const step of action.runs.steps) {
    const text = `${step.run ?? ""}${step.uses ?? ""}`;
    assert.ok(!/aaarnv\/spool/.test(text), "the shim must not reference the private repository");
    assert.ok(!/git clone/.test(text), "the shim must not clone a repository");
  }
});
