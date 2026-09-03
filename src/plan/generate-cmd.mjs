// `spool plan generate <workdir>` — the CLI shell around ./generate.mjs.
// Kept out of bin/spool.mjs so the command's behaviour is testable without
// spawning a process.

import { formatDiagnostics } from './schema.mjs';
import { readPlanPacket, PLAN_FILE } from './plan.mjs';
import {
  SCRIPT_FILE,
  existingStepsUrl,
  formatScript,
  generatePlanScript,
  lintPlanScript,
  resolveStyle,
  writePlanScript,
  writeStepsModule,
} from './generate.mjs';

/**
 * Returns the process exit code (0 ok, 1 refused). Never throws for an
 * authoring problem: every refusal is printed as a diagnostic first.
 */
export async function planGenerateCmd(workdir, opts = {}) {
  const packet = await readPlanPacket(workdir);
  if (!packet.present) {
    console.error(`[plan] no ${PLAN_FILE} in ${workdir}; this is not a Plan Spool. Run \`spool plan init\` first.`);
    return 1;
  }
  // Generation reads the packet as fact, so the packet must be valid first.
  if (!packet.ok) {
    console.error(`[plan] ${PLAN_FILE} is invalid — fix it before generating narration.`);
    console.error(formatDiagnostics(packet));
    return 1;
  }

  let style;
  try {
    style = await resolveStyle();
  } catch (e) {
    console.error(`[plan] ${e.message}`);
    return 1;
  }

  // The model always gets a pass at the wording, and every way that can fail — no key,
  // a bad reply, a changed chapter set — lands on the deterministic script instead.
  // SPOOL_PLAN_MODEL=none is the escape for a run that must be byte-reproducible.
  let script = generatePlanScript(packet, style);
  const notes = [];
  if (process.env.SPOOL_PLAN_MODEL !== 'none') {
    const { refinePlanScript } = await import('./outline-llm.mjs');
    try {
      const refined = await refinePlanScript(script, packet);
      script = refined.script;
      notes.push(...refined.warnings);
    } catch (e) {
      console.error(`[plan] the narration rewrite was skipped (${e.message}); keeping the deterministic script.`);
    }
  }

  const report = lintPlanScript(script, packet);

  if (opts.json) {
    console.log(JSON.stringify({ ok: report.ok, script, lint: report, llm: notes }, null, 2));
  } else {
    console.log(formatScript(script));
    for (const n of notes) console.error(`  llm   ${n.path}  ${n.message}`);
    if (report.errors.length || report.warnings.length) console.error(formatDiagnostics(report));
  }

  // A failing script is not written: an unusable artifact in the workdir would
  // just fail again at the next stage, further from the cause.
  if (!report.ok) {
    if (!opts.json) console.error(`[plan] ${report.errors.length} error(s) — nothing written. Fix ${PLAN_FILE} and run \`spool plan generate\` again.`);
    return 1;
  }

  const written = [await writePlanScript(workdir, script)];
  if (opts.steps) {
    const url = opts.url || (await existingStepsUrl(workdir));
    if (!url) {
      console.error(`[plan] --steps needs an app URL: pass --url, or keep an existing steps.mjs with a config.url. ${SCRIPT_FILE} was written.`);
      return 1;
    }
    try {
      written.push(await writeStepsModule(workdir, script, { url, title: opts.title, force: !!opts.force }));
    } catch (e) {
      console.error(`[plan] ${e.message}`);
      return 1;
    }
  }
  if (!opts.json) for (const p of written) console.log(`wrote ${p}`);
  return 0;
}
