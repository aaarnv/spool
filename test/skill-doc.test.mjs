// The agent skill is documentation an agent executes, so a command it names that the CLI
// does not have is a broken tool call in somebody else's session. This test keeps
// `skills/spool/*.md` in sync with the CLI by asking commander itself: every `spool …`
// invocation in the skill is resolved against `--help`, command by command and flag by
// flag. Rename a flag and this fails before the skill ships the old one.
//
// The resolver itself lives in test/support/cli-doc.mjs, because the pilot runbook and the
// dispatch preset are executed documentation too (test/pilot-doc.test.mjs).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { checkInvocation, commandTree, invocations, repo } from './support/cli-doc.mjs';

const skillDir = join(repo, 'skills', 'spool');

// --- the test ---------------------------------------------------------------

test('every spool command the skill names exists, with the flags it passes', async () => {
  const tree = await commandTree();
  const files = readdirSync(skillDir).filter((f) => f.endsWith('.md'));
  assert.ok(files.includes('SKILL.md'), 'skills/spool/SKILL.md is the skill entry point');

  let checked = 0;
  const covered = new Set();
  for (const file of files) {
    const markdown = readFileSync(join(skillDir, file), 'utf8');
    for (const invocation of invocations(markdown)) {
      covered.add(checkInvocation(invocation, tree, file));
      checked++;
    }
  }
  assert.ok(checked > 40, `expected the skill to show real command sequences (found ${checked})`);

  // The Plan Spool surface is the point of R4.4: a skill that stopped naming one of these
  // has lost a step of the workflow, which no per-invocation check would notice.
  for (const required of [
    'plan init', 'plan validate', 'plan generate', 'plan build',
    'read', 'reply', 'gate check', 'gate run', 'gate policy', 'publish',
  ]) {
    assert.ok(covered.has(required), `the skill never shows \`spool ${required}\``);
  }
});
