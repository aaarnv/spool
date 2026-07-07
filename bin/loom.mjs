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
    console.error(`No steps.mjs in ${workdir} — run \`loom init\` or author one (see CONTRACTS.md).`);
    process.exit(1);
  }
  return p;
};

program
  .name('loom')
  .description('Agents record their own Looms: real browser video, AI voiceover, word-synced captions.');

program
  .command('init <slug>')
  .description('scaffold loom/<slug>/steps.mjs in the current project')
  .action((slug) => {
    const workdir = resolve('loom', slug);
    mkdirSync(workdir, { recursive: true });
    const dest = join(workdir, 'steps.mjs');
    if (existsSync(dest)) {
      console.error(`${dest} already exists — not overwriting.`);
      process.exit(1);
    }
    cpSync(join(root, 'templates', 'steps.mjs'), dest);
    console.log(`Created ${dest}\nNext: edit the steps, then \`loom dry ${workdir}\` to debug the driver.`);
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
  .description('record the demo (requires vo/manifest.json for pacing)')
  .option('--headed', 'show the browser')
  .action(async (workdir, opts) => {
    const { record } = await import(join(root, 'src/record/harness.mjs'));
    await record({ stepsFile: stepsPath(workdir), workdir: resolve(workdir), headed: !!opts.headed });
  });

program
  .command('render <workdir>')
  .description('normalize + Remotion-render the final loom mp4')
  .option('--rate <rate>', 'global playback speed for the final video', '1.25')
  .action(async (workdir, opts) => {
    const { renderLoom } = await import(join(root, 'src/render/render.mjs'));
    await renderLoom({ workdir: resolve(workdir), rate: Number(opts.rate) });
  });

program
  .command('share <workdir>')
  .description('write the agent-consumable share/ bundle (loom.json, transcript, keyframes, console log)')
  .action(async (workdir) => {
    const { shareLoom } = await import(join(root, 'src/share/share.mjs'));
    await shareLoom(resolve(workdir));
  });

program
  .command('read <dir>')
  .description('print an agent-oriented digest of a loom (accepts a workdir or its share/ dir)')
  .action(async (dir) => {
    const { readLoom } = await import(join(root, 'src/share/share.mjs'));
    console.log(await readLoom(resolve(dir)));
  });

program
  .command('build <workdir>')
  .description('vo → record → render → share, end to end')
  .option('--engine <engine>', 'openai | local', 'openai')
  .option('--voice <voice>', 'TTS voice', 'alloy')
  .option('--speed <speed>', 'narration tempo (pitch-preserving)', '1')
  .option('--rate <rate>', 'global playback speed for the final video', '1.25')
  .option('--headed', 'show the browser while recording')
  .action(async (workdir, opts) => {
    const wd = resolve(workdir);
    const sf = stepsPath(workdir);
    const { generateVO } = await import(join(root, 'src/vo/tts.mjs'));
    const { record } = await import(join(root, 'src/record/harness.mjs'));
    const { renderLoom } = await import(join(root, 'src/render/render.mjs'));
    console.log('── loom vo');
    await generateVO({ stepsFile: sf, workdir: wd, engine: opts.engine, voice: opts.voice, speed: Number(opts.speed) });
    console.log('── loom record');
    await record({ stepsFile: sf, workdir: wd, headed: !!opts.headed });
    console.log('── loom render');
    await renderLoom({ workdir: wd, rate: Number(opts.rate) });
    console.log('── loom share');
    const { shareLoom } = await import(join(root, 'src/share/share.mjs'));
    await shareLoom(wd);
    console.log(`\nDone: ${join(wd, 'final.mp4')} (+ share/ bundle for agents)`);
  });

program.parseAsync();
