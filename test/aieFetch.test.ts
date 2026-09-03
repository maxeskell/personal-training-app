import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The refresh guard (spec 11): the token file is shared by every process that talks to AI Endurance, the
 * refresh token rotates on use, and a re-sent already-rotated token is `invalid_grant` (which retires the
 * file). aieFetch serialises refreshes and answers a stale one from disk. All offline: a temp secrets dir,
 * an injected lock and a fake base fetch.
 */

async function withTempSecrets<T>(fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aie-fetch-"));
  const { config } = await import("../src/config.js");
  const prev = config.secretsDir;
  (config as { secretsDir: string }).secretsDir = dir;
  try {
    return await fn();
  } finally {
    (config as { secretsDir: string }).secretsDir = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("refreshTokenOf: only a POST whose URLSearchParams body is a refresh_token grant", async () => {
  const { refreshTokenOf } = await import("../src/mcp/aieFetch.js");
  assert.equal(refreshTokenOf({ method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "R1" }) }), "R1");
  assert.equal(refreshTokenOf({ method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: "c" }) }), null);
  assert.equal(refreshTokenOf({ method: "POST", body: JSON.stringify({ grant_type: "refresh_token" }) }), null);
  assert.equal(refreshTokenOf({ method: "GET" }), null);
});

test("aieFetch: a refresh whose token another process already rotated is answered from disk — the stale token is never re-sent", async () => {
  await withTempSecrets(async () => {
    const { FileOAuthClientProvider } = await import("../src/mcp/oauthProvider.js");
    const { aieFetch } = await import("../src/mcp/aieFetch.js");
    const lines: string[] = [];
    const p = new FileOAuthClientProvider({ interactive: false, log: (l) => lines.push(l) });
    await p.saveTokens({ access_token: "A2", refresh_token: "R2", token_type: "bearer" }); // the other process's rotation
    const calls: string[] = [];
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method} ${String(input)}`);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const f = aieFetch(p, "https://aie.example/mcp", { base, lock: async () => async () => {} });
    const res = await f("https://aie.example/api/o/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "R1" }) });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { refresh_token: string; access_token: string };
    assert.equal(body.refresh_token, "R2");
    assert.equal(body.access_token, "A2");
    assert.deepEqual(calls, [], "no network — the stale R1 grant was never sent");
    assert.ok(lines.some((l) => /event=refresh-skipped-rotated/.test(l)), lines.join(" | "));
  });
});

test("aieFetch: a refresh with the on-disk token is forwarded under the lock; a 400 invalid_grant is logged; other requests pass through", async () => {
  await withTempSecrets(async () => {
    const { FileOAuthClientProvider, drainInflight } = await import("../src/mcp/oauthProvider.js");
    const { aieFetch } = await import("../src/mcp/aieFetch.js");
    const lines: string[] = [];
    const p = new FileOAuthClientProvider({ interactive: false, log: (l) => lines.push(l) });
    await p.saveTokens({ access_token: "A1", refresh_token: "R1", token_type: "bearer" });
    const calls: string[] = [];
    let held = 0;
    const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${input instanceof URL ? input.href : String(input)}`);
      if (String(input).endsWith("/token")) {
        assert.equal(held, 1, "the token POST happens while the lock is held");
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const f = aieFetch(p, "https://aie.example/mcp", {
      base,
      lock: async () => {
        held++;
        return async () => {
          held--;
        };
      },
    });
    const res = await f("https://aie.example/api/o/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "R1" }) });
    assert.equal(res.status, 400);
    assert.equal(held, 0, "lock released after the round-trip");
    assert.ok(lines.some((l) => /event=refresh-rejected\(invalid_grant\)/.test(l)), lines.join(" | "));
    await f(new URL("https://aie.example/mcp"), { method: "POST", headers: new Headers({ accept: "application/json, text/event-stream" }) });
    const sse = await f(new URL("https://aie.example/mcp"), { method: "GET", headers: new Headers({ accept: "text/event-stream" }) });
    assert.equal(sse.status, 405, "the event-stream GET is still answered locally");
    assert.deepEqual(calls, ["POST https://aie.example/api/o/token", "POST https://aie.example/mcp"]);
    await drainInflight(1000);
  });
});

test("drainInflight: waits (bounded) for tracked token work and returns at once when nothing is in flight", async () => {
  const { trackInflight, drainInflight } = await import("../src/mcp/oauthProvider.js");
  let done = false;
  trackInflight(
    new Promise<void>((r) =>
      setTimeout(() => {
        done = true;
        r();
      }, 50),
    ),
  );
  await drainInflight(2000);
  assert.equal(done, true);
  const t0 = Date.now();
  await drainInflight(2000);
  assert.ok(Date.now() - t0 < 100, "nothing in flight → immediate");
});
