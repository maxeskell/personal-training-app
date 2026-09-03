/**
 * Bounded retry for TRANSIENT connection failures in unattended flows (spec 11). The 06:00 ping used to
 * make one 20-second attempt at AI Endurance and exit; a run that landed in a macOS dark wake or before
 * Wi-Fi was up lost the whole day (eight such mornings in reports/ping.log, including the two that preceded
 * the 30 Aug 2026 token loss). Auth failures are never retried — a missing or rejected token doesn't heal
 * by waiting — and neither is an LLM budget abort (CoachLLM has its own single long-budget retry).
 */

export function isTransientConnectError(err: unknown): boolean {
  if ((err as { code?: unknown } | null)?.code === "AIE_REAUTH_REQUIRED") return false;
  const m = err instanceof Error ? err.message : String(err);
  if (/wall-clock budget/.test(m)) return false;
  return /timed out after|connect(ion)? timed out|fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|network error|Connection closed|Failed to forward JSON-RPC/i.test(m);
}

export interface RetryTransientOptions {
  /** Waits between attempts; attempts = delays + 1. Default 30 s then 60 s. */
  delaysMs?: number[];
  log?: (m: string) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

/** Run `fn`; on a transient error wait, then try again — at most `delaysMs.length` more times. */
export async function retryTransient<T>(fn: () => Promise<T>, opts: RetryTransientOptions = {}): Promise<T> {
  const delays = opts.delaysMs ?? [30_000, 60_000];
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i >= delays.length || !isTransientConnectError(err)) throw err;
      opts.log?.(`transient failure (${err instanceof Error ? err.message : String(err)}) — retrying in ${Math.round(delays[i] / 1000)} s (${i + 1}/${delays.length})`);
      await sleep(delays[i]);
    }
  }
}
