// Shared steps.mjs module validation. Used by the record harness (record time)
// and `spool lint` (static check), so the two can never drift.
import { CHOICES } from '../config/prefs.mjs';

export function validateStepsModule(mod, stepsFile) {
  const { config, steps } = mod;
  if (!config || typeof config !== 'object') {
    throw new Error(`${stepsFile}: missing \`export const config\``);
  }
  if (typeof config.url !== 'string' || !config.url) {
    throw new Error(`${stepsFile}: config.url is required (a string)`);
  }
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error(`${stepsFile}: \`export const steps\` must be a non-empty array`);
  }
  steps.forEach((s, i) => {
    if (typeof s.name !== 'string' || !s.name) {
      throw new Error(`${stepsFile}: steps[${i}] needs a string \`name\``);
    }
    if (typeof s.run !== 'function') {
      throw new Error(`${stepsFile}: step "${s.name}" needs an async \`run(page, h)\``);
    }
  });
  if (config.prep != null && typeof config.prep !== 'function') {
    throw new Error(`${stepsFile}: config.prep must be an async function`);
  }
  if (config.format != null && !CHOICES.format.includes(config.format)) {
    throw new Error(`${stepsFile}: config.format must be one of: ${CHOICES.format.join(', ')}`);
  }
  return { config, steps };
}
