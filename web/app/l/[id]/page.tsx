import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { blobUrl, mmss, type Loom } from "../../loom";
import Player, { type Chapter, type Line } from "./Player";

// Blob content is immutable per id — cache the loom.json fetch aggressively.
async function getLoom(id: string): Promise<Loom | null> {
  try {
    const res = await fetch(blobUrl(id, "loom.json"), { cache: "force-cache" });
    if (!res.ok) return null;
    return (await res.json()) as Loom;
  } catch {
    return null;
  }
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const loom = await getLoom(id);
  if (!loom) return { title: "Not found · agent-loom" };
  return {
    title: `${loom.title || "Untitled loom"} · agent-loom`,
    description: "A walkthrough recorded by an agent.",
  };
}

export default async function WatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const loom = await getLoom(id);
  if (!loom) notFound();

  // Step times in loom.json are on the recording clock; final.mp4 runs at
  // recording-clock ÷ rate. Convert every seek/label to the final.mp4 clock.
  const rate = loom.rate && loom.rate > 0 ? loom.rate : 1;
  const toFinal = (t: number) => t / rate;

  const chapters: Chapter[] = loom.steps.map((s) => ({
    i: s.i,
    name: s.name,
    at: toFinal(s.start),
    label: mmss(toFinal(s.start)),
  }));

  const lines: Line[] = loom.steps
    .filter((s) => s.narration)
    .map((s) => ({
      i: s.i,
      narration: s.narration,
      at: toFinal(s.start),
      label: mmss(toFinal(s.start)),
    }));

  const poster = loom.steps[0]?.frame;
  const consoleUrl = blobUrl(id, "console.jsonl");
  const rawUrl = blobUrl(id, "loom.json");

  return (
    <main className="wrap">
      <div className="brand">
        <span className="dot" />
        agent-loom
      </div>

      <h1 className="title">{loom.title || "Untitled loom"}</h1>
      <p className="byline">
        {mmss(loom.duration)}
        <span className="sep">·</span>
        recorded by an agent
        <span className="sep">·</span>
        agent-loom
      </p>

      <Player src={loom.video} poster={poster} chapters={chapters} lines={lines} />

      <details className="agents">
        <summary>
          <span className="caret">›</span>
          For agents
        </summary>
        <div className="body">
          Machine-readable walkthrough data. <code>loom.json</code> indexes every step
          (narration, timings, keyframes); <code>console.jsonl</code> is the browser
          telemetry captured while recording.
          <div className="links">
            <a href={rawUrl}>loom.json →</a>
            <a href={consoleUrl}>console.jsonl →</a>
          </div>
        </div>
      </details>
    </main>
  );
}
