"use client";

import { useState } from "react";
import styles from "./dashboard.module.css";

// Plan panel: free shows usage + Upgrade; pro shows a badge + Manage billing.
// Both actions POST to a billing route and redirect to the Stripe-hosted url.
export function BillingCard({
  pro,
  used,
  billingParam,
}: {
  pro: boolean;
  used: number;
  billingParam?: string;
}) {
  const [busy, setBusy] = useState(false);

  async function go(path: string) {
    setBusy(true);
    try {
      const res = await fetch(path, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (data.url) window.location.href = data.url;
      else setBusy(false);
    } catch {
      setBusy(false);
    }
  }

  return (
    <section className={styles.token}>
      <div className={styles.tokenHead}>
        <span className={styles.label}>Plan</span>
        {pro ? (
          <button className={styles.ghost} onClick={() => go("/api/billing/portal")} disabled={busy}>
            {busy ? "Opening…" : "Manage billing"}
          </button>
        ) : (
          <button className={styles.ghost} onClick={() => go("/api/billing/checkout")} disabled={busy}>
            {busy ? "Redirecting…" : "Upgrade to Pro"}
          </button>
        )}
      </div>

      {pro ? (
        <p className={styles.tokenHint}>
          <span className={styles.planBadge}>Pro</span>
          Unlimited published spools, PR guides, and projects.
        </p>
      ) : (
        <p className={styles.tokenHint}>
          {used} of 3 free spools used. Published links stay live forever; upgrade to publish more.
        </p>
      )}

      {billingParam === "success" && (
        <p className={styles.billingNote}>Payment received. Your Pro plan will activate momentarily.</p>
      )}
      {billingParam === "cancelled" && (
        <p className={styles.billingNote}>Checkout cancelled. You can upgrade anytime.</p>
      )}
    </section>
  );
}
