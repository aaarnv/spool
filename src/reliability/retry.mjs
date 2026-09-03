// One bounded retry, used by every CLI call that crosses the network (R6.3).
//
// Before this module each call site invented its own policy: the publish
// completion retried three times with its own backoff, the gate event tried once,
// and `spool read --plan` had neither a retry nor a timeout, so an unresponsive
// host could hang an agent forever. One helper, so "how does spool behave when the
// network is bad?" has one answer that a chaos test can hold it to.
//
// Two rules decide everything here:
//  1. Retry only what a retry can fix — a connection that never landed, a 429, a
//     5xx. A 4xx is an answer, not a hiccup, and retrying it is just slower.
//  2. Bound it. Attempts, per-attempt timeout and total backoff are all capped, so
//     the worst case is a number somebody can state rather than "eventually".

export const DEFAULT_ATTEMPTS = 3;
export const DEFAULT_BASE_MS = 250;
export const MAX_BACKOFF_MS = 4000;
export const DEFAULT_TIMEOUT_MS = 10_000;

const sleepReal = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Delay before attempt N+1: exponential, capped, with jitter.
 *
 * Jitter is drawn by the caller (`draw`, 0..1) so the schedule is deterministic in
 * a test. Full jitter rather than a fixed multiplier: several agents retrying the
 * same recovering host must not step in time.
 */
export function backoffMs(attempt, { baseMs = DEFAULT_BASE_MS, maxMs = MAX_BACKOFF_MS, draw = 0.5 } = {}) {
  const ceiling = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(ceiling * (0.5 + 0.5 * draw));
}

/** True for a status a retry could plausibly turn into a success. */
export const retryableStatus = (status) => status === 408 || status === 429 || (status >= 500 && status < 600);

/**
 * True for a thrown error a retry could fix: a connection that never completed, a
 * DNS failure, an aborted request. A programming error is not retried.
 */
export function retryableError(error) {
  const name = error?.name || '';
  if (name === 'TypeError') return true; // undici wraps connect/DNS failures as TypeError
  if (name === 'AbortError' || name === 'TimeoutError') return true;
  const code = error?.cause?.code || error?.code || '';
  return ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET'].includes(code);
}

/** `Retry-After`, in milliseconds, when the header names a delay we should honour. */
export function retryAfterMs(header, { maxMs = MAX_BACKOFF_MS } = {}) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(maxMs, Math.round(seconds * 1000));
  const at = Date.parse(header);
  if (Number.isFinite(at)) return Math.min(maxMs, Math.max(0, at - Date.now()));
  return null;
}

/**
 * Run `fn` until it succeeds or the attempts run out.
 *
 * `fn(attempt)` may return a value or throw. `shouldRetry(value)` decides whether
 * a returned value (an HTTP response, say) is worth another go, and may return a
 * delay in milliseconds to wait instead of `true`.
 *
 * Resolves `{ value, attempts, retried }`. `retried` is what the journal records
 * as the `retried` outcome: the operation succeeded, but a recovery path paid for
 * it. On exhaustion it throws the last error with `attempts` attached.
 */
export async function withRetry(fn, opts = {}) {
  const {
    attempts = DEFAULT_ATTEMPTS,
    baseMs = DEFAULT_BASE_MS,
    maxMs = MAX_BACKOFF_MS,
    shouldRetry = () => false,
    sleep = sleepReal,
    random = Math.random,
    onRetry = null,
  } = opts;

  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let value;
    let wait = null;
    try {
      value = await fn(attempt);
      const verdict = await shouldRetry(value, attempt);
      if (!verdict) return { value, attempts: attempt, retried: attempt > 1 };
      wait = typeof verdict === 'number' ? verdict : null;
      lastError = Object.assign(new Error(`attempt ${attempt} did not succeed`), { value });
    } catch (e) {
      if (!retryableError(e)) throw Object.assign(e, { attempts: attempt });
      lastError = e;
    }
    if (attempt === attempts) break;
    const delay = wait ?? backoffMs(attempt, { baseMs, maxMs, draw: random() });
    if (onRetry) onRetry({ attempt, delay, error: lastError });
    await sleep(delay);
  }
  throw Object.assign(lastError ?? new Error('retry failed'), { attempts });
}

/**
 * `fetch` with a per-attempt timeout and the bounded retry above.
 *
 * Only idempotent calls should use the retrying form. A call that creates
 * something needs an idempotency key the server dedupes on, and that key must be
 * generated ONCE outside this helper — a key regenerated per attempt makes a
 * retry a second write, which is the bug this whole module exists to prevent.
 */
export async function fetchWithRetry(url, init = {}, opts = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, retryOn = retryableStatus, ...rest } = opts;
  return withRetry(
    async () => {
      const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
      return await fetch(url, { ...init, signal });
    },
    {
      ...rest,
      shouldRetry: (res) => {
        if (!retryOn(res.status)) return false;
        return retryAfterMs(res.headers?.get?.('retry-after'), { maxMs: rest.maxMs ?? MAX_BACKOFF_MS }) ?? true;
      },
    }
  );
}
