import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

// public-action/ ships as its own public repository, so its tests live with it and run
// in its CI. Importing them registers them here too: the shim can break when this repo
// changes around it, and this suite is where that has to show up.
import "../public-action/test/action-yml.test.mjs";
import "../public-action/test/connect.test.mjs";
import "../public-action/test/dispatch.test.mjs";
import "../public-action/test/yaml.test.mjs";

const dir = join(process.cwd(), "public-action");

test("no proprietary source leaks into the public directory", () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(d, e.name);
      e.isDirectory() ? walk(p) : files.push(p);
    }
  };
  walk(dir);
  // Every published byte is one of these; anything else needs a deliberate decision.
  const allowed = /\.(yml|mjs|md|json)$|LICENSE$/;
  for (const f of files) assert.match(f, allowed, `unexpected file in public-action: ${f}`);

  for (const f of files.filter((f) => /\.(mjs|yml)$/.test(f))) {
    const text = readFileSync(f, "utf8");
    assert.ok(!/aaarnv\/spool/.test(text), `${f} names the private repository`);
    assert.ok(!/(from|require\() *["']\.\.\/\.\.\//.test(text), `${f} reaches outside the public directory`);
  }
});

test("the public directory carries no dependency of its own", () => {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  assert.equal(pkg.dependencies, undefined);
  assert.equal(pkg.devDependencies, undefined);
});

test("the public action is MIT licensed and says the rest is not", () => {
  assert.match(readFileSync(join(dir, "LICENSE"), "utf8"), /MIT License/);
  assert.match(readFileSync(join(dir, "README.md"), "utf8"), /closed source/);
});
