/**
 * Bounded retry-with-jitter for transient HTTP failures (429 rate-limit + 5xx server errors).
 *
 * Used on the read-only external spines (AI Endurance, Open-Meteo) so a single transient
 * blip degrades to a brief, capped retry instead of failing the whole flow. Deliberately NARROW: only
 * 429/5xx are retried — a 4xx is a caller error (don't hammer it) and a timeout/abort is a deliberate cap
 * we don't fight. Writes are NEVER retried by callers (a re-issued create/change could double-fire).
 *
 * Pure + fully injectable (sleep/random/clock) so the backoff maths is unit-tested without real waits.
 */

/** A transient HTTP failure worth retrying. Carries the status and any server-advised Retry-After (ms). */
export class RetryableHttpError extends Error {
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status?: number, retryAfterMs?: number) {
    super(message);
    this.name = "RetryableHttpError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** 429 (rate-limited) and 5xx (server) are transient; everything else is the caller's problem. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

/**
 * Parse a `Retry-After` header into milliseconds: either delta-seconds ("12") or an HTTP-date. Returns
 * undefined when absent/unparseable. `nowMs` is injectable so the HTTP-date branch is deterministic in tests.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number = Date.now()): number | undefined {
  if (headerValue == null) return undefined;
  const trimmed = String(headerValue).trim();
  if (!trimmed) return undefined;
  const secs = Number(trimmed);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(trimmed);
  if (Number.isFinite(when)) return Math.max(0, when - nowMs);
  return undefined;
}

/**
 * Best-effort classification of a thrown error message as a transient 429/5xx — for spines (the AI
 * Endurance MCP SDK) that surface HTTP failures as opaque thrown errors rather than a status code we can
 * read directly. Matches an HTTP status token or the common rate-limit/overload phrasings. Conservative:
 * an unmatched message is treated as non-retryable.
 */
export function looksLikeRetryableHttp(message: string): boolean {
  return (
    /\b429\b/.test(message) ||
    /\b5\d\d\b/.test(message) ||
    /rate.?limit|too many requests|overloaded|service unavailable|bad gateway|gateway timeout|internal server error/i.test(message)
  );
}

export interface RetryOptions {
  /** Total attempts including the first (default 3). */
  attempts?: number;
  /** Exponential backoff base in ms (default 300): wait ≈ random ∈ [0, base·2^i). */
  baseDelayMs?: number;
  /** Hard cap on any single wait, including a server Retry-After (default 8000). */
  maxDelayMs?: number;
  /** Whether an error is retryable. Default: `err instanceof RetryableHttpError`. */
  shouldRetry?: (err: unknown) => boolean;
  /** Server-advised delay (ms) for an error, if any. Default: the RetryableHttpError's retryAfterMs. */
  retryAfterMs?: (err: unknown) => number | undefined;
  /** Injectable sleep (default real setTimeout) — tests pass a no-op to avoid real waits. */
  sleep?: (ms: number) => Promise<void>;
  /** Injectable jitter source in [0,1) (default Math.random). */
  random?: () => number;
}

/**
 * Run `fn`, retrying on a retryable error up to `attempts` times with full-jitter backoff. Honours a
 * server Retry-After when present (capped at maxDelayMs). Rethrows the last error when attempts run out
 * or the error isn't retryable.
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const attempts = Math.max(1, opts.attempts ?? 3);
  const base = opts.baseDelayMs ?? 300;
  const cap = opts.maxDelayMs ?? 8000;
  const shouldRetry = opts.shouldRetry ?? ((e) => e instanceof RetryableHttpError);
  const retryAfter = opts.retryAfterMs ?? ((e) => (e instanceof RetryableHttpError ? e.retryAfterMs : undefined));
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const rand = opts.random ?? Math.random;

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !shouldRetry(err)) throw err;
      const advised = retryAfter(err);
      const backoff = Math.min(cap, base * 2 ** i);
      const wait = advised != null ? Math.min(cap, advised) : Math.floor(rand() * backoff);
      await sleep(wait);
    }
  }
  throw lastErr;
}
