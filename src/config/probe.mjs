// Validate a token against a cheap authed endpoint. POST /api/vo with an empty
// body: a bad token 401/403s before any usage is counted; a valid token 400s
// (missing text) with no side effect. Non-401/403 => auth accepted.
export async function probeToken(host, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    const res = await fetch(`${host}/api/vo`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "{}",
      signal: ctrl.signal,
    });
    return { ok: res.status !== 401 && res.status !== 403, status: res.status };
  } finally {
    clearTimeout(timer);
  }
}
