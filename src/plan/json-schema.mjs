// JSON Schema mirrors of the plan.json / evidence.json contracts.
//
// src/plan/schema.mjs stays the runtime gate: it is dependency-free and it
// reports agent-readable diagnostics. These schemas exist so tools that are not
// the spool CLI (editors, other agents, CI jobs, the web app) can validate a
// packet with an off-the-shelf JSON Schema validator.
//
// The schemas are BUILT from the validator's exported constants, and
// scripts/generate-plan-schema.mjs writes them to plan.schema.json /
// evidence.schema.json. test/plan-json-schema.test.mjs fails when the committed
// files drift from these builders, or when a builder drifts from the validator.
//
// Scope: error-level structural rules only. Two classes of validator rule are
// deliberately absent, because JSON Schema cannot express them:
//   * warnings (length limits, unknown top-level fields, empty risks)
//   * cross-field rules (evidence IDs resolving, duplicate IDs, decision
//     options pointing at declared alternatives, an approval offering
//     "approve", a selection offering an alternative, chapterId restricted to
//     the plan's own declared chapters)
// A packet that passes these schemas can still fail `spool plan validate`.

import {
  CHAPTER_IDS,
  DECISION_ACTIONS,
  DECISION_TYPES,
  EVIDENCE_KINDS,
  EVIDENCE_VISIBILITIES,
  ID_PATTERN,
  PLAN_VERSION,
} from './schema.mjs';
import { GITHUB_URL_PATTERNS } from '../github/refs.mjs';
import { REF_PATTERNS } from './evidence.mjs';

/** A `links` value that may be text or null, but never a GitHub URL of the other kind. */
const linkOfKind = (kind, forbidden) => ({
  description: `The ${kind === 'pull' ? 'pull request' : 'issue'} this plan belongs to: a github.com URL, "owner/name#12", or a number resolved against links.repo.`,
  // `allOf` rather than a `$ref` with siblings: not every validator applies keywords
  // beside a `$ref`, and this rule has to hold in all of them.
  anyOf: [{ allOf: [{ $ref: '#/$defs/text' }, { not: { pattern: forbidden } }] }, { type: 'null' }],
});

// Ref rules a `pattern` can carry. The CLI adds what it cannot: URL
// credentials, private hosts, and a message naming the offending kind.
const refRules = () => [
  {
    if: { required: ['kind'], properties: { kind: { const: 'commit' } } },
    then: { properties: { ref: { pattern: REF_PATTERNS.commit } } },
  },
  {
    if: { required: ['kind'], properties: { kind: { const: 'url' } } },
    then: { properties: { ref: { pattern: REF_PATTERNS.url } } },
  },
  {
    if: { required: ['kind'], properties: { kind: { enum: ['file', 'image'] } } },
    then: { properties: { ref: { pattern: REF_PATTERNS.path } } },
  },
];

export const PLAN_SCHEMA_FILE = 'plan.schema.json';
export const EVIDENCE_SCHEMA_FILE = 'evidence.schema.json';

const NOT_EXPRESSED = [
  'Warnings and cross-field rules are not expressed here: run `spool plan validate` for the full gate.',
].join(' ');

// `text` is the validator's isText(): a string with at least one non-space char.
const defs = () => ({
  text: {
    type: 'string',
    minLength: 1,
    pattern: '\\S',
    description: 'A non-empty string; whitespace only is not a value.',
  },
  id: {
    type: 'string',
    pattern: ID_PATTERN,
    description: 'A kebab-case id (a-z, 0-9, dashes) that other artifacts can anchor to.',
  },
  chapterId: { enum: [...CHAPTER_IDS] },
  evidenceRefs: {
    type: 'array',
    items: { $ref: '#/$defs/text' },
    description: 'IDs of descriptors declared in evidence.json.',
  },
});

const version = (writes) => ({
  type: 'integer',
  minimum: 1,
  maximum: writes,
  description: `Contract version. This CLI reads and writes ${writes}.`,
});

// alternatives: absent or empty means the plan claims there was no credible
// option, so it must say so; declaring both is a contradiction.
const alternativesRules = () => [
  {
    if: {
      not: { required: ['alternatives'], properties: { alternatives: { type: 'array', minItems: 1 } } },
    },
    then: {
      required: ['noAlternativesReason'],
      properties: { noAlternativesReason: { $ref: '#/$defs/text' } },
    },
  },
  {
    if: { required: ['alternatives'], properties: { alternatives: { type: 'array', minItems: 1 } } },
    then: { properties: { noAlternativesReason: { type: 'null' } } },
  },
];

/** Build the JSON Schema for plan.json. */
export function buildPlanSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://spoolkit.dev/schema/plan-v${PLAN_VERSION}.json`,
    title: `Spool plan.json (version ${PLAN_VERSION})`,
    description:
      'The Plan Spool packet: what an agent proposes and the one decision it asks for. ' +
      'Generated from src/plan/schema.mjs — do not edit by hand; run `npm run schema`. ' +
      NOT_EXPRESSED,
    type: 'object',
    required: ['version', 'kind', 'goal', 'outcome', 'approach', 'risks', 'decision', 'links'],
    properties: {
      version: version(PLAN_VERSION),
      kind: { const: 'plan' },
      goal: { $ref: '#/$defs/text', description: 'What this plan sets out to do.' },
      outcome: { $ref: '#/$defs/text', description: 'What is true after the work lands.' },
      currentState: {
        type: 'array',
        description: 'Claims about what exists today, each backed by evidence.',
        items: {
          type: 'object',
          required: ['claim'],
          properties: {
            claim: { $ref: '#/$defs/text' },
            evidence: { $ref: '#/$defs/evidenceRefs' },
            chapterId: { $ref: '#/$defs/chapterId' },
          },
        },
      },
      approach: {
        type: 'array',
        minItems: 1,
        description: 'The ordered steps of the proposal. IDs are anchors for questions and proofs.',
        items: {
          type: 'object',
          required: ['id', 'summary'],
          properties: {
            id: { $ref: '#/$defs/id' },
            summary: { $ref: '#/$defs/text' },
            evidence: { $ref: '#/$defs/evidenceRefs' },
            chapterId: { $ref: '#/$defs/chapterId' },
          },
        },
      },
      alternatives: {
        type: 'array',
        description: 'Options considered and not taken.',
        items: {
          type: 'object',
          required: ['id', 'summary'],
          properties: {
            id: { $ref: '#/$defs/id' },
            summary: { $ref: '#/$defs/text' },
            tradeoffs: { type: 'array', items: { $ref: '#/$defs/text' } },
            evidence: { $ref: '#/$defs/evidenceRefs' },
          },
        },
      },
      noAlternativesReason: {
        $ref: '#/$defs/text',
        description: 'Required when alternatives is absent or empty; forbidden when alternatives are declared.',
      },
      assumptions: { type: 'array', items: { $ref: '#/$defs/text' } },
      risks: {
        type: 'array',
        description: 'A risk is a string, or a claim that cites evidence.',
        items: {
          anyOf: [
            { $ref: '#/$defs/text' },
            {
              type: 'object',
              required: ['claim'],
              properties: {
                claim: { $ref: '#/$defs/text' },
                evidence: { $ref: '#/$defs/evidenceRefs' },
                chapterId: { $ref: '#/$defs/chapterId' },
              },
            },
          ],
        },
      },
      decision: {
        type: 'object',
        description: 'The one action the plan asks a reviewer for.',
        required: ['type', 'prompt', 'options'],
        properties: {
          type: { enum: [...DECISION_TYPES] },
          prompt: { $ref: '#/$defs/text' },
          evidence: { $ref: '#/$defs/evidenceRefs' },
          options: {
            type: 'array',
            minItems: 1,
            items: {
              anyOf: [
                { enum: [...DECISION_ACTIONS] },
                { type: 'string', pattern: '^alternative:.+$' },
              ],
            },
          },
        },
      },
      links: {
        type: 'object',
        description: 'Where this plan lives. Use null for what does not apply.',
        properties: {
          // The one link rule a pattern can carry: a pull-request link must not be an
          // issue URL, and an issue link must not be a pull-request URL. Everything
          // else about these two (the short forms, the bare number resolved against
          // links.repo) needs another field, so it stays in the validator.
          pr: linkOfKind('pull', GITHUB_URL_PATTERNS.issue),
          issue: linkOfKind('issue', GITHUB_URL_PATTERNS.pull),
        },
        additionalProperties: { anyOf: [{ $ref: '#/$defs/text' }, { type: 'null' }] },
      },
      chapters: {
        type: 'array',
        minItems: 1,
        description: 'Stable semantic anchors. They never index into timeline.json.',
        contains: { type: 'object', properties: { id: { const: 'decision' } }, required: ['id'] },
        items: {
          type: 'object',
          required: ['id'],
          properties: {
            id: { $ref: '#/$defs/chapterId' },
            title: { $ref: '#/$defs/text' },
          },
        },
      },
    },
    allOf: alternativesRules(),
    $defs: defs(),
  };
}

/** Build the JSON Schema for evidence.json. */
export function buildEvidenceSchema() {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://spoolkit.dev/schema/evidence-v${PLAN_VERSION}.json`,
    title: `Spool evidence.json (version ${PLAN_VERSION})`,
    description:
      'Evidence descriptors for a Plan Spool. Descriptors reference evidence; they never copy its content. ' +
      'Generated from src/plan/schema.mjs — do not edit by hand; run `npm run schema`. ' +
      NOT_EXPRESSED,
    type: 'object',
    required: ['version', 'kind', 'items'],
    properties: {
      version: version(PLAN_VERSION),
      kind: { const: 'evidence' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['id', 'kind', 'label', 'ref'],
          properties: {
            id: { $ref: '#/$defs/id' },
            kind: { enum: [...EVIDENCE_KINDS] },
            label: { $ref: '#/$defs/text', description: 'What a reviewer reads.' },
            ref: {
              $ref: '#/$defs/text',
              description:
                'A repository-relative path (file, image), an absolute http(s) URL (url), a git SHA (commit), or a command (test, console). Per-kind ref rules are enforced by the CLI validator.',
            },
            revision: {
              anyOf: [{ $ref: '#/$defs/text' }, { type: 'null' }],
              description: 'The git SHA the ref was read at. Without it the published link cannot be pinned.',
            },
            chapterIds: { type: 'array', items: { $ref: '#/$defs/chapterId' } },
            visibility: {
              enum: [...EVIDENCE_VISIBILITIES],
              description: 'private publishes the label only: the ref, summary, excerpt and URL are withheld.',
            },
            summary: {
              anyOf: [{ $ref: '#/$defs/text' }, { type: 'null' }],
              description: 'One plain-language sentence about what the source showed. Shown before the excerpt, so code and command output stay on demand.',
            },
            excerpt: {
              anyOf: [{ $ref: '#/$defs/text' }, { type: 'null' }],
              description: 'An optional short quotation from the source. Truncated and redacted when published.',
            },
            lines: {
              type: 'array',
              minItems: 1,
              maxItems: 2,
              items: { type: 'integer', minimum: 1 },
              description: '[start] or [start, end], 1-based, anchoring a file or image ref.',
            },
          },
          allOf: refRules(),
        },
      },
    },
    $defs: defs(),
  };
}

/** Serialize a schema exactly as the generator writes it to disk. */
export function serializeSchema(schema) {
  return `${JSON.stringify(schema, null, 2)}\n`;
}
