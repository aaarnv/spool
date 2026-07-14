// Ops alerting: log-first (Vercel keeps all logs), then a throttled Discord ping.
// Never throws — callers await it from catch paths without a second try/catch.

// Per-instance throttle (module-level Map, not global): a serverless box may miss
// pings sent from a sibling instance. Acceptable for noisy-alert suppression.
const lastSent = new Map<string, number>();
const THROTTLE_MS = 30 * 60 * 1000;
const MAX_CONTENT = 1900;

export async function sendOpsAlert(
  subject: string,
  detail: string,
  opts?: { key?: string }
): Promise<void> {
  console.error(`[ops-alert] ${subject}\n${detail}`);

  const url = process.env.DISCORD_ALERT_WEBHOOK_URL;
  if (!url) {
    console.error("[ops-alert] DISCORD_ALERT_WEBHOOK_URL unset");
    return;
  }

  const key = opts?.key ?? subject;
  const now = Date.now();
  const prev = lastSent.get(key);
  if (prev && now - prev < THROTTLE_MS) return;
  lastSent.set(key, now);

  const content = `**[spool] ${subject}**\n${detail}`.slice(0, MAX_CONTENT);
  await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(3000),
  }).catch((e) => console.error("[ops-alert] discord post failed", (e as Error).message));
}
