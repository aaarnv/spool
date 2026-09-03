#!/usr/bin/env node
// Write the generated JSON Schema mirrors of the plan packet contract.
// Run: npm run schema   (then commit the changed files)

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EVIDENCE_SCHEMA_FILE,
  PLAN_SCHEMA_FILE,
  buildEvidenceSchema,
  buildPlanSchema,
  serializeSchema,
} from '../src/plan/json-schema.mjs';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'plan');

for (const [file, schema] of [
  [PLAN_SCHEMA_FILE, buildPlanSchema()],
  [EVIDENCE_SCHEMA_FILE, buildEvidenceSchema()],
]) {
  const path = join(outDir, file);
  writeFileSync(path, serializeSchema(schema));
  console.log(`wrote ${path}`);
}
