import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * Defense-in-depth on the internet-reachable OAuth surface: issued tokens are bound to THIS resource
 * (audience) and always carry the `coach` scope, and dynamic client registration refuses non-HTTPS /
 * non-loopback redirect URIs. Exercises the provider directly — no network.
 */

function registerClient(p: any, id = "client-1", redirect = "https://claude.ai/api/mcp/auth_callback") {
  return p.clientsStore.registerClient({
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: [redirect],
    token_endpoint_auth_method: "none",
  });
}

test("isAllowedRedirectUri: https + loopback allowed; other http and junk rejected", async () => {
  const { isAllowedRedirectUri } = await import("../src/auth/coachOAuthProvider.js");
  assert.equal(isAllowedRedirectUri("https://claude.ai/cb"), true);
  assert.equal(isAllowedRedirectUri("http://localhost:1234/cb"), true);
  assert.equal(isAllowedRedirectUri("http://127.0.0.1/cb"), true);
  assert.equal(isAllowedRedirectUri("http://attacker.example/cb"), false);
  assert.equal(isAllowedRedirectUri("ftp://x/cb"), false);
  assert.equal(isAllowedRedirectUri("not a url"), false);
});

test("dynamic client registration rejects a non-https / non-loopback redirect_uri", async () => {
  const { CoachOAuthProvider } = await import("../src/auth/coachOAuthProvider.js");
  const p = new CoachOAuthProvider("a-long-enough-token");
  assert.throws(() => registerClient(p, "evil", "http://attacker.example/cb"), /invalid redirect_uri/);
  assert.doesNotThrow(() => registerClient(p, "ok")); // a normal https client still registers
});

test("issued access tokens are audience-bound and always carry the coach scope", async () => {
  const { CoachOAuthProvider } = await import("../src/auth/coachOAuthProvider.js");
  const p = new CoachOAuthProvider("secret", "https://me.example/mcp");
  const client = registerClient(p);
  const approve = (resource: string) =>
    p.approve({ coach_token: "secret", client_id: "client-1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "c", resource });

  // A token minted for a DIFFERENT resource is rejected at verify time.
  const bad = approve("https://attacker.example/mcp");
  const badTok = await p.exchangeAuthorizationCode(client, new URL(bad.redirect).searchParams.get("code"));
  await assert.rejects(() => p.verifyAccessToken(badTok.access_token), /audience/);

  // A token minted for THIS resource verifies and carries `coach` even though none was requested.
  const good = approve("https://me.example/mcp");
  const goodTok = await p.exchangeAuthorizationCode(client, new URL(good.redirect).searchParams.get("code"));
  const info = await p.verifyAccessToken(goodTok.access_token);
  assert.ok(info.scopes.includes("coach"));
});

test("an unbound (no-resource) provider accepts its own tokens; refresh tokens rotate", async () => {
  const { CoachOAuthProvider } = await import("../src/auth/coachOAuthProvider.js");
  const p = new CoachOAuthProvider("secret"); // no resourceUrl → lenient audience check
  const client = registerClient(p);
  const good = p.approve({ coach_token: "secret", client_id: "client-1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "c" });
  const tok = await p.exchangeAuthorizationCode(client, new URL(good.redirect).searchParams.get("code"));
  assert.equal((await p.verifyAccessToken(tok.access_token)).clientId, "client-1"); // no resource bound → accepted
  const rotated = await p.exchangeRefreshToken(client, tok.refresh_token);
  assert.ok(rotated.access_token);
  await assert.rejects(() => p.exchangeRefreshToken(client, tok.refresh_token)); // old refresh consumed
});
