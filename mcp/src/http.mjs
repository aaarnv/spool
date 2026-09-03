// One authed call to the platform, and one shape for the answer.
//
// Every tool in this server is a thin wrapper over an HTTP route documented in
// CONTRACTS.md, so this module deliberately does NOT reshape what it gets back. The
// payloads are additive-stable and agents downstream branch on the documented fields;
// a helpful rename here would break them in a way no test on this side would catch.
//
// What it does own is the boundary: the token goes to the configured host and nowhere
// else, a non-JSON answer becomes a readable error rather than a parse crash, and a
// refusal comes back as data (`ok: false` with the platform's own `reason`) instead of
// an exception, because a refusal is information an agent must read.

const USER_AGENT_PREFIX = 'spool-mcp';

/** A network failure or a timeout, as opposed to a refusal the platform authored. */
export class TransportError extends Error {
  constructor(message, { cause } = {}) {
    super(message, { cause });
    this.name = 'TransportError';
  }
}

function buildUrl(host, path, query) {
  const url = new URL(path, `${host}/`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

/**
 * Call one platform route.
 *
 * Returns `{ ok, status, data, raw }`. `ok` is the HTTP one: a 409 that names a
 * `reason` is a successful call with a refusal in it, and the tools above read it as
 * such. Throws only when there was no answer at all.
 */
export async function call(cfg, { method = 'GET', path, query, body, headers = {}, timeoutMs = 30_000, signal } = {}) {
  const url = buildUrl(cfg.host, path, query);
  const controller = new AbortController();
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      // The token is bound to cfg.host by construction: there is no per-call host, so a
      // watch link or a pasted id can never redirect the credential somewhere else.
      headers: {
        accept: 'application/json',
        'user-agent': `${USER_AGENT_PREFIX}/${cfg.version || '0'}`,
        ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'manual',
    });
  } catch (e) {
    throw new TransportError(`${method} ${url.pathname} failed: ${e?.message || e}`, { cause: e });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  const raw = await res.text().catch(() => '');
  let data = null;
  if (raw) {
    try {
      data = JSON.parse(raw);
    } catch {
      data = null;
    }
  }
  if (data === null && raw) {
    data = { error: `the host answered ${res.status} with a non-JSON body`, body: raw.slice(0, 400) };
  }
  return { ok: res.ok, status: res.status, data: data ?? {}, raw, headers: res.headers };
}
