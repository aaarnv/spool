import { blobUrl, srcBlobUrl, mmss, type Spool } from "../../spool";
import type { Chapter, Line, TourNode, PrMeta } from "./Watch";

// Blob content is immutable per id, so the spool.json fetch caches aggressively.
export async function getSpool(id: string): Promise<Spool | null> {
  try {
    // Tagged so a delete can revalidate exactly this spool's cached render.
    const res = await fetch(blobUrl(id, "spool.json"), {
      cache: "force-cache",
      next: { tags: [`spool:${id}`] },
    });
    if (!res.ok) return null;
    return (await res.json()) as Spool;
  } catch {
    return null;
  }
}

// Everything the player (watch page or embed) needs to render a spool.
export type PlayerModel = {
  title: string;
  durationLabel: string;
  src: string;
  poster?: string;
  chapters: Chapter[];
  lines: Line[];
  pr?: PrMeta;
  tour?: TourNode[];
  diffUrl?: string;
  prJsonUrl?: string;
  tourJsonUrl?: string;
};

// Step times in spool.json are on the recording clock; final.mp4 runs at
// recording-clock / rate. Convert every seek/label to the final.mp4 clock.
export function playerModel(id: string, spool: Spool): PlayerModel {
  const rate = spool.rate && spool.rate > 0 ? spool.rate : 1;
  const toFinal = (t: number) => t / rate;

  const chapters: Chapter[] = spool.steps.map((s) => ({
    i: s.i,
    name: s.name,
    at: toFinal(s.start),
    label: mmss(toFinal(s.start)),
  }));

  const lines: Line[] = spool.steps
    .filter((s) => s.narration)
    .map((s) => ({
      i: s.i,
      narration: s.narration,
      at: toFinal(s.start),
      label: mmss(toFinal(s.start)),
    }));

  const model: PlayerModel = {
    title: spool.title || "Untitled spool",
    durationLabel: mmss(spool.duration),
    src: spool.video,
    poster: spool.steps[0]?.frame,
    chapters,
    lines,
  };

  // PR-guide mode: resolve each tour stop's step index to a video anchor, and
  // point the client at the diff + source blobs. Out-of-range index = unanchored.
  if (spool.pr) {
    model.pr = {
      number: spool.pr.number,
      url: spool.pr.url,
      title: spool.pr.title,
      additions: spool.pr.additions,
      deletions: spool.pr.deletions,
      changedFiles: spool.pr.changedFiles,
    };
    model.tour = spool.pr.stops.map((s) => {
      const step = s.step != null ? spool.steps[s.step] : undefined;
      const at = step ? toFinal(step.start) : null;
      return {
        id: s.id,
        heading: s.heading,
        prose: s.prose,
        files: s.files,
        at,
        label: at != null ? mmss(at) : null,
      };
    });
    model.diffUrl = srcBlobUrl(id, "pr/diff.patch");
    model.prJsonUrl = srcBlobUrl(id, "pr/pr.json");
    model.tourJsonUrl = srcBlobUrl(id, "pr/tour.json");
  }

  return model;
}
