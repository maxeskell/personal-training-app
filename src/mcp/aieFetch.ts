import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { config } from "../config.js";
import { FileOAuthClientProvider, trackInflight } from "./oauthProvider.js";

/**
 * The fetch handed to the MCP transport — and, through it, to the SDK's OAuth flow (spec 11). Two jobs:
 *
 *  1. Answer the SDK's background event-stream GET with a local 405 (`withoutSseGet`): AI Endurance 401s
 *     that GET, and the SDK would start a second OAuth authorization from it — a second browser tab and a
 *     second PKCE verifier in the interactive `auth` flow, a wasted discovery round-trip headless.
 *  2. Guard the `refresh_token` grant: one process at a time (a proper-lockfile critical section on the
 *     token dir), re-reading the token file UNDER the lock so a refresh another process already completed
 *     is handed straight back instead of re-sent — a re-sent, already-rotated refresh token is
 *     `invalid_grant`, which is what retires the token file. The POST is tracked so a CLI can drain it
 *     before exiting (an exit mid-refresh is how the 30 Aug 2026 token was lost).
 */

export function withoutSseGet(serverUrl: string, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const accept = new Headers(init?.headers).get("accept") ?? "";
    if ((init?.method ?? "GET").toUpperCase() === "GET" && url === serverUrl && accept.includes("text/event-stream")) {
      return Promise.resolve(new Response(null, { status: 405, statusText: "Method Not Allowed" }));
    }
    return base(input, init);
  };
}

/** The refresh token a request is about to spend, or null when it's not a refresh_token grant. Pure. */
export function refreshTokenOf(init?: RequestInit): string | null {
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return null;
  const b = init?.body;
  if (!(b instanceof URLSearchParams) || b.get("grant_type") !== "refresh_token") return null;
  return b.get("refresh_token") || null;
}

export interface AieFetchOptions {
  base?: typeof fetch;
  /** Injectable lock for tests (defaults to proper-lockfile on <secretsDir>/aie-tokens.lock). */
  lock?: () => Promise<() => Promise<void>>;
}

export function aieFetch(provider: FileOAuthClientProvider, serverUrl: string, opts: AieFetchOptions = {}): typeof fetch {
  const base = opts.base ?? fetch;
  const lock = opts.lock ?? lockTokens;
  const sse = withoutSseGet(serverUrl, base);
  return async (input, init) => {
    const sent = refreshTokenOf(init);
    if (!sent) return sse(input, init);
    return trackInflight(guardedRefresh(provider, sent, () => base(input, init), lock));
  };
}

async function guardedRefresh(
  provider: FileOAuthClientProvider,
  sent: string,
  send: () => Promise<Response>,
  lock: () => Promise<() => Promise<void>>,
): Promise<Response> {
  const release = await lock();
  try {
    const disk = await provider.tokens();
    if (disk?.refresh_token && disk.refresh_token !== sent) {
      // Another process rotated the token while we waited for the lock: its result IS our result.
      provider.note("refresh-skipped-rotated", disk);
      return new Response(JSON.stringify(disk), { status: 200, headers: { "content-type": "application/json" } });
    }
    const res = await send();
    if (res.status === 400) {
      const body = (await res.clone().json().catch(() => null)) as { error?: string } | null;
      provider.note(`refresh-rejected(${body?.error ?? "400"})`);
    }
    return res;
  } finally {
    await release();
  }
}

/** Cross-process lock on the token dir (same primitive and options as the decision log's critical section). */
async function lockTokens(): Promise<() => Promise<void>> {
  const dir = config.secretsDir;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, "aie-tokens.lock");
  await appendFile(target, ""); // ensure the lock target exists (no-op if it already does)
  return lockfile.lock(target, {
    stale: 30_000, // longer than an AIE_TIMEOUT_MS refresh round-trip
    realpath: false,
    retries: { retries: 20, factor: 1.5, minTimeout: 100, maxTimeout: 1000 },
  });
}
