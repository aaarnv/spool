import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getSpool, playerModel } from "../../l/[id]/data";
import Embed from "./Embed";
import { sans, serif } from "../../components/marketing/fonts";
import "../../l/[id]/watch.css";
import "./embed.css";

// Embeds render inside third-party iframes; keep them out of search indexes.
export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const spool = await getSpool(id);
  return {
    title: spool?.title ? `${spool.title} · spool` : "spool",
    robots: { index: false, follow: false },
  };
}

export default async function EmbedPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const spool = await getSpool(id);
  if (!spool) notFound();

  const model = playerModel(id, spool);
  return (
    <div className={`${sans.variable} ${serif.variable}`}>
      <Embed spoolId={id} {...model} />
    </div>
  );
}
