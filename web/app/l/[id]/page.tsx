import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { blobUrl, srcBlobUrl, mmss } from "../../spool";
import { db } from "../../../db";
import { spools as spoolsTable } from "../../../db/schema";
import { getSpool, playerModel } from "./data";
import Watch from "./Watch";
import { sans, serif } from "../../components/marketing/fonts";
import "./watch.css";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const spool = await getSpool(id);
  if (!spool) return { title: "Not found · spool" };
  const title = `${spool.title || "Untitled spool"} · spool`;
  const steps = spool.steps.length;
  const description = spool.pr
    ? `Narrated walkthrough of PR #${spool.pr.number} · ${steps} steps, ${mmss(spool.duration)}.`
    : steps > 0
      ? `${steps}-step narrated walkthrough · ${mmss(spool.duration)}.`
      : "A walkthrough recorded by an agent.";
  // spool.video / step frames are already absolute blob URLs (rewritten at publish).
  const poster = spool.steps[0]?.frame;
  return {
    title,
    description,
    openGraph: {
      type: "video.other",
      url: `https://spoolkit.dev/l/${id}`,
      siteName: "Spool",
      title,
      description,
      ...(poster && { images: [{ url: poster, alt: title }] }),
      videos: [{ url: spool.video, type: "video/mp4" }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      ...(poster && { images: [poster] }),
    },
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

  const model = playerModel(id, spool);
  const consoleUrl = blobUrl(id, "console.jsonl");
  const rawUrl = blobUrl(id, "spool.json");

  // A published context pack means bundle-grounded Q&A. Blob content is
  // immutable per id, so a cached HEAD is enough and needs no external SDK.
  let grounding: "bundle" | "diff" = "diff";
  if (spool.pr) {
    try {
      const res = await fetch(srcBlobUrl(id, "pr/context.json"), { method: "HEAD", cache: "force-cache" });
      grounding = res.ok ? "bundle" : "diff";
    } catch {
      grounding = "diff";
    }
  }

  return (
    <div className={`${sans.variable} ${serif.variable}`}>
      <Watch
        {...model}
        isOwner={isOwner}
        hasSources={hasSources}
        spoolId={id}
        rawUrl={rawUrl}
        consoleUrl={consoleUrl}
        signedIn={!!userId}
        grounding={grounding}
      />
    </div>
  );
}
