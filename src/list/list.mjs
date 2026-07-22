import { resolveConfig } from '../publish/publish.mjs';

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export async function listSpools({ host, token, limit = 20, json = false } = {}) {
  const cfg = await resolveConfig({ host, token });
  if (!cfg.host || !cfg.token) {
    console.error("Not connected. Run `spool login` (or set SPOOL_HOST / SPOOL_PUBLISH_TOKEN).");
    process.exit(1);
  }
  const res = await fetch(`${cfg.host}/api/spools?limit=${limit}`, {
    headers: { authorization: `Bearer ${cfg.token}` },
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`list failed: ${res.status} ${detail.slice(0, 200)}`);
  }
  const { spools } = await res.json();
  if (json) {
    console.log(JSON.stringify(spools, null, 2));
    return;
  }
  if (!spools.length) {
    console.log('no published spools yet. `spool publish <dir>` ships one.');
    return;
  }
  for (const s of spools) {
    const title = (s.title || 'Untitled').slice(0, 48).padEnd(48);
    const views = s.views ? `${s.views} view${s.views === 1 ? '' : 's'}` : '';
    const pr = s.prNumber ? `PR #${s.prNumber}` : '';
    const when = (s.createdAt || '').slice(0, 10);
    console.log(`${title}  ${when}  ${pr.padEnd(8)}  ${String(views).padEnd(9)}  ${s.url}`);
  }
}
