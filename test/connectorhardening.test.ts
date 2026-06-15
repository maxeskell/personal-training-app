import { test } from "node:test";
import assert from "node:assert/strict";

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
