// High-quality capture via raw CDP Page.startScreencast: sharp JPEG frames
// (quality 95) assembled VFR-correct into capture.mp4. Replaces Playwright's
// recordVideo (fixed ~1Mbps VP8, no knobs) when SPOOL_CAPTURE=cdp.
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { spawn } from 'child_process';

const QUALITY = 95;

// Start capturing. Returns { firstFrameTs, stop }. Frame timestamps are epoch
// seconds (CDP TimeSinceEpoch) — callers align tOrigin to firstFrameTs so
// timeline t=0 equals video t=0 exactly.
export async function startScreencastCapture(page, dir, viewport) {
  const framesDir = join(dir, 'frames-cdp');
  await rm(framesDir, { recursive: true, force: true });
  await mkdir(framesDir, { recursive: true });

  const cdp = await page.context().newCDPSession(page);
  const frames = []; // { file, ts }
  const writes = [];
  let n = 0;
  let resolveFirst;
  const firstFrame = new Promise((r) => (resolveFirst = r));

  cdp.on('Page.screencastFrame', (ev) => {
    const file = `f${String(n++).padStart(6, '0')}.jpg`;
    frames.push({ file, ts: ev.metadata.timestamp });
    writes.push(writeFile(join(framesDir, file), Buffer.from(ev.data, 'base64')));
    if (frames.length === 1) resolveFirst(ev.metadata.timestamp);
    cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
  });

  await cdp.send('Page.startScreencast', {
    format: 'jpeg',
    quality: QUALITY,
    maxWidth: viewport.width,
    maxHeight: viewport.height,
    everyNthFrame: 1,
  });

  return {
    firstFrame, // resolves with the first frame's epoch-seconds timestamp
    async stop() {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await page.waitForTimeout(150).catch(() => {});
      await Promise.all(writes);
      if (!frames.length) throw new Error('screencast capture produced no frames');

      // concat demuxer with per-frame durations; a short tail hold on the last frame.
      let list = 'ffconcat version 1.0\n';
      for (let i = 0; i < frames.length; i++) {
        const dur = i + 1 < frames.length ? frames[i + 1].ts - frames[i].ts : 0.2;
        list += `file ${frames[i].file}\nduration ${Math.max(dur, 0.001).toFixed(4)}\n`;
      }
      await writeFile(join(framesDir, 'list.ffconcat'), list);
      const out = join(dir, 'capture.mp4');
      await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(framesDir, 'list.ffconcat'), '-fps_mode', 'vfr', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', out], framesDir);
      await rm(framesDir, { recursive: true, force: true });
      return { file: 'capture.mp4', frames: frames.length, t0: frames[0].ts, span: frames[frames.length - 1].ts - frames[0].ts };
    },
  };
}

function run(cmd, args, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`${cmd} exited ${code}: ${err}`))));
  });
}
