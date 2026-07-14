"use client";

import { useState } from "react";
import styles from "./dashboard.module.css";

const INSTALL_CMD =
  "curl -fsSL https://raw.githubusercontent.com/aaarnv/spool/master/install.sh | bash";
const RECORD_CMD = "spool live spool/my-demo --url http://localhost:3000";

// The whole onboarding as one paste for a coding agent. The fresh token rides
// inside (its only client-side appearance), so this is the shown-once moment.
const agentPrompt = (token: string) =>
  `Set up Spool in this project and record a first walkthrough video. Spool lets you (the agent) record real narrated demos: browser capture, AI voiceover, word-synced captions, a hosted watch link.

1. Install the CLI (needs node >= 20 and ffmpeg on PATH; the installer fetches chromium):
   ${INSTALL_CMD}
2. Save my publish token (covers publishing and hosted AI voice, no OpenAI key needed):
   echo '{"host":"https://spoolkit.dev","token":"${token}"}' > ~/.spool.json
3. Read the skill at ~/.spool/cli/skills/spool/SKILL.md and follow it for everything below.
4. Run \`spool init\` in this repo, survey the codebase, author the seed ops (overview, subsystems, vocabulary, and recording topics: how to run the app, auth, what demos well), then \`spool init --apply\`.
5. Record a short walkthrough of this app's main flow with \`spool live\`, then \`spool finish\` and \`spool publish\`.
6. Reply with the watch link.`;

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
// right after generation (the server stores a hash), so the agent prompt and the
// config command can only be rendered in that moment — we make it count.
// compact: the user has published spools, so the quickstart collapses to a slim
// token row (regenerate stays one click away).
export function TokenCard({ hasToken, compact = false }: { hasToken: boolean; compact?: boolean }) {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [promptCopied, setPromptCopied] = useState(false);
  const exists = hasToken || token !== null;

  async function generate(): Promise<string | null> {
    setBusy(true);
    try {
      const res = await fetch("/api/token", { method: "POST" });
      const data = await res.json();
      if (data.token) {
        setToken(data.token);
        return data.token;
      }
      return null;
    } finally {
      setBusy(false);
    }
  }

  // Primary path: one click mints the token and puts the full agent prompt on
  // the clipboard, so onboarding is a single paste into Claude Code or Codex.
  async function generateAndCopyPrompt() {
    const t = token ?? (await generate());
    if (!t) return;
    await navigator.clipboard.writeText(agentPrompt(t));
    setPromptCopied(true);
    setTimeout(() => setPromptCopied(false), 2000);
  }

  const configCmd = token
    ? `echo '{"host":"https://spoolkit.dev","token":"${token}"}' > ~/.spool.json`
    : null;

  if (compact) {
    return (
      <section className={styles.token}>
        <div className={styles.tokenHead}>
          <span className={styles.label}>Publish token</span>
          <button className={styles.ghost} onClick={() => generate()} disabled={busy}>
            {busy ? "Generating…" : "Regenerate token"}
          </button>
        </div>
        {configCmd ? (
          <>
            <Cmd text={configCmd} />
            <p className={styles.stepHint}>
              Shown once. Paste it into your terminal now; the old token is invalid.
            </p>
          </>
        ) : (
          <p className={styles.stepHint}>
            Your agent publishes with this token. Regenerating invalidates the old one.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className={styles.token}>
      <div className={styles.tokenHead}>
        <span className={styles.label}>Get set up</span>
        <button className={styles.primary} onClick={generateAndCopyPrompt} disabled={busy}>
          {busy
            ? "Generating…"
            : promptCopied
              ? "Prompt copied"
              : exists
                ? "Regenerate token, copy agent prompt"
                : "Copy prompt for your agent"}
        </button>
      </div>

      <p className={styles.stepHint}>
        One paste does everything: hand the prompt to Claude Code, Cursor, or Codex in your
        project and it installs the CLI, saves your token, seeds the project, and records your
        first spool. Your token rides inside the prompt and is shown only at generation
        {exists ? "; copying again mints a fresh one and invalidates the old" : ""}.
      </p>

      {token && (
        <pre className={styles.promptBox}>
          <code>{agentPrompt(token)}</code>
        </pre>
      )}

      <details className={styles.manual}>
        <summary>Set up manually instead</summary>
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
                  Shown once. One token covers publishing and hosted AI voice; no OpenAI key
                  needed.
                </p>
              </>
            ) : (
              <p className={styles.stepHint}>
                {exists
                  ? "Your token is shown only at generation. Use the button above to mint a fresh one (this invalidates the old token)."
                  : "Use the button above to mint a token; the ready-to-paste config command appears here."}
              </p>
            )}
          </li>

          <li className={styles.step}>
            <div className={styles.stepTitle}>Record and publish</div>
            <Cmd text={RECORD_CMD} />
            <p className={styles.stepHint}>
              Drive your app once, then <code>spool finish</code> and <code>spool publish</code>{" "}
              (add <code>--pr</code> to comment the link on your pull request). The agent skill
              ships in the repo at <code>skills/spool/SKILL.md</code>.
            </p>
          </li>
        </ol>
      </details>
    </section>
  );
}
