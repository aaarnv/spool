import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { blobUrl, mmss, type Spool } from "../../spool";
import { db } from "../../../db";
import { spools as spoolsTable } from "../../../db/schema";
import Player, { type Chapter, type Line } from "./Player";
import EditPanel from "./EditPanel";

// Blob content is immutable per id — cache the spool.json fetch aggressively.
async function getSpool(id: string): Promise<Spool | null> {
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

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const spool = await getSpool(id);
  if (!spool) return { title: "Not found · spool" };
  return {
    title: `${spool.title || "Untitled spool"} · spool`,
    description: "A walkthrough recorded by an agent.",
  };
}

export default async function WatchPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const spool = await getSpool(id);
  if (!spool) notFound();

  // Owner-only edit affordance: match the signed-in Clerk user to the spool's owner.
  const { userId } = await auth();
  let isOwner = false;
  let hasSources = false;
  if (userId) {
    const [row] = await db
      .select({ ownerId: spoolsTable.ownerId, hasSources: spoolsTable.hasSources })
      .from(spoolsTable)
      .where(eq(spoolsTable.id, id))
      .limit(1);
    isOwner = !!row && row.ownerId === userId;
    hasSources = !!row?.hasSources;
  }

  // Step times in spool.json are on the recording clock; final.mp4 runs at
  // recording-clock ÷ rate. Convert every seek/label to the final.mp4 clock.
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

  const poster = spool.steps[0]?.frame;
  const consoleUrl = blobUrl(id, "console.jsonl");
  const rawUrl = blobUrl(id, "spool.json");

  return (
    <main className="wrap">
      <div className="brand">
        <img src="/logo.svg" width={18} height={18} alt="" style={{ display: "block", borderRadius: 4 }} />
        spool
      </div>

      <h1 className="title">{spool.title || "Untitled spool"}</h1>
      <p className="byline">
        {mmss(spool.duration)}
        <span className="sep">·</span>
        recorded by an agent
        <span className="sep">·</span>
        spool
      </p>

      <Player src={spool.video} poster={poster} chapters={chapters} lines={lines} />

      {isOwner && <EditPanel spoolId={id} hasSources={hasSources} videoSrc={spool.video} />}

      <details className="agents">
        <summary>
          <span className="caret">›</span>
          For agents
        </summary>
        <div className="body">
          Machine-readable walkthrough data. <code>spool.json</code> indexes every step
          (narration, timings, keyframes); <code>console.jsonl</code> is the browser
          telemetry captured while recording.
          <div className="links">
            <a href={rawUrl}>spool.json →</a>
            <a href={consoleUrl}>console.jsonl →</a>
          </div>
        </div>
      </details>
    </main>
  );
}
