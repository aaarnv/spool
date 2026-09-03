// VO placed at each step's output start, plus (vertical) a looped music bed carrying
// duckedMusicVolume as a per-frame volume expression.
import { join } from "node:path";
import { duckedMusicVolume } from "../vertical.mjs";
import { fnExpr } from "./expr.mjs";

const STEREO = "aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo";

export function buildAudio(g, ctx) {
  const { dir, segments, windows, durSec, fps, musicPath, speechWindows } = ctx;
  const labels = [];
  for (const seg of segments) {
    if (!seg.wav) continue;
    const w = windows.find((x) => x.i === seg.i);
    const start = w ? w.startSec : 0;
    const i = g.input(["-i", join(dir, seg.wav)]);
    const l = `a${seg.i}`;
    g.chain(`[${i}:a]${STEREO},adelay=${Math.round(start * 1000)}:all=1[${l}]`);
    labels.push(`[${l}]`);
  }

  // apad: the VO stops before the tail hold, and a stream that ends early leaves the
  // mp4's audio shorter than its video. The output -t trims the padding back.
  let vo = null;
  if (labels.length === 1) {
    g.chain(`${labels[0]}apad[vo]`);
    vo = "vo";
  } else if (labels.length > 1) {
    g.chain(`${labels.join("")}amix=inputs=${labels.length}:normalize=0:dropout_transition=0,apad[vo]`);
    vo = "vo";
  }

  if (!musicPath) return vo;

  const i = g.input(["-stream_loop", "-1", "-t", durSec.toFixed(3), "-i", musicPath]);
  const vol = fnExpr((t) => duckedMusicVolume(t, speechWindows, durSec), 0, durSec, fps, 0.002, "t");
  g.chain(`[${i}:a]${STEREO},volume=volume='${vol}':eval=frame[mus]`);
  if (!vo) return "mus";
  g.chain(`[${vo}][mus]amix=inputs=2:normalize=0:dropout_transition=0[aout]`);
  return "aout";
}
