"use client";

import { useState } from "react";
import styles from "./dashboard.module.css";

const INSTALL_CMD =
  "curl -fsSL https://raw.githubusercontent.com/aaarnv/spool/master/install.sh | bash";
const RECORD_CMD = "spool live spool/my-demo --url http://localhost:3000";

// One-line command with a copy affordance; used by the quickstart steps.
function Cmd({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }
  return (
    <div className={styles.cmd}>
      <code className={styles.cmdText}>{text}</code>
      <button className={styles.copy} onClick={copy}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

// Quickstart + publish-token panel. The raw token only ever exists client-side
// right after generation (the server stores a hash), so the ready-to-paste
// config command can only be rendered in that moment — we make it count.
export function TokenCard({ hasToken }: { hasToken: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
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

  const configCmd = token
    ? `echo '{"host":"https://spoolkit.dev","token":"${token}"}' > ~/.spool.json`
    : null;

  return (
    <section className={styles.token}>
      <div className={styles.tokenHead}>
        <span className={styles.label}>Get set up</span>
        <button className={styles.ghost} onClick={generate} disabled={busy}>
          {busy ? "Generating…" : exists ? "Regenerate token" : "Generate token"}
        </button>
      </div>

      <ol className={styles.steps}>
        <li className={styles.step}>
          <div className={styles.stepTitle}>Install the CLI</div>
          <Cmd text={INSTALL_CMD} />
        </li>

        <li className={styles.step}>
          <div className={styles.stepTitle}>Save your token</div>
          {configCmd ? (
            <>
              <Cmd text={configCmd} />
              <p className={styles.stepHint}>
                Shown once — paste it into your terminal now. One token covers publishing and
                hosted AI voice; no OpenAI key needed.
              </p>
            </>
          ) : (
            <p className={styles.stepHint}>
              {exists
                ? "Your token is shown only at generation. Regenerate to get a fresh, ready-to-paste config command (this invalidates the old token)."
                : "Generate a token above — you'll get a ready-to-paste config command. It covers publishing and hosted AI voice; no OpenAI key needed."}
            </p>
          )}
        </li>

        <li className={styles.step}>
          <div className={styles.stepTitle}>Record and publish</div>
          <Cmd text={RECORD_CMD} />
          <p className={styles.stepHint}>
            Drive your app once, then <code>spool finish</code> and <code>spool publish</code>{" "}
            (add <code>--pr</code> to comment the link on your pull request). Using a coding
            agent? Just say &ldquo;make a spool of this feature&rdquo; — the agent skill ships in the repo
            at <code>skills/spool/SKILL.md</code>.
          </p>
        </li>
      </ol>
    </section>
  );
}
