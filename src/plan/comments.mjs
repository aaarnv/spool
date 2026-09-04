// Comments on a published spool, for the agent that reads it.
//
// A comment is a note anchored to a moment (web/lib/spoolComments.ts). It never gates
// work — that is a plan's blocking rule and stays there — so this is a read, and a
// failed read is silence rather than an error: a digest must still print when the host
// is unreachable or the spool was never published.

import { resolveConfig } from '../publish/publish.mjs';
import { fetchWithRetry } from '../reliability/retry.mjs';

const WATCH_URL = /^https?:\/\/[^\s]+\/l\/([A-Za-z0-9_-]{16,})\/?$/;

/**
 * The unanswered comments on one published spool, oldest first.
 *
 * Takes the watch url the bundle recorded. Returns `[]` for anything that is not one,
 * and for every failure: the caller is a digest, not a gate.
 */
export async function openComments(watchUrl, opts = {}) {
  const match = String(watchUrl || '').match(WATCH_URL);
  if (!match) return [];
  const { token } = await resolveConfig(opts);
  if (!token) return [];
  try {
    const { value: res } = await fetchWithRetry(
      `${new URL(watchUrl).origin}/api/spools/${match[1]}/comments`,
      { headers: { authorization: `Bearer ${token}` } },
      { attempts: 2 }
    );
    if (!res.ok) return [];
    const data = await res.json();
    return (data.comments ?? [])
      .filter((c) => c.status === 'open' || c.status === 'answered')
      .map((c) => ({
        id: c.id,
        at: c.anchor?.label ?? 'the spool',
        author: c.author?.type === 'agent' ? 'an agent' : c.author?.type === 'owner' ? 'the owner' : 'a member',
        body: c.body,
      }));
  } catch {
    return [];
  }
}
