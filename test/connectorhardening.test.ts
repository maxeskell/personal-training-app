import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Point config.secretsDir at a throwaway dir for the duration of `fn` — the real token dir is never touched. */
async function withTempSecrets<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "aie-oauth-"));
  const { config } = await import("../src/config.js");
  const prev = config.secretsDir;
  (config as { secretsDir: string }).secretsDir = dir;
  try {
    return await fn(dir);
  } finally {
    (config as { secretsDir: string }).secretsDir = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Hardening for the connector's failure modes (the "looks like the whole MCP died" class of bug):
 *  - a headless context (server/dashboard/cron/Cowork) must NEVER fall into the interactive browser dance
 *    — it fails fast with a ReauthRequiredError instead of holding the loopback port and blocking minutes;
 *  - the /health body is shaped so an outside check can tell "up" from "needs re-auth" from "unreachable";
 *  - the remote self-check interprets those into a pass/fail verdict. All pure — no network.
 */

test("FileOAuthClientProvider: non-interactive redirectToAuthorization fails fast (no browser, no port)", async () => {
  const { FileOAuthClientProvider, ReauthRequiredError } = await import("../src/mcp/oauthProvider.js");
  const p = new FileOAuthClientProvider({ interactive: false });
  await assert.rejects(
    () => p.redirectToAuthorization(new URL("https://aiendurance.com/authorize?x=1")),
    (err: unknown) => err instanceof ReauthRequiredError && (err as { code: string }).code === "AIE_REAUTH_REQUIRED",
  );
  // It must not have started an auth flow at all (no loopback listener / pending code wait).
  await assert.rejects(async () => p.waitForCode(50), /no flow in progress/);
});

test("ReauthRequiredError carries an actionable, stable message + code", async () => {
  const { ReauthRequiredError } = await import("../src/mcp/aieClient.js"); // re-exported from the client
  const e = new ReauthRequiredError();
  assert.equal(e.name, "ReauthRequiredError");
  assert.equal(e.code, "AIE_REAUTH_REQUIRED");
  assert.match(e.message, /npm run auth:aie/);
});

test("baseHealth: cheap, no-network snapshot with the expected shape", async () => {
  const { baseHealth } = await import("../src/health.js");
  const info = baseHealth(new Date("2026-06-15T12:00:00.000Z"));
  assert.equal(info.service, "endurance-coach-mcp");
  assert.equal(info.status, "ok");
  assert.equal(info.time, "2026-06-15T12:00:00.000Z");
  assert.equal(info.aie, undefined, "shallow health does not probe AI Endurance");
  assert.equal(typeof info.readOnly, "boolean");
});

test("interpretRemoteHealth: maps status + body to a verdict", async () => {
  const { interpretRemoteHealth } = await import("../src/health.js");

  assert.equal(interpretRemoteHealth(null, undefined).ok, false, "no response = down");
  assert.match(interpretRemoteHealth(null, undefined).detail, /tunnel or the server/);

  assert.equal(interpretRemoteHealth(503, {}).ok, false, "non-200 = unhealthy");

  assert.equal(interpretRemoteHealth(200, { status: "ok", aie: "ok" }).ok, true);

  const reauth = interpretRemoteHealth(200, { status: "degraded", aie: "reauth_needed" });
  assert.equal(reauth.ok, false);
  assert.match(reauth.detail, /auth:aie/);

  assert.equal(interpretRemoteHealth(200, { status: "degraded", aie: "unreachable" }).ok, false);
});

test("checkRemoteHealth: hits <base>/health?deep=1 with an injected fetch; degrades on throw", async () => {
  const { checkRemoteHealth } = await import("../src/health.js");

  let calledUrl = "";
  const okFetch = (async (url: string) => {
    calledUrl = url;
    return { status: 200, json: async () => ({ status: "ok", aie: "ok" }) } as unknown as Response;
  }) as unknown as typeof fetch;
  const ok = await checkRemoteHealth("https://x.ts.net/", okFetch);
  assert.equal(ok.ok, true);
  assert.equal(calledUrl, "https://x.ts.net/health?deep=1", "trailing slash trimmed, deep probe requested");

  const throwFetch = (async () => {
    throw new Error("ETIMEDOUT");
  }) as unknown as typeof fetch;
  const down = await checkRemoteHealth("https://x.ts.net", throwFetch);
  assert.equal(down.ok, false, "a fetch throw (tunnel down) is a clean fail, not an exception");
});

/**
 * Token-lifecycle hardening after the 30 Aug 2026 outage (docs/specs/improvements/11-aie-token-loss-and-blind-reauth.md):
 *  - the SDK calls invalidateCredentials('tokens') on an invalid_grant refresh; the provider must RETIRE the
 *    only copy (timestamped, 0600), never rm it, and leave an audit line that carries no secret;
 *  - saves are atomic; one authorization flow at a time (a second redirect reuses the listener and the verifier);
 *  - the health probe's verdict comes from an authenticated read, not from connect() (AIE answers initialize
 *    without a token). All offline: temp secrets dir, injected browser launcher, fake client.
 */

test("FileOAuthClientProvider: a rejected refresh retires the token file (forensic copy) instead of deleting it; saves are atomic", async () => {
  await withTempSecrets(async (dir) => {
    const { FileOAuthClientProvider, RETIRED_TOKENS_PREFIX } = await import("../src/mcp/oauthProvider.js");
    const lines: string[] = [];
    const p = new FileOAuthClientProvider({ interactive: false, log: (l) => lines.push(l) });

    await p.saveTokens({ access_token: "A1", refresh_token: "R1", token_type: "bearer" });
    assert.deepEqual((await readdir(dir)).filter((f) => f.endsWith(".tmp")), [], "atomic write leaves no temp file behind");
    assert.equal((await stat(join(dir, "aie-tokens.json"))).mode & 0o777, 0o600);
    assert.equal((await p.tokens())?.refresh_token, "R1");

    await p.invalidateCredentials("tokens"); // exactly what the SDK does on `invalid_grant`
    assert.equal(await p.tokens(), undefined, "the live file is gone, so the SDK falls through to a fresh authorization");
    const kept = (await readdir(dir)).filter((f) => f.startsWith(RETIRED_TOKENS_PREFIX));
    assert.equal(kept.length, 1, "…but a timestamped copy is kept");
    assert.equal(JSON.parse(await readFile(join(dir, kept[0]), "utf8")).refresh_token, "R1");
    assert.equal((await stat(join(dir, kept[0]))).mode & 0o777, 0o600, "the retired copy keeps the 0600 mode");

    assert.ok(lines.some((l) => /event=saved refresh=[0-9a-f]{8}/.test(l)), `a save is logged with a fingerprint: ${lines.join(" | ")}`);
    assert.ok(lines.some((l) => /event=invalidated\(tokens\) kept=aie-tokens\.revoked-/.test(l)), "the retirement is logged with the copy's name");
    assert.ok(lines.every((l) => !l.includes("R1") && !l.includes("A1")), "audit lines never carry token values");

    await p.invalidateCredentials("tokens"); // idempotent: nothing to retire the second time
    assert.ok(lines.some((l) => /event=invalidated\(tokens\) no-token-file/.test(l)));
  });
});

test("FileOAuthClientProvider: one authorization flow at a time — a second redirect reuses the listener and keeps the first verifier", async () => {
  await withTempSecrets(async () => {
    const { config } = await import("../src/config.js");
    const { FileOAuthClientProvider } = await import("../src/mcp/oauthProvider.js");
    const prevPort = config.aie.redirectPort;
    (config.aie as { redirectPort: number }).redirectPort = 48765; // never the real 8765 — a live auth may be using it
    const opened: string[] = [];
    const p = new FileOAuthClientProvider({ interactive: true, openBrowser: async (u) => { opened.push(u); }, log: () => {} });
    try {
      await p.saveCodeVerifier("v1");
      await p.redirectToAuthorization(new URL("https://aie.example/authorize?code_challenge=c1"));
      assert.equal(p.authorizationInProgress, true);
      // The SDK starting a second flow mid-dance (it did, from its event-stream GET) must be a no-op…
      await p.saveCodeVerifier("v2");
      await p.redirectToAuthorization(new URL("https://aie.example/authorize?code_challenge=c2"));
      assert.deepEqual(opened, ["https://aie.example/authorize?code_challenge=c1"], "one browser tab, the first one");
      assert.equal(await p.codeVerifier(), "v1", "…and must not overwrite the verifier the open tab was issued with");
      // The redirect lands on the loopback → waitForCode resolves with it and the port is released.
      const res = await fetch(`http://127.0.0.1:${config.aie.redirectPort}/callback?code=xyz`);
      assert.equal(res.status, 200);
      assert.equal(await p.waitForCode(2_000), "xyz");
      assert.equal(p.authorizationInProgress, false, "listener closed once the flow settled");
    } finally {
      (config.aie as { redirectPort: number }).redirectPort = prevPort;
    }
  });
});

test("aieHealthProbe: connect alone is not health — the verdict comes from an authenticated read", async () => {
  const { aieHealthProbe } = await import("../src/health.js");
  const { ReauthRequiredError } = await import("../src/mcp/aieClient.js");
  const fake = (read: () => Promise<unknown>, connect: () => Promise<void> = async () => {}) => () => ({ connect, read, close: async () => {} });
  assert.equal(await aieHealthProbe(1000, fake(async () => ({}))), "ok");
  assert.equal(
    await aieHealthProbe(1000, fake(async () => { throw new ReauthRequiredError(); })),
    "reauth_needed",
    "a connect that succeeds with no/rejected token is still reauth_needed (the 30 Aug blind spot)",
  );
  assert.equal(await aieHealthProbe(1000, fake(async () => { throw new Error("AIE tool getUser failed: 503"); })), "unreachable");
  assert.equal(await aieHealthProbe(1000, fake(async () => ({}), async () => { throw new Error("connect timed out"); })), "unreachable");
});
