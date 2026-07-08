"use client";

import { useState } from "react";
import styles from "./dashboard.module.css";

// Publish-token panel. The raw token only ever exists client-side right after
// generation (the server stores a hash), so we reveal it once here.
export function TokenCard({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const exists = hasToken || token !== null;

  async function generate() {
    setBusy(true);
    try {
      const res = await fetch("/api/token", { method: "POST" });
      const data = await res.json();
      if (data.token) setToken(data.token);
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }

  return (
    <section className={styles.token}>
      <div className={styles.tokenHead}>
        <span className={styles.label}>Publish token</span>
        <button className={styles.ghost} onClick={generate} disabled={busy}>
          {busy ? "Generating…" : exists ? "Regenerate" : "Generate token"}
        </button>
      </div>

      {token ? (
        <div className={styles.tokenReveal}>
          <code className={styles.tokenValue}>{token}</code>
          <button className={styles.copy} onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      ) : (
        <p className={styles.tokenHint}>
          {exists
            ? "A token exists but is shown only once. Regenerate to get a new one (this invalidates the old token)."
            : "Generate a token, then set it as SPOOL_PUBLISH_TOKEN for the spool CLI."}
        </p>
      )}
    </section>
  );
}
