// `spool gate` end to end (roadmap R4.3). Exit codes, the blocked explanation and the
// audit log are the contract an agent scripts against, so they are asserted here
// against the real CLI rather than against the modules behind it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, '..', 'bin', 'spool.mjs');

/**
 * A throwaway project. HOME points at it too, so a developer's own ~/.spool.json
 * cannot change what these tests resolve.
 */
async function project(config = null) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-gatecli-'));
  await mkdir(join(dir, '.git'), { recursive: true });
  if (config) await writeFile(join(dir, 'spool.config.json'), JSON.stringify(config, null, 2));
  return dir;
}

async function run(args, cwd, env = {}) {
  try {
    const { stdout, stderr } = await exec(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, HOME: cwd, SPOOL_PLAN_POLICY: '', SPOOL_PLAN: '', SPOOL_HOST: '', SPOOL_PUBLISH_TOKEN: '', ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

const auditLines = async (dir) => {
  const path = join(dir, '.spool', 'audit.jsonl');
  if (!existsSync(path)) return [];
  return (await readFile(path, 'utf8')).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
};

/** A plan workdir, optionally published against a host that answers with `status`. */
async function plan(dir, { slug = 'ask-anchors', published = null } = {}) {
  const wd = join(dir, 'spool', slug);
  await mkdir(join(wd, 'share'), { recursive: true });
  await writeFile(join(wd, 'plan.json'), JSON.stringify({ version: 1, kind: 'plan', goal: 'Add timestamped questions.', links: {} }));
  if (published) await writeFile(join(wd, 'share', 'published.json'), JSON.stringify(published));
  return wd;
}

/** A host that answers `GET /api/plans/{id}` with one payload. */
async function host(payload) {
  const server = createServer((req, res) => {
    if (payload === null) {
      res.writeHead(404).end('{}');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

// --- FR-17 ------------------------------------------------------------------

test('an unconfigured project reports advisory; the config overrides it', async () => {
  const dir = await project();
  const bare = await run(['gate', 'policy', '--json'], dir);
  assert.equal(bare.code, 0, bare.stderr);
  const before = JSON.parse(bare.stdout);
  assert.equal(before.policy, 'advisory');
  assert.equal(before.via, 'default');

  await writeFile(join(dir, 'spool.config.json'), JSON.stringify({ policy: 'required' }));
  const after = JSON.parse((await run(['gate', 'policy', '--json'], dir)).stdout);
  assert.equal(after.policy, 'required');
  assert.equal(after.via, 'repo');
});

test('a local flag cannot switch a required project off', async () => {
  const dir = await project({ policy: 'required' });
  const out = JSON.parse((await run(['gate', 'policy', '--policy', 'off', '--json'], dir)).stdout);
  assert.equal(out.policy, 'required');
});

// --- FR-18 ------------------------------------------------------------------

test('a blocked command exits non-zero and explains itself with the plan link', async () => {
  const dir = await project({ policy: 'required' });
  const served = await host({ spoolId: 'sp_abcdefghijklmnop12', status: 'awaiting_decision', revision: 1, goal: 'g', links: { watch: 'https://example.test/l/sp_abcdefghijklmnop12' } });
  await plan(dir, { published: { id: 'sp_abcdefghijklmnop12', url: `${served.url}/l/sp_abcdefghijklmnop12` } });

  const out = await run(['gate', 'check', '--command', 'npm run migrate'], dir);
  await served.close();

  assert.equal(out.code, 1);
  assert.match(out.stderr, /BLOCKED/);
  assert.match(out.stderr, /npm run migrate/);
  assert.match(out.stderr, /required \(repo\)/);
  assert.match(out.stderr, /awaiting_decision/);
  assert.match(out.stderr, /example\.test\/l\/sp_abcdefghijklmnop12/);
  assert.match(out.stderr, /--bypass --reason/);
});

test('an approved plan lets the work start, and reports the start', async () => {
  const dir = await project({ policy: 'required' });
  const served = await host({
    spoolId: 'sp_abcdefghijklmnop12',
    status: 'approved',
    revision: 2,
    revisionId: 'rev-2',
    decision: { action: 'approve', type: 'approved_with_notes', notes: 'rename the flag first' },
    goal: 'g',
    links: { watch: 'https://example.test/l/sp_abcdefghijklmnop12' },
  });
  await plan(dir, { published: { id: 'sp_abcdefghijklmnop12', url: `${served.url}/l/sp_abcdefghijklmnop12` } });

  const out = await run(['gate', 'check', '--json'], dir);
  await served.close();
  assert.equal(out.code, 0, out.stderr);
  const json = JSON.parse(out.stdout);
  assert.equal(json.decision, 'allow');
  assert.deepEqual(json.reasons, ['plan_approved_with_notes']);
  assert.equal(json.notes, 'rename the flag first');
  assert.equal(json.audit.event, 'implementation_started');
  const [record] = await auditLines(dir);
  assert.equal(record.event, 'implementation_started');
  assert.equal(record.plan.status, 'approved');
});

test('an unreachable host blocks rather than assuming approval', async () => {
  const dir = await project({ policy: 'required' });
  // Port 1 is not listening, so the status read fails the way a real outage does.
  await plan(dir, { published: { id: 'sp_abcdefghijklmnop12', url: 'http://127.0.0.1:1/l/sp_abcdefghijklmnop12' } });
  const out = await run(['gate', 'check'], dir);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /BLOCKED/);
  assert.match(out.stderr, /could not be read/);
});

test('two plan workdirs are ambiguous, and ambiguity blocks', async () => {
  const dir = await project({ policy: 'required' });
  await plan(dir, { slug: 'one' });
  await plan(dir, { slug: 'two' });
  const out = await run(['gate', 'check'], dir);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /spool\/one, spool\/two/);
  // Naming one resolves it: the same project, one flag, a different verdict path.
  const named = await run(['gate', 'check', '--plan', 'spool/one', '--json'], dir);
  assert.equal(named.code, 1);
  assert.deepEqual(JSON.parse(named.stdout).reasons, ['plan_not_approved']);
});

// --- FR-19 ------------------------------------------------------------------

test('an advisory run without an approved plan still records a bypass', async () => {
  const dir = await project(); // unconfigured: advisory
  await plan(dir);
  const out = await run(['gate', 'check', '--command', 'npm run build'], dir);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /WARNING/);

  const [record] = await auditLines(dir);
  assert.equal(record.event, 'implementation_bypassed');
  assert.equal(record.policy, 'advisory');
  assert.equal(record.bypassed, true);
  assert.equal(record.enforced, false);
  assert.equal(record.command, 'npm run build');
  assert.deepEqual(record.reasons, ['plan_not_approved']);
});

test('a bypass needs a reason, and records it', async () => {
  const dir = await project({ policy: 'required' });
  await plan(dir);

  const noReason = await run(['gate', 'check', '--bypass'], dir);
  assert.equal(noReason.code, 2);
  assert.match(noReason.stderr, /--bypass needs --reason/);
  assert.deepEqual(await auditLines(dir), []); // nothing evaluated, nothing recorded

  const withReason = await run(['gate', 'check', '--bypass', '--reason', 'prod is down', '--command', 'npm run migrate'], dir);
  assert.equal(withReason.code, 0, withReason.stderr);
  const [record] = await auditLines(dir);
  assert.equal(record.event, 'implementation_bypassed');
  assert.equal(record.reason, 'prod is down');
  assert.equal(record.enforced, true);
});

test('a blocked run is recorded too', async () => {
  const dir = await project({ policy: 'required' });
  await plan(dir);
  await run(['gate', 'check', '--command', 'npm run migrate'], dir);
  const [record] = await auditLines(dir);
  assert.equal(record.event, 'implementation_blocked');
  assert.equal(record.decision, 'block');
});

// --- high_risk_required -----------------------------------------------------

test('high_risk_required blocks the configured paths and advises on the rest', async () => {
  const dir = await project({ policy: 'high_risk_required', highRisk: { paths: ['db/**'] } });
  await plan(dir);

  const safe = await run(['gate', 'check', '--paths', 'README.md'], dir);
  assert.equal(safe.code, 0, safe.stderr);
  assert.match(safe.stdout, /WARNING/);

  const risky = await run(['gate', 'check', '--paths', 'db/0001_init.sql', '--command', 'npm run migrate'], dir);
  assert.equal(risky.code, 1);
  assert.match(risky.stderr, /high risk — path:db\/0001_init\.sql/);
});

test('a label makes work high risk when the team defined it that way', async () => {
  const dir = await project({ policy: 'high_risk_required', highRisk: { labels: ['security'] } });
  await plan(dir);
  const out = await run(['gate', 'check', '--paths', 'README.md', '--label', 'security'], dir);
  assert.equal(out.code, 1);
  assert.match(out.stderr, /label:security/);
});

// --- gate run ---------------------------------------------------------------

test('a blocked command never runs; an allowed one runs and keeps its exit code', async () => {
  const dir = await project({ policy: 'required' });
  await plan(dir);
  const marker = join(dir, 'ran.txt');

  const blocked = await run(['gate', 'run', '--', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], dir);
  assert.equal(blocked.code, 1);
  assert.equal(existsSync(marker), false, 'the gated command must not have run');

  const allowed = await run(['gate', 'run', '--bypass', '--reason', 'hotfix', '--', 'node', '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(3)`], dir);
  assert.equal(allowed.code, 3, 'the command exit code passes through');
  assert.equal(existsSync(marker), true);
});

test('the same verdict comes back from a subdirectory', async () => {
  // The active plan is the project's, not the current directory's: an agent working
  // in web/ must not be told there is no plan.
  const dir = await project({ policy: 'required' });
  await plan(dir);
  await mkdir(join(dir, 'web', 'lib'), { recursive: true });
  const out = await run(['gate', 'check', '--json'], join(dir, 'web', 'lib'));
  assert.equal(out.code, 1);
  const json = JSON.parse(out.stdout);
  assert.deepEqual(json.reasons, ['plan_not_approved']);
  assert.equal(json.plan.target, 'spool/ask-anchors');
  assert.equal(json.policy.value, 'required');
});

test('a check that cannot run exits 2, never 0', async () => {
  const dir = await project();
  await writeFile(join(dir, 'spool.config.json'), '{ not json');
  const out = await run(['gate', 'check'], dir);
  assert.equal(out.code, 2);
  assert.match(out.stderr, /the check could not run/);
  assert.match(out.stderr, /not valid JSON/);
});

test('every check that runs is recorded, with no way to opt out', async () => {
  const dir = await project();
  await plan(dir);
  await run(['gate', 'check'], dir);
  await run(['gate', 'check'], dir);
  assert.equal((await auditLines(dir)).length, 2);
});
