// Nudge the scale-to-zero Fly render worker to start polling. Awaited with a short
// timeout so it actually fires on serverless (an un-awaited fetch may be dropped),
// but never throws — the 10-min /api/edit-jobs/wake cron is the safety net for a
// missed nudge. No-op when the Fly env isn't configured (preview/local).
export async function wakeWorker(): Promise<void> {
  const token = process.env.FLY_WAKE_TOKEN;
  const app = process.env.FLY_APP;
  const machine = process.env.FLY_MACHINE_ID;
  if (!token || !app || !machine) return;
  try {
    await fetch(`https://api.machines.dev/v1/apps/${app}/machines/${machine}/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    /* already running, cold, or unreachable — cron covers it */
  }
}
