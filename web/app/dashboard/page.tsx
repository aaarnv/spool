import { auth } from "@clerk/nextjs/server";
import { UserButton } from "@clerk/nextjs";
import { desc, eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { blobUrl, mmss } from "../spool";
import { db } from "../../db";
import { spools as spoolsTable, publishTokens } from "../../db/schema";
import { TokenCard } from "./TokenCard";
import { SpoolCard } from "./SpoolCard";
import styles from "./dashboard.module.css";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const { userId } = await auth();
  if (!userId) redirect("/sign-in");

  const [rows, tokenCount] = await Promise.all([
    db
      .select()
      .from(spoolsTable)
      .where(eq(spoolsTable.ownerId, userId))
      .orderBy(desc(spoolsTable.createdAt)),
    db
      .select({ n: sql<number>`count(*)` })
      .from(publishTokens)
      .where(eq(publishTokens.ownerId, userId)),
  ]);
  const hasToken = Number(tokenCount[0]?.n ?? 0) > 0;

  // Group guides by their project (repoOwner/repoName) in first-appearance order
  // (rows are already createdAt desc). Guides without a project fall to the last
  // "Other spools" bucket. When no named project exists we render today's exact
  // layout with no headings, so single-repo and legacy users see no change.
  type Row = (typeof rows)[number];
  const groups = new Map<string, Row[]>();
  const other: Row[] = [];
  for (const s of rows) {
    const key = s.repoOwner && s.repoName ? `${s.repoOwner}/${s.repoName}` : null;
    if (key === null) {
      other.push(s);
      continue;
    }
    const arr = groups.get(key);
    if (arr) arr.push(s);
    else groups.set(key, [s]);
  }
  const hasNamedGroups = groups.size > 0;

  const renderCard = (s: Row) => (
    <SpoolCard
      key={s.id}
      id={s.id}
      title={s.title || "Untitled spool"}
      meta={`${s.duration ? mmss(s.duration) : "—"} · ${fmtDate(s.createdAt)}`}
      poster={blobUrl(s.id, "frames/step_00.png")}
    />
  );

  return (
    <main className={styles.wrap}>
      <header className={styles.bar}>
        <div className={styles.brand}>
          <img src="/logo.svg" width={18} height={18} alt="" style={{ display: "block", borderRadius: 4 }} />
          spool
        </div>
        <UserButton afterSignOutUrl="/" />
      </header>

      <h1 className={styles.h1}>Your spools</h1>
      <p className={styles.sub}>
        Walkthroughs you&rsquo;ve published, and the token your agent uses to publish them.
      </p>

      <TokenCard hasToken={hasToken} compact={rows.length > 0} />

      {rows.length === 0 ? (
        <div className={styles.empty}>
          No spools yet. Publish one with the <code>spool</code> CLI using your token above.
        </div>
      ) : !hasNamedGroups ? (
        <div className={styles.grid}>{rows.map(renderCard)}</div>
      ) : (
        <>
          {[...groups].map(([key, gr]) => (
            <section key={key}>
              <h2 className={styles.groupHead}>{key}</h2>
              <div className={styles.grid}>{gr.map(renderCard)}</div>
            </section>
          ))}
          {other.length > 0 && (
            <section>
              <h2 className={styles.groupHead}>Other spools</h2>
              <div className={styles.grid}>{other.map(renderCard)}</div>
            </section>
          )}
        </>
      )}
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
