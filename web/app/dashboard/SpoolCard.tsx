"use client";

import { useState } from "react";
import Link from "next/link";
import styles from "./dashboard.module.css";

export function SpoolCard({
  id,
  title,
  meta,
  poster,
}: {
  id: string;
  title: string;
  meta: string;
  poster: string;
}) {
  const [gone, setGone] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  if (gone) return null;

  async function copyLink() {
    await navigator.clipboard.writeText(`${location.origin}/l/${id}`);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  async function remove() {
    if (!confirm("Delete this spool? This removes the video and its link.")) return;
    setBusy(true);
    const res = await fetch(`/api/spools/${id}`, { method: "DELETE" });
    if (res.ok) setGone(true);
    else setBusy(false);
  }

  return (
    <div className={styles.card} data-busy={busy}>
      <Link href={`/l/${id}`} className={styles.thumb}>
        {/* poster is a deterministic blob URL; may 404 briefly before frames upload */}
        <img src={poster} alt="" loading="lazy" />
      </Link>
      <div className={styles.cardBody}>
        <Link href={`/l/${id}`} className={styles.cardTitle}>
          {title}
        </Link>
        <div className={styles.cardMeta}>{meta}</div>
        <div className={styles.cardActions}>
          <button className={styles.act} onClick={copyLink}>
            {copied ? "Copied" : "Copy link"}
          </button>
          <button className={styles.actDanger} onClick={remove} disabled={busy}>
            {busy ? "Deleting…" : "Delete"}
          </button>
        </div>
      </div>
    </div>
  );
}
