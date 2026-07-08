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

  return (
    <main className={styles.wrap}>
      <header className={styles.bar}>
        <div className={styles.brand}>
          <span className={styles.dot} />
          spool
        </div>
        <UserButton afterSignOutUrl="/" />
      </header>

      <h1 className={styles.h1}>Your spools</h1>
      <p className={styles.sub}>
        Walkthroughs you&rsquo;ve published, and the token your agent uses to publish them.
      </p>

      <TokenCard hasToken={hasToken} />

      {rows.length === 0 ? (
        <div className={styles.empty}>
          No spools yet. Publish one with the <code>spool</code> CLI using your token above.
        </div>
      ) : (
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
