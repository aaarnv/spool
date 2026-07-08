#!/usr/bin/env node
import { Command } from 'commander';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const program = new Command();

const stepsPath = (workdir) => {
  const p = resolve(workdir, 'steps.mjs');
  if (!existsSync(p)) {
    console.error(`No steps.mjs in ${workdir} — run \`spool init\` or author one (see CONTRACTS.md).`);
    process.exit(1);
  }
  return p;
};

program
  .name('spool')
  .description('Agents record their own spools: real browser video, AI voiceover, word-synced captions.');

program
  .command('init <slug>')
  .description('scaffold spool/<slug>/steps.mjs in the current project')
  .action((slug) => {
    const workdir = resolve('spool', slug);
    mkdirSync(workdir, { recursive: true });
    const dest = join(workdir, 'steps.mjs');
    if (existsSync(dest)) {
      console.error(`${dest} already exists — not overwriting.`);
      process.exit(1);
    }
    cpSync(join(root, 'templates', 'steps.mjs'), dest);
    console.log(`Created ${dest}\nNext: edit the steps, then \`spool dry ${workdir}\` to debug the driver.`);
  });

program
  .command('dry <workdir>')
  .description('drive the steps without recording or VO (debug selectors/timing)')
  .option('--headed', 'show the browser')
  .action(async (workdir, opts) => {
    const { record } = await import(join(root, 'src/record/harness.mjs'));
    await record({ stepsFile: stepsPath(workdir), workdir: resolve(workdir), dry: true, headed: !!opts.headed });
  });

program
  .command('vo <workdir>')
  .description('generate voiceover segments + word timestamps')
  .option('--engine <engine>', 'openai | local', 'openai')
  .option('--voice <voice>', 'TTS voice', 'alloy')
  .option('--speed <speed>', 'narration tempo (pitch-preserving)', '1')
  .action(async (workdir, opts) => {
    const { generateVO } = await import(join(root, 'src/vo/tts.mjs'));
    await generateVO({ stepsFile: stepsPath(workdir), workdir: resolve(workdir), engine: opts.engine, voice: opts.voice, speed: Number(opts.speed) });
  });

program
  .command('record <workdir>')
  .description('record the demo at natural speed (VO not required; renderer retimes)')
  .option('--headed', 'show the browser')
  .action(async (workdir, opts) => {
    const { record } = await import(join(root, 'src/record/harness.mjs'));
    await record({ stepsFile: stepsPath(workdir), workdir: resolve(workdir), headed: !!opts.headed });
  });

program
  .command('render <workdir>')
  .description('normalize + Remotion-render the final spool mp4')
  .option('--rate <rate>', 'global playback speed for the final video', '1')
  .action(async (workdir, opts) => {
    const { renderSpool } = await import(join(root, 'src/render/render.mjs'));
    await renderSpool({ workdir: resolve(workdir), rate: Number(opts.rate) });
  });

program
  .command('share <workdir>')
  .description('write the agent-consumable share/ bundle (spool.json, transcript, keyframes, console log)')
  .action(async (workdir) => {
    const { shareSpool } = await import(join(root, 'src/share/share.mjs'));
    await shareSpool(resolve(workdir));
  });

program
  .command('read <dir>')
  .description('print an agent-oriented digest of a spool (accepts a workdir or its share/ dir)')
  .action(async (dir) => {
    const { readSpool } = await import(join(root, 'src/share/share.mjs'));
    console.log(await readSpool(resolve(dir)));
  });

program
  .command('publish <workdir>')
  .description('upload the spool + share bundle and get a single shareable watch link')
  .option('--host <host>', 'watch app origin (default: env SPOOL_HOST or ~/.spool.json)')
  .option('--token <token>', 'publish token (default: env SPOOL_PUBLISH_TOKEN or ~/.spool.json)')
  .action(async (workdir, opts) => {
    const { publishSpool } = await import(join(root, 'src/publish/publish.mjs'));
    await publishSpool(resolve(workdir), { host: opts.host, token: opts.token });
  });

program
  .command('build <workdir>')
  .description('(vo ‖ record) → render → share, end to end')
  .option('--engine <engine>', 'openai | local', 'openai')
  .option('--voice <voice>', 'TTS voice', 'alloy')
  .option('--speed <speed>', 'narration tempo (pitch-preserving)', '1')
  .option('--rate <rate>', 'global playback speed for the final video', '1')
  .option('--headed', 'show the browser while recording')
  .action(async (workdir, opts) => {
    const wd = resolve(workdir);
    const sf = stepsPath(workdir);
    const { generateVO } = await import(join(root, 'src/vo/tts.mjs'));
    const { record } = await import(join(root, 'src/record/harness.mjs'));
    const { renderSpool } = await import(join(root, 'src/render/render.mjs'));
    // Record-first, narrate-parallel: VO and capture are independent now, so run
    // them concurrently. Either rejecting fails the build with that error.
    console.log('── spool vo ‖ record');
    const t0 = Date.now();
    await Promise.all([
      generateVO({ stepsFile: sf, workdir: wd, engine: opts.engine, voice: opts.voice, speed: Number(opts.speed) })
        .then(() => console.log(`   vo done (${((Date.now() - t0) / 1000).toFixed(1)}s)`)),
      record({ stepsFile: sf, workdir: wd, headed: !!opts.headed })
        .then(() => console.log(`   record done (${((Date.now() - t0) / 1000).toFixed(1)}s)`)),
    ]);
    console.log('── spool render');
    await renderSpool({ workdir: wd, rate: Number(opts.rate) });
    console.log('── spool share');
    const { shareSpool } = await import(join(root, 'src/share/share.mjs'));
    await shareSpool(wd);
    console.log(`\nDone: ${join(wd, 'final.mp4')} (+ share/ bundle for agents)`);
  });

program.parseAsync();
