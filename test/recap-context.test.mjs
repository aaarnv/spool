import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveUnderstanding, normalizeRecapContext, renderRecapContext } from '../src/recap/context.mjs';

test('recap context is bounded and area matching becomes structured understanding', () => {
  const context = normalizeRecapContext({ overview: { text: 'Billing handles money movement.' }, areas: [{ id: 'area-1', name: 'Billing', summary: 'Invoices and settlement.', pathPatterns: ['src/billing/**'] }] });
  assert.match(renderRecapContext(context), /Billing/);
  const understanding = deriveUnderstanding({ pr: { repo: 'acme/pay', number: 42, title: 'Retry settlement', url: 'https://github.com/acme/pay/pull/42', files: [{ path: 'src/billing/retry.ts' }] }, beats: [{ narration: 'Settlements were dropped.' }, { narration: 'The worker retries them.' }, { narration: 'Retries are now idempotent.' }], context });
  assert.deepEqual(understanding.areaIds, ['area-1']);
  assert.equal(understanding.consequence, 'Retries are now idempotent.');
  assert.deepEqual(understanding.sources, [{ label: 'PR #42', url: 'https://github.com/acme/pay/pull/42' }]);
});
