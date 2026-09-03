// Drift tests: the committed JSON Schemas must stay a faithful mirror of the
// hand-rolled validator in src/plan/schema.mjs (SPL decision #8).
//
// Three layers, cheapest first:
//   1. the committed files equal what the builders produce (regeneration drift)
//   2. every enum/pattern in the schema equals the validator's constant (a new
//      chapter id, evidence kind or decision action fails here)
//   3. schema and validator AGREE on accept/reject for every fixture and for a
//      generated case per enum value (behavioural drift)
//
// Layer 3 needs a JSON Schema evaluator, and the CLI ships zero dependencies,
// so this file carries a small one covering the keywords the schemas use. It is
// test-only: production code never validates through it.
//
// Run: npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHAPTER_IDS,
  DECISION_ACTIONS,
  DECISION_TYPES,
  EVIDENCE_KINDS,
  EVIDENCE_VISIBILITIES,
  ID_PATTERN,
  PLAN_VERSION,
  validateEvidence,
  validatePlan,
} from '../src/plan/schema.mjs';
import { REF_PATTERNS } from '../src/plan/evidence.mjs';
import {
  EVIDENCE_SCHEMA_FILE,
  PLAN_SCHEMA_FILE,
  buildEvidenceSchema,
  buildPlanSchema,
  serializeSchema,
} from '../src/plan/json-schema.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fixtures = join(here, 'fixtures', 'plan');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fixture = (name) => readJson(join(fixtures, name));

const planSchema = readJson(join(root, 'src', 'plan', PLAN_SCHEMA_FILE));
const evidenceSchema = readJson(join(root, 'src', 'plan', EVIDENCE_SCHEMA_FILE));

// --- a minimal JSON Schema evaluator (test-only) ----------------------------

const typeOf = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
};

const typeMatches = (want, v) => {
  const actual = typeOf(v);
  if (want === 'number') return actual === 'number' || actual === 'integer';
  return want === actual;
};

const deref = (schema, root) => {
  if (!schema || !schema.$ref) return schema;
  const path = schema.$ref.replace(/^#\//, '').split('/');
  return path.reduce((acc, key) => acc[key], root);
};

/** True when `value` satisfies `schema`. Supports only the keywords used here. */
function matches(value, schema, root) {
  const s = deref(schema, root);
  if (s === true) return true;
  if (s === false) return false;

  if (s.type !== undefined) {
    const wanted = Array.isArray(s.type) ? s.type : [s.type];
    if (!wanted.some((t) => typeMatches(t, value))) return false;
  }
  if (s.const !== undefined && value !== s.const) return false;
  if (s.enum !== undefined && !s.enum.includes(value)) return false;

  if (typeof value === 'string') {
    if (s.minLength !== undefined && value.length < s.minLength) return false;
    if (s.pattern !== undefined && !new RegExp(s.pattern).test(value)) return false;
  }
  if (typeof value === 'number') {
    if (s.minimum !== undefined && value < s.minimum) return false;
    if (s.maximum !== undefined && value > s.maximum) return false;
  }
  if (Array.isArray(value)) {
    if (s.minItems !== undefined && value.length < s.minItems) return false;
    if (s.maxItems !== undefined && value.length > s.maxItems) return false;
    if (s.items && !value.every((item) => matches(item, s.items, root))) return false;
    if (s.contains && !value.some((item) => matches(item, s.contains, root))) return false;
  }
  if (typeOf(value) === 'object') {
    for (const key of s.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
    }
    for (const [key, sub] of Object.entries(s.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key) && !matches(value[key], sub, root)) return false;
    }
    if (s.additionalProperties !== undefined) {
      const declared = new Set(Object.keys(s.properties || {}));
      for (const [key, v] of Object.entries(value)) {
        if (declared.has(key)) continue;
        if (!matches(v, s.additionalProperties, root)) return false;
      }
    }
  }

  if (s.not && matches(value, s.not, root)) return false;
  if (s.anyOf && !s.anyOf.some((sub) => matches(value, sub, root))) return false;
  if (s.allOf && !s.allOf.every((sub) => matches(value, sub, root))) return false;
  if (s.if) {
    const branch = matches(value, s.if, root) ? s.then : s.else;
    if (branch && !matches(value, branch, root)) return false;
  }
  return true;
}

const schemaAccepts = (value, schema) => matches(value, schema, schema);

// The evaluator is the test's own instrument, so prove it reads each keyword.
test('the test evaluator implements the keywords the schemas use', () => {
  const cases = [
    [{ type: 'integer', maximum: 1 }, 1, 2],
    [{ type: 'string', minLength: 1, pattern: '\\S' }, 'a', '  '],
    [{ const: 'plan' }, 'plan', 'evidence'],
    [{ enum: ['a', 'b'] }, 'a', 'c'],
    [{ type: 'array', minItems: 1 }, [1], []],
    [{ type: 'array', maxItems: 2 }, [1, 2], [1, 2, 3]],
    [{ type: 'array', items: { type: 'string' } }, ['a'], [1]],
    [{ type: 'array', contains: { const: 'x' } }, ['x'], ['y']],
    [{ required: ['a'] }, { a: 1 }, {}],
    [{ properties: { a: { type: 'string' } } }, { a: 's' }, { a: 1 }],
    [{ additionalProperties: { type: 'null' } }, { a: null }, { a: 1 }],
    [{ not: { type: 'string' } }, 1, 's'],
    [{ anyOf: [{ type: 'string' }, { type: 'null' }] }, null, 1],
    [{ allOf: [{ type: 'integer' }, { minimum: 2 }] }, 3, 1],
    [{ if: { type: 'object' }, then: { required: ['a'] } }, { a: 1 }, {}],
    [{ $ref: '#/$defs/t', $defs: { t: { type: 'string' } } }, 's', 1],
  ];
  for (const [schema, good, bad] of cases) {
    const root = schema.$defs ? schema : { ...schema, $defs: {} };
    assert.equal(matches(good, schema, root), true, `expected ${JSON.stringify(schema)} to accept ${JSON.stringify(good)}`);
    assert.equal(matches(bad, schema, root), false, `expected ${JSON.stringify(schema)} to reject ${JSON.stringify(bad)}`);
  }
});

// --- layer 1: the committed files are the generated files -------------------

test('the committed schemas match the generator', () => {
  for (const [file, built] of [
    [PLAN_SCHEMA_FILE, buildPlanSchema()],
    [EVIDENCE_SCHEMA_FILE, buildEvidenceSchema()],
  ]) {
    const path = join(root, 'src', 'plan', file);
    assert.equal(
      readFileSync(path, 'utf8'),
      serializeSchema(built),
      `${file} is stale: run \`npm run schema\` and commit the result`
    );
  }
});

// --- layer 2: every constant is the validator's constant --------------------

test('schema enums and patterns come from the validator constants', () => {
  assert.deepEqual(planSchema.$defs.chapterId.enum, CHAPTER_IDS);
  assert.deepEqual(evidenceSchema.$defs.chapterId.enum, CHAPTER_IDS);
  assert.deepEqual(planSchema.properties.decision.properties.type.enum, DECISION_TYPES);
  assert.deepEqual(planSchema.properties.decision.properties.options.items.anyOf[0].enum, DECISION_ACTIONS);
  assert.deepEqual(evidenceSchema.properties.items.items.properties.kind.enum, EVIDENCE_KINDS);
  // The chapter fields must reach those enums, not carry their own copy.
  assert.equal(planSchema.properties.chapters.items.properties.id.$ref, '#/$defs/chapterId');
  assert.equal(planSchema.properties.approach.items.properties.chapterId.$ref, '#/$defs/chapterId');
  assert.equal(planSchema.properties.currentState.items.properties.chapterId.$ref, '#/$defs/chapterId');
  assert.equal(evidenceSchema.properties.items.items.properties.chapterIds.items.$ref, '#/$defs/chapterId');
  assert.equal(planSchema.$defs.id.pattern, ID_PATTERN);
  assert.equal(evidenceSchema.$defs.id.pattern, ID_PATTERN);
  assert.equal(planSchema.properties.version.maximum, PLAN_VERSION);
  assert.equal(evidenceSchema.properties.version.maximum, PLAN_VERSION);
  assert.equal(planSchema.properties.kind.const, 'plan');
  assert.equal(evidenceSchema.properties.kind.const, 'evidence');
  // Descriptor rules: the visibility enum and the per-kind ref patterns are the
  // evidence module's, not a second copy.
  assert.deepEqual(evidenceSchema.properties.items.items.properties.visibility.enum, EVIDENCE_VISIBILITIES);
  const refRules = evidenceSchema.properties.items.items.allOf;
  assert.deepEqual(
    refRules.map((r) => r.then.properties.ref.pattern),
    [REF_PATTERNS.commit, REF_PATTERNS.url, REF_PATTERNS.path]
  );
});

// --- layer 3: schema and validator agree on accept/reject -------------------

// Every plan the repo ships as a fixture or template, plus one case per enum
// value so a value added to the validator without the schema fails here.
const planCases = () => {
  const minimal = fixture('valid-minimal.json');
  const cases = [
    ['fixture valid-minimal', minimal],
    ['fixture valid-full', fixture('valid-full.json')],
    ['templates/plan.json', readJson(join(root, 'templates', 'plan.json'))],
    ['fixture invalid-approach', fixture('invalid-approach.json')],
    ['fixture invalid-decision', fixture('invalid-decision.json')],
    ['fixture invalid-future-version', fixture('invalid-future-version.json')],
    ['fixture invalid-missing-required', fixture('invalid-missing-required.json')],
    ['fixture invalid-silent-alternatives', fixture('invalid-silent-alternatives.json')],
    ['unknown chapter id', { ...minimal, chapters: [{ id: 'summary' }, { id: 'decision' }] }],
    ['chapters without a decision chapter', { ...minimal, chapters: [{ id: 'context' }] }],
    ['unknown decision type', { ...minimal, decision: { ...minimal.decision, type: 'vote' } }],
    ['unknown decision action', { ...minimal, decision: { ...minimal.decision, options: ['ship-it'] } }],
    ['blank goal', { ...minimal, goal: '   ' }],
    ['null links value', { ...minimal, links: { task: null } }],
    ['non-string links value', { ...minimal, links: { task: 7 } }],
    ['alternatives and a reason', {
      ...minimal,
      alternatives: [{ id: 'other', summary: 'Do it another way.' }],
      decision: { ...minimal.decision, options: ['approve', 'alternative:other'] },
    }],
  ];
  for (const id of CHAPTER_IDS) {
    // Every plan declares the decision chapter; a duplicate would test something else.
    const ids = [...new Set([id, 'decision'])];
    cases.push([`chapter ${id}`, { ...minimal, chapters: ids.map((c) => ({ id: c })) }]);
    cases.push([`approach chapterId ${id}`, {
      ...minimal,
      approach: [{ ...minimal.approach[0], chapterId: id }],
      chapters: ids.map((c) => ({ id: c })),
    }]);
  }
  for (const action of DECISION_ACTIONS) {
    cases.push([`decision action ${action}`, {
      ...minimal,
      decision: { ...minimal.decision, options: [...new Set(['approve', action])] },
    }]);
  }
  for (const type of DECISION_TYPES) {
    cases.push([`decision type ${type}`, {
      ...minimal,
      alternatives: [{ id: 'other', summary: 'Do it another way.' }],
      noAlternativesReason: undefined,
      decision: { type, prompt: 'Choose.', options: ['approve', 'alternative:other'] },
    }]);
  }
  return cases;
};

const evidenceCases = () => {
  const base = fixture('valid-full.evidence.json');
  const item = base.items[0];
  const cases = [
    ['fixture valid-full.evidence', base],
    ['wrong kind', { ...base, kind: 'plan' }],
    ['future version', { ...base, version: PLAN_VERSION + 1 }],
    ['missing ref', { ...base, items: [{ id: 'ev-1', kind: 'file', label: 'A file' }] }],
    ['bad id', { ...base, items: [{ ...item, id: 'Ev One' }] }],
    ['unknown descriptor kind', { ...base, items: [{ ...item, kind: 'video' }] }],
    ['unknown chapter id', { ...base, items: [{ ...item, chapterIds: ['summary'] }] }],
    ['absolute file ref', { ...base, items: [{ ...item, ref: '/Users/someone/repo/app.ts' }] }],
    ['traversing file ref', { ...base, items: [{ ...item, ref: '../secrets/app.ts' }] }],
    ['file ref that is really a URL', { ...base, items: [{ ...item, ref: 'https://example.com/app.ts' }] }],
    ['non-http url ref', { ...base, items: [{ ...item, kind: 'url', ref: 'javascript:alert(1)' }] }],
    ['commit ref that is not a sha', { ...base, items: [{ ...item, kind: 'commit', ref: 'main' }] }],
    ['unknown visibility', { ...base, items: [{ ...item, visibility: 'secret' }] }],
    ['private descriptor', { ...base, items: [{ ...item, visibility: 'private' }] }],
    ['descriptor with an excerpt and lines', { ...base, items: [{ ...item, excerpt: 'export function AskPanel() {', lines: [12, 20] }] }],
    ['descriptor with three line numbers', { ...base, items: [{ ...item, lines: [1, 2, 3] }] }],
  ];
  for (const kind of EVIDENCE_KINDS) {
    const ref = { commit: '0123456789abcdef', url: 'https://example.com/evidence', }[kind] ?? item.ref;
    cases.push([`descriptor kind ${kind}`, { ...base, items: [{ ...item, kind, ref }] }]);
  }
  return cases;
};

// Rules that only the CLI can carry: a JSON Schema pattern cannot resolve a
// hostname, read credentials out of a URL, or compare two fields. A packet that
// passes the portable schema can still fail `spool lint`, and that is the
// documented contract, so these cases are asserted here rather than hidden.
test('the schema is a subset of the validator: CLI-only descriptor rules', () => {
  const base = fixture('valid-full.evidence.json');
  const item = base.items[0];
  const cliOnly = [
    ['url on a private host', { ...item, kind: 'url', ref: 'http://localhost:3000/admin' }],
    ['url carrying credentials', { ...item, kind: 'url', ref: 'https://user:pw@example.com/x' }],
    ['excerpt on a private descriptor', { ...item, visibility: 'private', excerpt: 'const secret = 1;' }],
    ['line range that ends before it starts', { ...item, lines: [20, 12] }],
  ];
  for (const [name, only] of cliOnly) {
    const value = { ...base, items: [only] };
    assert.equal(schemaAccepts(value, evidenceSchema), true, `${name}: expected the portable schema to accept it`);
    assert.equal(validateEvidence(value).ok, false, `${name}: expected the CLI validator to reject it`);
  }
});

for (const [name, plan] of planCases()) {
  test(`plan.schema.json agrees with validatePlan: ${name}`, () => {
    const value = JSON.parse(JSON.stringify(plan)); // drop undefined keys, as a file would
    assert.equal(
      schemaAccepts(value, planSchema),
      validatePlan(value).ok,
      `plan.schema.json and validatePlan disagree on "${name}"`
    );
  });
}

for (const [name, evidence] of evidenceCases()) {
  test(`evidence.schema.json agrees with validateEvidence: ${name}`, () => {
    const value = JSON.parse(JSON.stringify(evidence));
    assert.equal(
      schemaAccepts(value, evidenceSchema),
      validateEvidence(value).ok,
      `evidence.schema.json and validateEvidence disagree on "${name}"`
    );
  });
}
