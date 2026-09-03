// Issue and pull-request references in a plan packet (roadmap R5.2).
// The written forms are a contract: an agent writes them by hand, and the PR comment
// and the stale detector both act on what they mean.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GITHUB_URL_PATTERNS, checkLinkRef, formatRef, packetRefs, parseGitHubRef, parseRepo } from '../src/github/refs.mjs';
import { validatePlan } from '../src/plan/schema.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plan');
const minimal = () => JSON.parse(readFileSync(join(fixtures, 'valid-minimal.json'), 'utf8'));

test('every written form of a reference resolves to the same pull request', () => {
  const want = { owner: 'acme', name: 'coach', number: 57 };
  const forms = [
    ['https://github.com/acme/coach/pull/57', 'pull'],
    ['https://www.github.com/acme/coach/pull/57/files', 'pull'],
    ['HTTPS://GitHub.com/acme/coach/pull/57', 'pull'],
    ['acme/coach#57', null],
  ];
  for (const [input, kind] of forms) {
    const ref = parseGitHubRef(input);
    assert.deepEqual(
      { owner: ref?.owner, name: ref?.name, number: ref?.number },
      want,
      `${input} did not resolve to acme/coach#57`
    );
    assert.equal(ref.kind, kind, `${input} reported the wrong kind`);
  }
});

test('a bare number needs links.repo to become a link, and is still a reference without it', () => {
  const withRepo = parseGitHubRef('57', { repo: 'acme/coach' });
  assert.equal(withRepo.url, 'https://github.com/acme/coach/issues/57');
  assert.equal(formatRef(withRepo), 'acme/coach#57');

  const alone = parseGitHubRef('#57');
  assert.deepEqual({ owner: alone.owner, number: alone.number, url: alone.url }, { owner: null, number: 57, url: null });
  assert.equal(formatRef(alone), '#57');
});

test('an unknown kind links through /issues/, which GitHub redirects for a pull request', () => {
  // One link is right either way, so writing it costs no lookup.
  assert.equal(parseGitHubRef('acme/coach#57').url, 'https://github.com/acme/coach/issues/57');
  assert.equal(parseGitHubRef('https://github.com/acme/coach/pull/57').url, 'https://github.com/acme/coach/pull/57');
});

test('anything that is not a GitHub reference stays null rather than becoming a wrong link', () => {
  for (const input of ['SPL-102', 'https://linear.app/acme/issue/SPL-102', 'https://github.com/acme/coach', '', null, 'acme/coach#0']) {
    assert.equal(parseGitHubRef(input), null, `${JSON.stringify(input)} should not parse`);
  }
});

test('a repository slug is read from a slug, an https remote and an ssh remote', () => {
  for (const input of ['acme/coach', 'https://github.com/acme/coach', 'https://github.com/acme/coach.git', 'git@github.com:acme/coach.git']) {
    assert.deepEqual(parseRepo(input), { owner: 'acme', name: 'coach' }, input);
  }
  assert.equal(parseRepo('coach'), null);
});

// --- what the validator does with them --------------------------------------

test('an issue URL in links.pr is an error, and names where it belongs', () => {
  const problem = checkLinkRef('https://github.com/acme/coach/issues/57', 'pull');
  assert.equal(problem.code, 'wrong-github-kind');
  assert.equal(problem.level, 'error');
  assert.match(problem.message, /links\.issue/);

  const plan = minimal();
  plan.links = { repo: 'acme/coach', pr: 'https://github.com/acme/coach/issues/57' };
  const res = validatePlan(plan);
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors.map((e) => e.path), ['links.pr']);
});

test('a reference spool does not recognise warns, so a non-GitHub tracker still validates', () => {
  const plan = minimal();
  plan.links = { repo: 'acme/coach', pr: 'https://gitlab.com/acme/coach/-/merge_requests/5' };
  const res = validatePlan(plan);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.warnings.map((w) => w.code), ['unrecognized-github-ref']);
});

test('a pull-request URL in links.pr validates, in every accepted form', () => {
  for (const value of ['https://github.com/acme/coach/pull/57', 'acme/coach#57', '57']) {
    const plan = minimal();
    plan.links = { repo: 'acme/coach', pr: value };
    const res = validatePlan(plan);
    assert.equal(res.ok, true, `${value}: ${JSON.stringify(res.errors)}`);
    assert.deepEqual(res.warnings, [], `${value} should not warn`);
  }
});

test('a link still carrying the template marker is reported once, as a template warning', () => {
  const plan = minimal();
  plan.links = { repo: 'acme/coach', pr: 'TODO: the pull request this plan belongs to' };
  const res = validatePlan(plan);
  assert.equal(res.ok, true);
  assert.deepEqual(res.warnings.map((w) => w.code), ['unedited-template']);
});

test('packetRefs collects the links a tool can act on, and drops the ones it cannot', () => {
  const refs = packetRefs({
    repo: 'acme/coach',
    pr: '57',
    issue: 'https://github.com/acme/coach/issues/12',
    task: 'SPL-102',
  });
  assert.equal(refs.pr.number, 57);
  assert.equal(refs.issue.url, 'https://github.com/acme/coach/issues/12');
  assert.equal(refs.task, undefined, 'a task key is not a GitHub reference');

  // A GitHub issue in links.task is one: a team that tracks work in GitHub writes it
  // there, and the PR comment can then link it.
  assert.equal(packetRefs({ task: 'https://github.com/acme/coach/issues/12' }).task.number, 12);
});

test('the JSON Schema mirror carries the same wrong-kind rule as the validator', () => {
  const schema = JSON.parse(readFileSync(join(fixtures, '..', '..', '..', 'src', 'plan', 'plan.schema.json'), 'utf8'));
  const pr = schema.properties.links.properties.pr;
  const issue = schema.properties.links.properties.issue;
  assert.equal(pr.anyOf[0].allOf[1].not.pattern, GITHUB_URL_PATTERNS.issue);
  assert.equal(issue.anyOf[0].allOf[1].not.pattern, GITHUB_URL_PATTERNS.pull);
  // And the patterns must actually match what the validator rejects.
  assert.equal(new RegExp(GITHUB_URL_PATTERNS.issue).test('https://github.com/acme/coach/issues/57'), true);
  assert.equal(new RegExp(GITHUB_URL_PATTERNS.issue).test('https://github.com/acme/coach/pull/57'), false);
});
