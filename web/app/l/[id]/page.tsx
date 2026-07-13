import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { blobUrl, srcBlobUrl, mmss, type Spool } from "../../spool";
import { db } from "../../../db";
import { spools as spoolsTable } from "../../../db/schema";
import Watch, { type Chapter, type Line, type TourNode, type PrMeta } from "./Watch";
import { sans, serif } from "../../components/marketing/fonts";
import "./watch.css";

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

  // PR-guide mode: resolve each tour stop's step index to a video anchor, and
  // point the client at the diff + source blobs. Out-of-range index = unanchored.
  let pr: PrMeta | undefined;
  let tour: TourNode[] | undefined;
  let diffUrl: string | undefined;
  let prJsonUrl: string | undefined;
  let tourJsonUrl: string | undefined;
  if (spool.pr) {
    pr = {
      number: spool.pr.number,
      url: spool.pr.url,
      title: spool.pr.title,
      additions: spool.pr.additions,
      deletions: spool.pr.deletions,
      changedFiles: spool.pr.changedFiles,
    };
    tour = spool.pr.stops.map((s) => {
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
    diffUrl = srcBlobUrl(id, "pr/diff.patch");
    prJsonUrl = srcBlobUrl(id, "pr/pr.json");
    tourJsonUrl = srcBlobUrl(id, "pr/tour.json");
  }

  return (
    <div className={`${sans.variable} ${serif.variable}`}>
      <Watch
        title={spool.title || "Untitled spool"}
        durationLabel={mmss(spool.duration)}
        src={spool.video}
        poster={poster}
        chapters={chapters}
        lines={lines}
        isOwner={isOwner}
        hasSources={hasSources}
        spoolId={id}
        rawUrl={rawUrl}
        consoleUrl={consoleUrl}
        signedIn={!!userId}
        pr={pr}
        tour={tour}
        diffUrl={diffUrl}
        prJsonUrl={prJsonUrl}
        tourJsonUrl={tourJsonUrl}
      />
    </div>
  );
}
