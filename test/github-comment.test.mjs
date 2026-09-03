// The plan comment on a pull request (roadmap R5.2): what it says, and the rule that
// keeps a pull request to exactly one of them.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';

import { commentMarker, markerKey, renderPlanComment, upsertPlanComment } from '../src/github/comment.mjs';
import { parseGitHubRef } from '../src/github/refs.mjs';

const facts = (over = {}) => ({
  key: 'sp_abcdefghijklmnop12',
  goal: 'Add timestamped questions to a published spool.',
  status: 'awaiting_decision',
  revision: 2,
  decision: { type: 'approval', prompt: 'Approve the anchored-comment approach.', options: ['approve', 'redirect'] },
  watch: 'https://spool.test/l/sp_abcdefghijklmnop12',
  branch: 'spl/spl-12',
  commit: '0123456789abcdef0123456789abcdef01234567',
  openQuestions: 2,
  ...over,
});

test('the comment carries the plan state, the decision, the source revision and the link', () => {
  const body = renderPlanComment(facts());
  assert.match(body, /^<!-- spool-plan:sp_abcdefghijklmnop12 -->/);
  assert.match(body, /awaiting decision/);
  assert.match(body, /Add timestamped questions/);
  assert.match(body, /Approve the anchored-comment approach/);
  assert.match(body, /`approve`, `redirect`/);
  assert.match(body, /`spl\/spl-12` @ `0123456`/, 'the source revision is the packet branch and a short SHA');
  assert.match(body, /Revision: 2/);
  assert.match(body, /Open questions: 2/);
  assert.match(body, /\[Watch the plan\]\(https:\/\/spool\.test\/l\/sp_abcdefghijklmnop12\)/);
  // Compact: a pointer to the plan, not a copy of it.
  assert.ok(body.split('\n').length <= 16, `the comment grew to ${body.split('\n').length} lines`);
});

test('a decided plan reports the decision instead of asking for one', () => {
  const body = renderPlanComment(facts({ status: 'approved', decisionMade: { action: 'approve', optionId: null, notes: 'rename the flag first' } }));
  assert.match(body, /\*\*Decided:\*\* approve/);
  assert.match(body, /rename the flag first/);
  assert.doesNotMatch(body, /Decision needed/);
});

test('a stale plan says so in the comment, with the reason', () => {
  const stale = { status: 'stale', why: [{ code: 'branch-moved', detail: 'master is 14 commit(s) past 0123456 (tolerance 10)' }] };
  assert.match(renderPlanComment(facts({ stale })), /\*\*Stale:\*\* master is 14 commit\(s\) past/);

  const unknown = { status: 'unknown', why: [{ code: 'unpinned', detail: 'links.commit is empty' }] };
  assert.match(renderPlanComment(facts({ stale: unknown })), /Staleness: unknown — links\.commit is empty/);

  const fresh = { status: 'fresh', why: [] };
  assert.doesNotMatch(renderPlanComment(facts({ stale: fresh })), /Stale/);
});

test('a plan whose status could not be read still posts what it knows, and says what it does not', () => {
  const body = renderPlanComment(facts({ status: 'unknown', revision: null, error: 'the decision status could not be read (host unreachable)' }));
  assert.match(body, /Plan spool — unknown/);
  assert.match(body, /Note: the decision status could not be read/);
  assert.match(body, /Add timestamped questions/);
});

test('a linked issue and task appear as links a reviewer can follow', () => {
  const body = renderPlanComment(facts({
    issue: parseGitHubRef('https://github.com/acme/coach/issues/12'),
    task: 'https://linear.app/acme/issue/SPL-102',
  }));
  assert.match(body, /\[Issue acme\/coach#12\]\(https:\/\/github\.com\/acme\/coach\/issues\/12\)/);
  assert.match(body, /\[Task\]\(https:\/\/linear\.app\/acme\/issue\/SPL-102\)/);
});

test('the marker is what makes the comment findable again', () => {
  assert.equal(markerKey(commentMarker('sp_x') + '\nbody'), 'sp_x');
  assert.equal(markerKey('an ordinary review comment'), null);
});

// --- the upsert rule --------------------------------------------------------

/** A pull request whose comment list starts as `comments`. */
function conversation(comments = []) {
  const state = { comments: [...comments], writes: [] };
  const api = {
    listComments: async () => state.comments,
    createComment: async (_gh, { body }) => {
      const c = { id: state.comments.length + 1, body, html_url: `https://github.test/c/${state.comments.length + 1}` };
      state.comments.push(c);
      state.writes.push(['create', body]);
      return c;
    },
    updateComment: async (_gh, { id, body }) => {
      state.comments = state.comments.map((c) => (c.id === id ? { ...c, body } : c));
      state.writes.push(['update', body]);
      return state.comments.find((c) => c.id === id);
    },
  };
  return { state, api };
}

const upsert = (api, body, keys = ['sp_1']) =>
  upsertPlanComment(null, { owner: 'acme', name: 'coach', number: 57, keys, body, api });

test('the first run posts a comment; the second updates it in place', async () => {
  const { state, api } = conversation([{ id: 9, body: 'a human review comment' }]);

  const first = await upsert(api, `${commentMarker('sp_1')}\nv1`);
  assert.equal(first.action, 'created');
  assert.equal(state.comments.length, 2);

  const second = await upsert(api, `${commentMarker('sp_1')}\nv2`);
  assert.equal(second.action, 'updated');
  assert.equal(state.comments.length, 2, 'a second comment would be spam');
  assert.match(state.comments[1].body, /v2/);
  assert.deepEqual(state.writes.map((w) => w[0]), ['create', 'update']);
});

test('an unchanged comment is not written at all', async () => {
  const body = `${commentMarker('sp_1')}\nsame`;
  const { state, api } = conversation([{ id: 4, body }]);
  const res = await upsert(api, body);
  assert.equal(res.action, 'unchanged');
  assert.deepEqual(state.writes, [], 'nothing was written, so nobody was notified');
});

test('a plan that commented before it was published finds its own comment afterwards', async () => {
  // Before publishing the marker is the workdir slug; after, the spool id. Both keys
  // resolve to the same comment, or the pull request collects one per run.
  const { state, api } = conversation([{ id: 3, body: `${commentMarker('add-questions')}\ndraft` }]);
  const res = await upsertPlanComment(null, {
    owner: 'acme',
    name: 'coach',
    number: 57,
    keys: ['sp_new', 'add-questions'],
    body: `${commentMarker('sp_new')}\npublished`,
    api,
  });
  assert.equal(res.action, 'updated');
  assert.equal(state.comments.length, 1);
  assert.equal(markerKey(state.comments[0].body), 'sp_new', 'the comment is re-keyed to the published id');
});

test('another plan on the same pull request gets its own comment', async () => {
  const { state, api } = conversation([{ id: 3, body: `${commentMarker('sp_other')}\nanother plan` }]);
  const res = await upsert(api, `${commentMarker('sp_1')}\nmine`, ['sp_1']);
  assert.equal(res.action, 'created');
  assert.equal(state.comments.length, 2);
});
