// The four worked examples in skills/spool/PLAN-EXAMPLES.md, replayed.
//
// The acceptance for R4.4 is that an agent which has only read the skill produces a
// compliant plan and refuses to proceed when a human is required. Both halves are
// checkable offline: the packets the examples show are fixtures here, so they must pass
// `--strict` and generate a clean script, and the states the examples refuse on must
// really come back as a refusal from `spool read --plan` and `spool gate check`.
//
// No network, no browser, no account. See test/fixtures/skill/.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
// A read journals its outcome (roadmap R6.3). These examples read a host that is not
// there on purpose, which is not a fact about this machine, so the journal stays off.
process.env.SPOOL_RELIABILITY = 'off';
const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const cli = join(repo, 'bin', 'spool.mjs');
const fixtures = join(here, 'fixtures', 'skill');

// A host that refuses instantly, so a "the host is unreachable" example stays offline
// and fast instead of waiting on a real DNS lookup.
const DEAD_HOST = 'http://127.0.0.1:1';

async function run(args, cwd = repo) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const json = (out) => JSON.parse(out.slice(out.indexOf('{')));

/** A throwaway copy of a fixture packet, so generation can write beside it. */
async function workdir(name) {
  const dir = await mkdtemp(join(tmpdir(), `spool-skill-${name}-`));
  await cp(join(fixtures, name), dir, { recursive: true });
  return dir;
}

// The packets the examples print. Each is a different decision shape on purpose:
// an approval with no alternatives, an approval that offers one, and a selection.
const PACKETS = ['new-feature', 'risky-change', 'ambiguous-request'];

for (const name of PACKETS) {
  test(`${name}: the example packet is compliant`, async (t) => {
    const dir = await workdir(name);
    t.after(() => rm(dir, { recursive: true, force: true }));

    // 1. Validation, as the skill runs it. --strict is the step that stops a template
    //    shipping, so a fixture with a single warning is not an example worth copying.
    const validated = await run(['plan', 'validate', dir, '--strict', '--json']);
    const report = json(validated.stdout);
    assert.equal(validated.code, 0, `plan validate --strict failed: ${validated.stdout}`);
    assert.deepEqual(report.errors, []);
    assert.deepEqual(report.warnings, []);

    // 2. Generation. The narration is the reviewer-facing half, so the example has to
    //    produce a script inside the format's promise with nothing for the lint to say.
    const generated = await run(['plan', 'generate', dir, '--json']);
    assert.equal(generated.code, 0, `plan generate failed: ${generated.stderr}`);
    const { script, lint } = json(generated.stdout);
    assert.deepEqual(lint.errors, []);
    assert.deepEqual(lint.warnings, []);
    assert.equal(script.chapters.length, 5, 'the five canonical chapters, in order');
    assert.deepEqual(
      script.chapters.map((c) => c.id),
      ['context', 'outcome', 'approach', 'risks', 'decision']
    );
    assert.ok(script.estimatedSeconds >= 45 && script.estimatedSeconds <= 120,
      `a plan runs 45 to 120s (got ${script.estimatedSeconds}s)`);

    // 3. Every chapter carries the chapterId that anchors it to the recording.
    for (const chapter of script.chapters) assert.equal(chapter.step.chapterId, chapter.id);

    // 4. Unpublished is a draft, and a draft refuses implementation.
    const read = json((await run(['read', dir, '--plan', '--offline', '--json'])).stdout);
    assert.equal(read.status, 'draft');
    assert.equal(read.nextAction.action, 'publish_plan');
  });
}

test('new-feature: absent alternatives are stated, never silent', async () => {
  const { stdout } = await run(['read', join(fixtures, 'new-feature'), '--plan', '--offline', '--json']);
  const plan = json(stdout);
  assert.deepEqual(plan.approach.map((s) => s.id), ['record', 'filter', 'undo']);
  assert.deepEqual(plan.alternatives, []);
});

test('risky-change: the rejected alternative is offered as a decision option', async () => {
  const packet = JSON.parse(await readFile(join(fixtures, 'risky-change', 'plan.json'), 'utf8'));
  assert.equal(packet.decision.type, 'approval');
  assert.ok(packet.decision.options.includes('approve'));
  assert.ok(packet.decision.options.includes('alternative:profile-column'));
  assert.ok(packet.alternatives.some((a) => a.id === 'profile-column'));
});

test('ambiguous-request: the human chooses, so the plan cannot be approved into one reading', async () => {
  const packet = JSON.parse(await readFile(join(fixtures, 'ambiguous-request', 'plan.json'), 'utf8'));
  assert.equal(packet.decision.type, 'selection');
  assert.ok(!packet.decision.options.includes('approve'), 'a selection asks which, not whether');
  assert.deepEqual(
    packet.decision.options.filter((o) => o.startsWith('alternative:')),
    ['alternative:sticky', 'alternative:snooze']
  );
});

test('risky change: the gate blocks a migration with no approved plan', async () => {
  const dir = join(fixtures, 'risky-change');
  const blocked = await run([
    'gate', 'check', '--plan', dir, '--policy', 'required',
    '--paths', 'web/db/migrations/0021_dismissals.sql',
    '--command', 'npm run db:migrate', '--json',
  ]);
  assert.equal(blocked.code, 1, 'exit 1 is the contract for blocked');
  const verdict = json(blocked.stdout);
  assert.equal(verdict.decision, 'block');
  assert.ok(verdict.reasons.includes('plan_not_approved'));
  assert.ok(verdict.risk.highRisk, 'a migration path is high risk by the built-in definition');
});

test('handoff: an unreachable host is not an approval', async () => {
  const bundle = join(fixtures, 'handoff', 'share');

  // The bundle travelled with a publish receipt, so this plan WAS published — and the
  // status still cannot be read offline. The refusal is the whole example.
  const read = json((await run(['read', bundle, '--plan', '--offline', '--json'])).stdout);
  assert.equal(read.status, 'unknown');
  assert.equal(read.nextAction.action, 'none');
  assert.match(read.nextAction.reason, /must not be treated as approved/);
  assert.equal(read.links.watch, 'https://spoolkit.dev/l/kQ7m2xR9pL4vN8tB');

  // The gate says the same thing with an exit code, and fails closed.
  const blocked = await run([
    'gate', 'check', '--plan', bundle, '--policy', 'required',
    '--host', DEAD_HOST, '--json',
  ]);
  assert.equal(blocked.code, 1);
  const verdict = json(blocked.stdout);
  assert.equal(verdict.decision, 'block');
  assert.ok(verdict.reasons.includes('plan_status_unknown'));
  assert.equal(verdict.plan.status, 'unknown');
});
