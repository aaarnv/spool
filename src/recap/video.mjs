// Merged pull request in, watchable vertical MP4 + share bundle out.
//
// This is the packet render lane (src/packet/video.mjs) with a different author stage
// in front of it. Everything after the beats exist — VO, the skia comp, the share
// bundle — is `renderAuthoredVideo`, imported rather than copied, because a recap and
// a plan video are the same film with different words.
//
// What is NOT here is any plan machinery. A recap has no packet, opens no decision and
// writes no plan.json: the workdir carries recap.json instead, which share.mjs reads
// into `spool.kind = "recap"`. A recap that accidentally shipped a plan.json would open
// a decision nobody asked for, so the two artifacts are written by different lanes and
// never by the same one.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { renderAuthoredVideo } from '../packet/video.mjs';
import { authorRecapVideo } from './author.mjs';

/** The recap's spoken title. The PR's own words, which are the change's real name. */
const recapTitle = (pr) => (pr.title ? `${pr.title} (${pr.repo}#${pr.number})` : `${pr.repo}#${pr.number}`);

/** The identity that travels into the bundle. The diff never does — see share.mjs. */
export function recapIdentity(pr) {
  return {
    repo: pr.repo,
    number: pr.number,
    url: pr.url,
    title: pr.title || null,
    author: pr.author ?? null,
    baseRef: pr.baseRef ?? null,
    mergedAt: pr.mergedAt ?? null,
    mergeCommitSha: pr.mergeCommitSha ?? null,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changedFiles ?? 0,
  };
}

/**
 * Render one merged pull request to `<workdir>/final.mp4` plus a full share bundle.
 *
 * `pr` is what `fetchPullRequest` returns. The workdir ends up holding recap.json,
 * beats.json, diagrams.json, timeline.json, render.json, vo/ and share/ — the same
 * set a packet render leaves, minus the packet. Returns the render's facts.
 */
export async function renderRecapVideo({
  workdir,
  pr,
  context = null,
  model,
  voice = 'alloy',
  speed = 1,
  engine,
  bg = 'random',
  seed = '',
  log = console.error,
} = {}) {
  if (!workdir) throw new Error('renderRecapVideo: workdir required');
  if (!pr?.repo || !pr?.number) throw new Error('renderRecapVideo: pr required');
  await mkdir(workdir, { recursive: true });

  log(`[recap] ${pr.repo}#${pr.number}: ${pr.files.length} file(s), +${pr.additions} -${pr.deletions}`);
  if (pr.truncation.length) log(`[recap] partial diff — ${pr.truncation.join('; ')}`);

  const authored = await authorRecapVideo({ pr, context, model, log });
  await writeFile(join(workdir, 'recap.json'), JSON.stringify({ ...recapIdentity(pr), understanding: authored.understanding }, null, 2) + '\n');

  const rendered = await renderAuthoredVideo({
    workdir,
    authored,
    title: recapTitle(pr),
    stamp: { recap: true, mode: authored.mode },
    tag: 'recap',
    voice,
    speed,
    engine,
    bg,
    seed: seed || `${pr.repo}#${pr.number}`,
    log,
  });
  return { ...rendered, mode: authored.mode, pr: recapIdentity(pr), understanding: authored.understanding };
}
