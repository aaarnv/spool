import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/spool.mjs', import.meta.url));

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-auth-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function run(dir, args, env = {}) {
  try {
    const result = await exec(process.execPath, [cli, ...args], {
      cwd: dir,
      env: {
        ...process.env, HOME: dir, SPOOL_PUBLISH_TOKEN: '', SPOOL_TOKEN: '',
        SPOOL_HOST: 'http://127.0.0.1:1', ...env,
      },
      timeout: 10000,
    });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test('all media entry points refuse missing credentials before creating files', async (t) => {
  const dir = await fixture(t);
  const commands = [
    ['live', 'demo'], ['live', 'demo', '--target', 'os'], ['record', 'demo'],
    ['vo', 'demo'], ['render', 'demo'], ['render', 'demo', '--preview'],
    ['render', 'demo', '--cloud'], ['finish', 'demo', '--no-publish'],
    ['finish', 'demo', '--cloud'], ['build', 'demo', '--no-publish'],
    ['build', 'demo', '--cloud'], ['plan', 'build', 'demo', '--no-publish'],
    ['share', 'demo'], ['bg', 'demo', 'black'],
  ];
  for (const args of commands) {
    const result = await run(dir, args, { OPENAI_API_KEY: 'voice-only', SPOOL_ENGINE: 'local' });
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /A Spool API key is required/, args.join(' '));
    assert.match(result.stderr, /spool login/);
    assert.doesNotMatch(result.stderr, /voice-only/);
  }
  assert.deepEqual(await readdir(dir), []);
});

test('blank, malformed config and non-string credentials cannot satisfy the gate', async (t) => {
  const dir = await fixture(t);
  for (const contents of ['{bad json', '{"token":false}', '{"token":42}', '{"token":"   "}']) {
    await writeFile(join(dir, '.spool.json'), contents);
    const result = await run(dir, ['build', 'demo', '--no-publish']);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /A Spool API key is required/);
  }
});

test('saved and environment credentials allow local work without a network request', async (t) => {
  const dir = await fixture(t);
  const secret = 'spk_test-never-print';
  for (const source of ['env', 'saved']) {
    await writeFile(join(dir, '.spool.json'), JSON.stringify(source === 'saved' ? { token: secret } : {}));
    const result = await run(dir, ['build', 'demo', '--no-publish'],
      source === 'env' ? { SPOOL_PUBLISH_TOKEN: secret } : {});
    assert.equal(result.code, 1); // Expected downstream error: no authored steps.
    assert.match(result.stderr, /No steps\.mjs/);
    assert.doesNotMatch(result.stderr, /API key is required|spk_test-never-print/);
  }
  const blankOverride = await run(dir, ['build', 'demo'], { SPOOL_PUBLISH_TOKEN: '   ' });
  assert.match(blankOverride.stderr, /API key is required/);
});

test('explicit token on bg is honored', async (t) => {
  const dir = await fixture(t);
  const result = await run(dir, ['bg', 'demo', 'black', '--token', 'spk_explicit']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /\[bg\]/);
  assert.doesNotMatch(result.stderr, /API key is required|spk_explicit/);
});

test('help, setup and drafting remain usable without a key', async (t) => {
  const dir = await fixture(t);
  for (const args of [['--help'], ['build', '--help'], ['plan', 'build', '--help'], ['login', '--help'], ['doctor', '--help'], ['setup', '--show'], ['init', 'example'], ['plan', 'init', 'proposal', '--goal', 'Test drafting']]) {
    const result = await run(dir, args);
    assert.equal(result.code, 0, result.stdout + result.stderr);
  }
  const validation = await run(dir, ['plan', 'validate', 'spool/proposal']);
  assert.equal(validation.code, 0, validation.stdout + validation.stderr);
});
