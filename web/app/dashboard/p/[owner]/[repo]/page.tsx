import { auth } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import { and, desc, eq } from "drizzle-orm";
import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { blobUrl, mmss } from "../../../../spool";
import { db } from "../../../../../db";
import { spools as spoolsTable } from "../../../../../db/schema";
import { fetchKnowledge } from "../../../../../lib/knowledge";
import { SpoolCard } from "../../../SpoolCard";
import { KnowledgeManager } from "./KnowledgeManager";
import styles from "../../../dashboard.module.css";

export const dynamic = "force-dynamic";

// Same validation the knowledge API uses; keeps garbage owner/repo out.
const SEG = /^[A-Za-z0-9._-]{1,100}$/;

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ owner: string; repo: string }>;
}) {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const raw = await params;
  const owner = decodeURIComponent(raw.owner).toLowerCase();
  const repo = decodeURIComponent(raw.repo).toLowerCase();
  if (!SEG.test(owner) || owner === ".." || !SEG.test(repo) || repo === "..") notFound();

  const [knowledge, rows] = await Promise.all([
    fetchKnowledge(userId, owner, repo),
    db
      .select()
      .from(spoolsTable)
      .where(
        and(
          eq(spoolsTable.ownerId, userId),
          eq(spoolsTable.repoOwner, owner),
          eq(spoolsTable.repoName, repo)
        )
      )
      .orderBy(desc(spoolsTable.createdAt)),
  ]);

  const emptyStore =
    !knowledge.overview &&
    Object.keys(knowledge.subsystems).length === 0 &&
    Object.keys(knowledge.vocabulary).length === 0 &&
    Object.keys(knowledge.recording).length === 0 &&
    knowledge.decisions.length === 0;
  if (rows.length === 0 && emptyStore) notFound();

  const n = rows.length;

  return (
    <main className={styles.wrap}>
      <header className={styles.bar}>
        <div className={styles.brand}>
          <img src="/logo.svg" width={18} height={18} alt="" style={{ display: "block", borderRadius: 4 }} />
          spool
        </div>
        <UserButton afterSignOutUrl="/" />
      </header>

      <Link href="/dashboard" className={styles.back}>
        &larr; All spools
      </Link>
      <h1 className={styles.h1}>
        {owner}/{repo}
      </h1>
      <p className={styles.sub}>
        {n} {n === 1 ? "guide" : "guides"} &middot; shared knowledge grounds every guide&rsquo;s chat.
      </p>

      {n > 0 && (
        <div className={styles.grid}>
          {rows.map((s) => (
            <SpoolCard
              key={s.id}
              id={s.id}
              title={s.title || "Untitled spool"}
              meta={`${s.duration ? mmss(s.duration) : "—"} · ${fmtDate(s.createdAt)}`}
              poster={blobUrl(s.id, "frames/step_00.png")}
            />
          ))}
        </div>
      )}

      <KnowledgeManager owner={owner} repo={repo} initial={knowledge} />
    </main>
  );
}

function fmtDate(d: Date) {
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
