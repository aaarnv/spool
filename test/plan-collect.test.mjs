// Evidence adapters (R5.3): the rules that decide what a collector may publish.
//
// The adapters are pure, so everything here runs with no repository, no browser
// and no shell — including the adversarial redaction battery, which is the point
// of the whole module: a collector reads REAL command output, and real command
// output is where credentials live.

import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  CONSOLE_MAX_EVENTS,
  DIFF_MAX_FILES,
  KEYFRAME_MAX,
  commitEvidence,
  consoleEvidence,
  diffEvidence,
  evidenceId,
  keyframeEvidence,
  mergeEvidence,
  testEvidence,
} from '../src/plan/collect.mjs';
import {
  EVIDENCE_MAX_ITEMS,
  EVIDENCE_MAX_TOTAL_CHARS,
  EXCERPT_MAX_CHARS,
  EXCERPT_MAX_LINES,
  SUMMARY_MAX_CHARS,
  boundExcerptTail,
  boundSummary,
  redact,
  resolveEvidenceItem,
} from '../src/plan/evidence.mjs';
import { validateEvidence, validatePacket as validatePacketFn } from '../src/plan/schema.mjs';
import { evidenceCmd, formatEvidenceReport } from '../src/plan/collect-cmd.mjs';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const only = (result) => {
  assert.equal(result.items.length >= 1, true, 'expected at least one descriptor');
  return result.items[0];
};

// Every collected bundle must pass the same gate `spool plan validate` runs: a
// descriptor the packet layer rejects is a file the author has to repair by hand.
const assertValid = (items) => {
  const res = validateEvidence({ version: 1, kind: 'evidence', items });
  assert.deepEqual(res.errors, [], `collected descriptors must validate: ${JSON.stringify(res.errors)}`);
};

// --- changed files and diffs ------------------------------------------------

test('a diff collector attaches one descriptor per changed file, pinned to the commit', () => {
  const { items, total, dropped } = diffEvidence({
    files: [
      { path: 'web/lib/plans.ts', status: 'M', insertions: 42, deletions: 7, patch: '@@ -1 +1 @@\n-old\n+new' },
      { path: 'src/plan/collect.mjs', status: 'A', insertions: 300, deletions: 0, patch: '@@ -0,0 +1 @@\n+hello' },
    ],
    revision: 'abc1234def5678',
    chapterIds: ['approach'],
  });
  assert.equal(items.length, 2);
  assert.equal(total, 2);
  assert.equal(dropped, 0);
  // Biggest change first: the 300-line addition outranks the 49-line edit.
  assert.equal(items[0].kind, 'file');
  assert.equal(items[0].ref, 'src/plan/collect.mjs');
  assert.equal(items[1].ref, 'web/lib/plans.ts');
  assert.equal(items[0].revision, 'abc1234def5678');
  assert.match(items[1].summary, /Changed web\/lib\/plans\.ts \(\+42 −7\)/);
  assert.match(items[0].summary, /^Added src\/plan\/collect\.mjs/);
  assert.deepEqual(items[0].chapterIds, ['approach']);
  assert.equal(items[1].excerpt.includes('+new'), true);
  assertValid(items);
});

test('the diff cap keeps the biggest changes, not the first paths in the alphabet', () => {
  // 20 small edits early in the alphabet, and 3 big ones late. An alphabetical cap
  // publishes twelve one-line edits and drops every file the plan is actually about.
  const files = [
    ...Array.from({ length: 20 }, (_, i) => ({
      path: `a/small${String(i).padStart(2, '0')}.ts`,
      status: 'M',
      insertions: 1,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+one line',
    })),
    { path: 'z/huge.ts', status: 'M', insertions: 900, deletions: 12, patch: '@@ -1 +1 @@\n+big' },
    { path: 'z/large.ts', status: 'M', insertions: 300, deletions: 0, patch: '@@ -1 +1 @@\n+large' },
    { path: 'z/medium.ts', status: 'M', insertions: 80, deletions: 4, patch: '@@ -1 +1 @@\n+medium' },
  ];
  const { items, total, dropped } = diffEvidence({ files });
  assert.equal(total, 23);
  assert.equal(items.length, DIFF_MAX_FILES);
  assert.equal(dropped, 23 - DIFF_MAX_FILES);
  assert.deepEqual(items.slice(0, 3).map((i) => i.ref), ['z/huge.ts', 'z/large.ts', 'z/medium.ts']);
});

test('a file git gave no line counts for is ranked by the lines its own patch changes', () => {
  // An untracked file and a binary one both come back with null counts. Ranking them
  // at zero would drop a new 200-line module in favour of a one-line edit.
  const files = [
    ...Array.from({ length: DIFF_MAX_FILES }, (_, i) => ({
      path: `a/tiny${String(i).padStart(2, '0')}.ts`,
      status: 'M',
      insertions: 2,
      deletions: 0,
      patch: '@@ -1 +1 @@\n+one\n+two',
    })),
    {
      path: 'z/new-module.ts',
      status: '?',
      insertions: null,
      deletions: null,
      patch: ['@@ -0,0 +1,200 @@', ...Array.from({ length: 200 }, (_, n) => `+line ${n}`)].join('\n'),
    },
  ];
  const { items } = diffEvidence({ files });
  assert.equal(items[0].ref, 'z/new-module.ts');
});

test('a diff excerpt is bounded, and the files a cap drops are counted, never silent', () => {
  const files = Array.from({ length: DIFF_MAX_FILES + 9 }, (_, i) => ({
    path: `src/file${i}.ts`,
    status: 'M',
    insertions: 1,
    deletions: 0,
    patch: Array.from({ length: 400 }, (_, n) => `+line ${n} ${'x'.repeat(40)}`).join('\n'),
  }));
  const { items, total, dropped } = diffEvidence({ files });
  assert.equal(items.length, DIFF_MAX_FILES);
  assert.equal(total, DIFF_MAX_FILES + 9);
  assert.equal(dropped, 9);
  for (const item of items) {
    assert.equal(item.excerpt.split('\n').length <= EXCERPT_MAX_LINES, true);
    assert.equal(item.excerpt.length <= EXCERPT_MAX_CHARS, true);
  }
});

test('a binary file with no line counts still gets an honest summary', () => {
  const item = only(diffEvidence({ files: [{ path: 'docs/shot.png', status: 'M', insertions: null, deletions: null }] }));
  assert.equal(item.summary, 'Changed docs/shot.png.');
  assert.equal(item.excerpt, undefined);
});

// --- commit and branch ------------------------------------------------------

test('a commit descriptor pins to the SHA and publishes the branch as text', () => {
  const item = only(commitEvidence({
    sha: 'b2271411e59385d8fe92a79a033b4f0059edbd5c',
    branch: 'spl/spl-32',
    subject: 'Add evidence adapters',
    changedFiles: ['a.ts', 'b.ts'],
  }));
  assert.equal(item.kind, 'commit');
  assert.equal(item.ref, 'b2271411e59385d8fe92a79a033b4f0059edbd5c');
  assert.match(item.summary, /Branch spl\/spl-32 at b227141: Add evidence adapters — 2 changed files\./);
  assert.equal(item.excerpt, 'a.ts\nb.ts');
  assertValid([item]);
});

test('a branch name is never published as a commit ref', () => {
  assert.deepEqual(commitEvidence({ sha: 'main', branch: 'main' }).items, []);
  assert.deepEqual(commitEvidence({ sha: null }).items, []);
});

// --- test runs --------------------------------------------------------------

test('a test descriptor carries the command, the verdict and the duration', () => {
  const item = only(testEvidence({ command: 'npm test', exitCode: 0, durationMs: 4210, output: 'pass 292\n' }));
  assert.equal(item.kind, 'test');
  assert.equal(item.ref, 'npm test');
  assert.equal(item.summary, 'npm test passed (exit 0) in 4.2 s.');
  assertValid([item]);

  const failed = only(testEvidence({ command: 'npm test', exitCode: 1, durationMs: 900, output: 'fail 3\n' }));
  assert.equal(failed.summary, 'npm test failed (exit 1) in 0.9 s.');
});

test('a test excerpt keeps the TAIL, because that is where the result is', () => {
  const output = [...Array.from({ length: 200 }, (_, i) => `setup line ${i}`), 'FAIL: expected 3, got 4', 'tests 200 fail 1'].join('\n');
  const item = only(testEvidence({ command: 'npm test', exitCode: 1, durationMs: 10, output }));
  assert.equal(item.excerpt.includes('tests 200 fail 1'), true, 'the totals line must survive');
  assert.equal(item.excerpt.includes('FAIL: expected 3, got 4'), true);
  assert.equal(item.excerpt.includes('setup line 0'), false, 'the head is what gets dropped');
  assert.equal(item.excerpt.split('\n').length <= EXCERPT_MAX_LINES, true);
});

test('a command that never ran produces no descriptor', () => {
  assert.deepEqual(testEvidence({ command: '   ' }).items, []);
});

test('a multi-line command is flattened, because a console ref is one line', () => {
  const item = only(testEvidence({ command: 'npm test\nrm -rf /', exitCode: 0, output: '' }));
  assert.equal(item.ref.includes('\n'), false);
  assertValid([item]);
});

// --- browser console --------------------------------------------------------

const CONSOLE_EVENTS = [
  { t: 1.2, kind: 'console', level: 'log', text: 'hydrated' },
  { t: 3.4, kind: 'pageerror', text: 'TypeError: x is undefined' },
  { t: 3.9, kind: 'console', level: 'warning', text: 'deprecated prop' },
  { t: 5.0, kind: 'requestfailed', text: 'GET /api/plans net::ERR_FAILED' },
  { t: 6.1, kind: 'console', level: 'error', text: 'render failed' },
];

test('the console collector counts errors by kind and quotes the first of them', () => {
  const built = consoleEvidence({ command: 'spool record spool/demo', events: CONSOLE_EVENTS });
  const item = only(built);
  assert.equal(built.errors, 3);
  assert.equal(built.warnings, 1);
  assert.equal(item.kind, 'console');
  assert.equal(item.summary, 'The recording logged 1 page error, 1 failed request, 1 console error (1 warning) over 5 events.');
  assert.equal(item.excerpt.startsWith('[3.40s] pageerror: TypeError: x is undefined'), true);
  assert.equal(item.excerpt.includes('hydrated'), false, 'an ordinary log is not an error');
  assertValid([item]);
});

test('a clean console is evidence too', () => {
  const item = only(consoleEvidence({ command: 'spool record spool/demo', events: [{ t: 1, kind: 'console', level: 'log', text: 'ok' }] }));
  assert.equal(item.summary, 'The recording logged no errors and no failed requests over 1 event (0 warnings).');
  assert.equal(item.excerpt, undefined);
  // Plain language alone makes a descriptor readable, so it publishes available.
  assert.equal(resolveEvidenceItem(item).status, 'available');
});

test('a flood of console errors is bounded', () => {
  const events = Array.from({ length: 400 }, (_, i) => ({ t: i, kind: 'pageerror', text: `error ${i}` }));
  const item = only(consoleEvidence({ command: 'spool record spool/demo', events }));
  assert.equal(item.excerpt.split('\n').length <= Math.min(CONSOLE_MAX_EVENTS, EXCERPT_MAX_LINES), true);
  assert.match(item.summary, /400 page errors/);
});

// --- keyframes and the recorded URL -----------------------------------------

test('keyframes become bundled image descriptors anchored to their chapter', () => {
  const { items } = keyframeEvidence({
    frames: [
      { ref: 'spool/demo/keyframes/step_00.png', step: 0, name: 'open the plan', chapterId: 'context' },
      { ref: 'spool/demo/keyframes/step_01.png', step: 1, name: 'decide', chapterId: 'decision' },
    ],
    url: 'https://app.example.com/plans',
  });
  assert.equal(items.length, 3);
  assert.equal(items[0].kind, 'image');
  assert.deepEqual(items[0].chapterIds, ['context']);
  assert.equal(items[0].label, 'Step 0: open the plan');
  assert.equal(items[2].id, 'ev-recorded-url');
  assert.equal(items[2].visibility, undefined, 'a public host is not withheld');
  assertValid(items);
});

test('a keyframe never gets a repository permalink, because it is not in the repository', () => {
  const item = only(keyframeEvidence({ frames: [{ ref: 'spool/demo/keyframes/step_00.png', step: 0 }] }));
  const links = { repo: 'aaarnv/spool', commit: 'b2271411e59385d8fe92a79a033b4f0059edbd5c' };
  assert.equal(resolveEvidenceItem(item, { links, exists: true, bundled: true }).url, null);
  // Without the bundled fact the same descriptor WOULD get a link — which is
  // exactly the lie resolveRefs exists to prevent.
  assert.notEqual(resolveEvidenceItem(item, { links, exists: true }).url, null);
});

test('a dev-server URL is published as withheld, not as a dead link', () => {
  const { items } = keyframeEvidence({ frames: [], url: 'http://localhost:4747/plans' });
  assert.equal(items[0].visibility, 'private');
  assert.equal(items[0].summary, undefined, 'a private descriptor publishes its label only');
  assertValid(items);
  const published = resolveEvidenceItem(items[0]);
  assert.equal(published.status, 'private');
  assert.equal(published.ref, null);
});

test('the keyframe budget prefers frames a chapter anchors', () => {
  const frames = [
    ...Array.from({ length: KEYFRAME_MAX + 4 }, (_, i) => ({ ref: `spool/demo/keyframes/step_${i}.png`, step: i })),
    { ref: 'spool/demo/keyframes/step_99.png', step: 99, chapterId: 'risks' },
  ];
  const { items, total, dropped } = keyframeEvidence({ frames });
  assert.equal(items.length, KEYFRAME_MAX);
  assert.equal(total, KEYFRAME_MAX + 5);
  assert.equal(dropped, 5);
  assert.equal(items.some((i) => i.chapterIds?.[0] === 'risks'), true);
});

// --- redaction: the adversarial battery -------------------------------------

// Real command output is where credentials live. Each entry is a shape a
// collector could read; NONE of them may survive into a descriptor.
const SECRETS = [
  ['github token', 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
  ['github pat', 'github_pat_11ABCDEFG0abcdefghijklmnop'],
  ['openai key', 'sk-proj-abcdefghijklmnopqrstuvwxyz012345'],
  ['stripe key', 'sk_live_abcdefghijklmnopqrstuvwx'],
  ['slack token', 'xoxb-123456789012-abcdefghijkl'],
  ['aws key id', 'AKIAIOSFODNN7EXAMPLE'],
  ['google key', 'AIzaSyA0abcdefghijklmnopqrstuvwxyz012345'],
  ['npm token', 'npm_abcdefghijklmnopqrstuvwxyz0123456789'],
  ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N'],
];

const ASSIGNMENTS = [
  ['aws secret', 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMIK7MDENGbPxRfiCYEXAMPLEKEY'],
  ['app token', 'MY_APP_TOKEN=abcdef123456ghijkl', 'abcdef123456ghijkl'],
  ['password flag', 'psql --password=hunter2trombone', 'hunter2trombone'],
  ['bearer header', 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz', 'abcdefghijklmnopqrstuvwxyz'],
  ['url userinfo', 'https://admin:hunter2@db.example.com/spool', 'hunter2'],
  ['private key', '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA0Z\n-----END RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA0Z'],
  ['home directory', '/Users/aarnav/Projects/spool/.env', 'aarnav'],
  // Space-separated credentials: a CLI flag, a positional argument, a config file
  // written key-space-value. Nothing anchors the value, so these are the forms an
  // `=`/`:` rule reads straight past.
  ['aws secret, space-separated', 'aws_secret_access_key wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY'],
  ['aws secret, upper-case and space-separated', 'AWS_SECRET_ACCESS_KEY wJalrXUtnFEMI7MDENGbPxRfiCYEX', 'wJalrXUtnFEMI7MDENGbPxRfiCYEX'],
  ['token flag', 'spool publish --token 8f3ac21b9e40d5f67a1c', '8f3ac21b9e40d5f67a1c'],
  ['password argument', 'mysql -u root --password s3cret-trombone-42', 's3cret-trombone-42'],
  ['client secret argument', 'client_secret 9d8c7b6a5e4f3a2b1c0d', '9d8c7b6a5e4f3a2b1c0d'],
  ['api key in a config line', 'api_key  4f8a1c9e2b7d6035ae11', '4f8a1c9e2b7d6035ae11'],
];

// The other half of the rule. A space-separated matcher with no guard on the VALUE
// eats the next word of every sentence that says "password", which would rewrite
// the excerpt a reviewer reads. These must survive untouched.
const PROSE = [
  'the password is required before the staging replica accepts a connection',
  'secret handshake between the two services, documented in the runbook',
  'rotate the api_key whenever a contractor leaves',
  'set the client_secret to whatever the operator chose',
];

const ALL = [...SECRETS.map(([n, s]) => [n, s, s]), ...ASSIGNMENTS];

for (const [name, payload, needle] of ALL) {
  test(`a ${name} in test output never reaches a descriptor`, () => {
    const item = only(testEvidence({ command: `npm test`, exitCode: 1, durationMs: 5, output: `FAIL\n${payload}\ndone` }));
    assert.equal(JSON.stringify(item).includes(needle), false, `"${needle}" survived into ${JSON.stringify(item)}`);
    // The line was MASKED, not dropped: a reviewer must still see that the run
    // printed something there, or the excerpt quietly rewrites what happened.
    assert.equal(item.excerpt.includes('[redacted]'), true, 'the masked line must still be published');
    assert.equal(item.excerpt.includes('done'), true);
  });

  test(`a ${name} in a test COMMAND never reaches a descriptor`, () => {
    const item = only(testEvidence({ command: `${payload.split('\n')[0]} npm test`, exitCode: 0, output: '' }));
    assert.equal(JSON.stringify(item).includes(needle), false, `"${needle}" survived into the ref/label/summary`);
  });

  test(`a ${name} in a console event never reaches a descriptor`, () => {
    const item = only(consoleEvidence({
      command: 'spool record spool/demo',
      events: [{ t: 1, kind: 'pageerror', text: `boom ${payload}` }],
    }));
    assert.equal(JSON.stringify(item).includes(needle), false, `"${needle}" survived into the console excerpt`);
  });

  test(`a ${name} in a diff hunk never reaches a descriptor`, () => {
    const item = only(diffEvidence({ files: [{ path: '.env.example', status: 'M', insertions: 1, deletions: 0, patch: `@@ -1 +1 @@\n+${payload}` }] }));
    assert.equal(JSON.stringify(item).includes(needle), false, `"${needle}" survived into the diff excerpt`);
  });
}

for (const line of PROSE) {
  test(`prose survives redaction unchanged: "${line.slice(0, 40)}…"`, () => {
    const out = redact(line);
    assert.equal(out.redacted, false, `redaction rewrote prose: ${out.text}`);
    assert.equal(out.text, line);
  });
}

test('a secret in a changed FILE PATH never reaches a descriptor', () => {
  const item = only(diffEvidence({ files: [{ path: 'config/token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345.json', status: 'A' }] }));
  assert.equal(JSON.stringify(item).includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), false);
});

test('a commit subject carrying a credential is redacted', () => {
  const item = only(commitEvidence({ sha: 'abc1234', subject: 'rotate GH_TOKEN=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345' }));
  assert.equal(JSON.stringify(item).includes('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), false);
});

// --- bounding ---------------------------------------------------------------

test('a summary is one bounded line, whatever it was built from', () => {
  const bounded = boundSummary(`first\nsecond   third ${'x'.repeat(500)}`);
  assert.equal(bounded.text.includes('\n'), false);
  assert.equal(bounded.text.length <= SUMMARY_MAX_CHARS, true);
  assert.equal(bounded.truncated, true);
  assert.equal(boundSummary('  '), null);
});

test('a tail-bounded excerpt reports that it dropped the head', () => {
  const bounded = boundExcerptTail(Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n'));
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.text.includes('line 59'), true);
  assert.equal(bounded.text.includes('line 0\n'), false);
});

test('a summary on a private descriptor is refused by the validator', () => {
  const res = validateEvidence({
    version: 1,
    kind: 'evidence',
    items: [{ id: 'ev-x', kind: 'url', label: 'Internal dashboard', ref: 'http://localhost:3000', visibility: 'private', summary: 'It showed 0 errors.' }],
  });
  assert.equal(res.ok, false);
  assert.equal(res.errors.some((e) => e.code === 'private-summary'), true);
});

test('a bundle over the per-plan caps warns rather than failing silently', () => {
  const many = Array.from({ length: EVIDENCE_MAX_ITEMS + 1 }, (_, i) => ({
    id: `ev-${i}`, kind: 'file', label: `File ${i}`, ref: `src/f${i}.ts`,
  }));
  const res = validateEvidence({ version: 1, kind: 'evidence', items: many });
  assert.equal(res.ok, true);
  assert.equal(res.warnings.some((w) => w.code === 'too-many-evidence'), true);

  const fat = [{ id: 'ev-fat', kind: 'file', label: 'Fat', ref: 'a.ts', excerpt: 'x'.repeat(EVIDENCE_MAX_TOTAL_CHARS + 1) }];
  assert.equal(validateEvidence({ version: 1, kind: 'evidence', items: fat }).warnings.some((w) => w.code === 'evidence-too-large'), true);
});

// --- merging ----------------------------------------------------------------

test('re-collecting replaces a descriptor in place, so a claim keeps citing it', () => {
  const first = mergeEvidence(null, testEvidence({ command: 'npm test', exitCode: 1, durationMs: 100, output: 'fail' }).items);
  assert.deepEqual(first.added, ['ev-test-npm-test']);

  const second = mergeEvidence(first.evidence, testEvidence({ command: 'npm test', exitCode: 0, durationMs: 200, output: 'pass' }).items);
  assert.deepEqual(second.added, []);
  assert.deepEqual(second.replaced, ['ev-test-npm-test']);
  assert.equal(second.evidence.items.length, 1);
  assert.match(second.evidence.items[0].summary, /passed \(exit 0\)/);
});

test('a hand-authored descriptor is never removed by a collector', () => {
  const authored = { version: 1, kind: 'evidence', items: [{ id: 'ev-askpanel', kind: 'file', label: 'AskPanel', ref: 'web/AskPanel.tsx' }] };
  const merged = mergeEvidence(authored, diffEvidence({ files: [{ path: 'a.ts', status: 'M' }] }).items);
  assert.equal(merged.evidence.items[0].id, 'ev-askpanel');
  assert.equal(merged.evidence.items.length, 2);
});

test('the per-plan caps refuse a descriptor and say which one', () => {
  const full = {
    version: 1,
    kind: 'evidence',
    items: Array.from({ length: EVIDENCE_MAX_ITEMS }, (_, i) => ({ id: `ev-${i}`, kind: 'file', label: `F${i}`, ref: `f${i}.ts` })),
  };
  const merged = mergeEvidence(full, diffEvidence({ files: [{ path: 'late.ts', status: 'M' }] }).items);
  assert.equal(merged.added.length, 0);
  assert.equal(merged.skipped.length, 1);
  assert.match(merged.skipped[0].reason, /already carries 40 descriptors/);

  const chars = mergeEvidence(
    { version: 1, kind: 'evidence', items: [{ id: 'ev-big', kind: 'file', label: 'Big', ref: 'b.ts', excerpt: 'x'.repeat(EVIDENCE_MAX_TOTAL_CHARS) }] },
    diffEvidence({ files: [{ path: 'late.ts', status: 'M', patch: '@@\n+one' }] }).items
  );
  assert.equal(chars.added.length, 0);
  assert.match(chars.skipped[0].reason, /exceed 24000 chars/);
});

// --- where collected evidence belongs --------------------------------------

test('every collector anchors its evidence to a chapter by default', () => {
  assert.deepEqual(diffEvidence({ files: [{ path: 'a.ts', status: 'M' }] }).items[0].chapterIds, ['approach']);
  assert.deepEqual(commitEvidence({ sha: 'abc1234' }).items[0].chapterIds, ['context']);
  assert.deepEqual(testEvidence({ command: 'npm test', exitCode: 0 }).items[0].chapterIds, ['outcome']);
  assert.deepEqual(consoleEvidence({ command: 'spool record x', events: [] }).items[0].chapterIds, ['risks']);
  assert.deepEqual(keyframeEvidence({ frames: [{ ref: 'spool/d/k/step_00.png', step: 0 }] }).items[0].chapterIds, ['outcome']);
  assert.deepEqual(keyframeEvidence({ frames: [], url: 'https://app.example.com' }).items[0].chapterIds, ['context']);
});

test('--chapter overrides the default for the whole run', () => {
  const item = only(diffEvidence({ files: [{ path: 'a.ts', status: 'M' }], chapterIds: ['risks'] }));
  assert.deepEqual(item.chapterIds, ['risks']);
});

test('a collected packet passes --strict without citing every descriptor', () => {
  // A descriptor earns its place by backing a claim OR by naming a chapter, so a
  // run that attaches twelve diffs does not force twelve citations. An unanchored,
  // uncited descriptor is still decoration, and still warns.
  const collected = diffEvidence({ files: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] }).items;
  const res = validatePacketWithPlan(collected);
  assert.deepEqual(res.warnings.filter((w) => w.code === 'unused-evidence'), []);

  const loose = validatePacketWithPlan([{ id: 'ev-loose', kind: 'file', label: 'Loose', ref: 'c.ts' }]);
  assert.equal(loose.warnings.some((w) => w.code === 'unused-evidence'), true);
});

function validatePacketWithPlan(items) {
  return validatePacketFn({
    plan: {
      version: 1,
      kind: 'plan',
      goal: 'Collect the proof behind the claims.',
      outcome: 'A reviewer sees what caused each claim.',
      approach: [{ id: 'collect', summary: 'Run the collectors.' }],
      risks: ['A collector could publish a credential.'],
      noAlternativesReason: 'The descriptor contract fixes the shape.',
      decision: { type: 'approval', prompt: 'Approve?', options: ['approve'] },
      links: {},
    },
    evidence: { version: 1, kind: 'evidence', items },
  });
}

test('a packet whose claims cite nothing at all warns once, at the packet level', () => {
  // The per-descriptor rule above is deliberately quiet for chapter-anchored items,
  // which left NOTHING asking an agent to connect a source to the sentence it backs.
  // This is the one warning that restores that pressure (SPL-39).
  const collected = diffEvidence({ files: [{ path: 'a.ts', status: 'M' }, { path: 'b.ts', status: 'M' }] }).items;
  const uncited = validatePacketWithPlan(collected).warnings.filter((w) => w.code === 'uncited-evidence');
  assert.equal(uncited.length, 1, 'exactly one warning for the whole packet');
  assert.equal(uncited[0].path, 'evidence.json:items');
  assert.match(uncited[0].message, /no claim cites any of them/);

  // One citation is enough to silence it: the agent has connected the two files.
  const cited = validatePacketFn({
    plan: {
      version: 1,
      kind: 'plan',
      goal: 'Collect the proof behind the claims.',
      outcome: 'A reviewer sees what caused each claim.',
      approach: [{ id: 'collect', summary: 'Run the collectors.', evidence: [collected[0].id] }],
      risks: ['A collector could publish a credential.'],
      noAlternativesReason: 'The descriptor contract fixes the shape.',
      decision: { type: 'approval', prompt: 'Approve?', options: ['approve'] },
      links: {},
    },
    evidence: { version: 1, kind: 'evidence', items: collected },
  });
  assert.equal(cited.warnings.some((w) => w.code === 'uncited-evidence'), false);

  // A packet with no evidence at all is not a packet that failed to cite it.
  const empty = validatePacketWithPlan([]);
  assert.equal(empty.warnings.some((w) => w.code === 'uncited-evidence'), false);
});

test('ids are stable for the same source and unique for different ones', () => {
  assert.equal(evidenceId('ev-diff', 'web/lib/plans.ts'), evidenceId('ev-diff', 'web/lib/plans.ts'));
  const taken = new Set(['ev-diff-lib-plans-ts']);
  assert.equal(evidenceId('ev-diff', 'web/lib/plans.ts', taken), 'ev-diff-lib-plans-ts-2');
  assert.match(evidenceId('ev-test', '!!!'), /^ev-test$/);
});

// --- the uncited-evidence warning -------------------------------------------

// Descriptors nothing cites are a folder of attachments: the reviewer reads them
// and still has to guess which sentence each one backs. The command says so once.

// A real packet, with its own citations stripped: the warning is about a VALID plan
// that cites nothing, and an invalid one is `spool plan validate`'s to report.
const PACKET = (evidence = []) => {
  const plan = JSON.parse(readFileSync(new URL('./fixtures/skill/new-feature/plan.json', import.meta.url), 'utf8'));
  const strip = (list) => (Array.isArray(list) ? list.map((i) => (i && typeof i === 'object' ? { ...i, evidence } : i)) : list);
  plan.currentState = strip(plan.currentState);
  plan.approach = strip(plan.approach);
  plan.risks = strip(plan.risks);
  plan.alternatives = strip(plan.alternatives);
  if (plan.decision && typeof plan.decision === 'object') plan.decision = { ...plan.decision, evidence };
  return plan;
};

async function evidenceWorkdir(t, plan) {
  const dir = await mkdtemp(join(tmpdir(), 'spool-evidence-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  await writeFile(
    join(dir, 'console.jsonl'),
    JSON.stringify({ t: 1, kind: 'pageerror', text: 'boom' }) + '\n'
  );
  return dir;
}

test('collecting evidence that no claim cites warns once', async (t) => {
  const dir = await evidenceWorkdir(t, PACKET([]));
  const result = await evidenceCmd(dir, { collectors: ['console'], dryRun: true });
  assert.equal(result.code, 0);
  const uncited = result.notes.filter((n) => n.collector === 'plan');
  assert.equal(uncited.length, 1, `expected exactly one note, got ${JSON.stringify(result.notes)}`);
  assert.equal(uncited[0].level, 'warn');
  assert.match(uncited[0].text, /no claim cites any of them/);
  assert.match(formatEvidenceReport(result), /! plan: evidence\.json declares 1 descriptor/);
});

test('a packet whose claim cites a descriptor draws no such warning', async (t) => {
  const dir = await evidenceWorkdir(t, PACKET(['ev-console']));
  const result = await evidenceCmd(dir, { collectors: ['console'], dryRun: true });
  assert.equal(result.code, 0);
  assert.equal(result.notes.some((n) => n.collector === 'plan'), false);
});
