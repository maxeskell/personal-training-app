import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The OAuth provider is the security boundary for the Cowork (HTTP) surface, so its lifecycle is
 * unit-tested end to end without a network: dynamic client registration, the coach-token-gated consent
 * (only the token-holder can mint a code), single-use codes, access-token verification, and refresh
 * rotation. PKCE itself is verified by the SDK's token handler; here we assert the pieces we own.
 */

function registerClient(p: any, id = "client-1") {
  return p.clientsStore.registerClient({
    client_id: id,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    token_endpoint_auth_method: "none",
  });
}

test("consent is gated by the coach token; only the holder can mint an authorization code", async () => {
  const { CoachOAuthProvider } = await import("../src/auth/coachOAuthProvider.js");
  const p = new CoachOAuthProvider("secret-token");
  const client = registerClient(p);
  assert.equal(p.clientsStore.getClient("client-1")?.client_id, "client-1");

  const base = { client_id: "client-1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", state: "xyz", code_challenge: "chal-123", scope: "coach" };

  // Wrong token → rejected, re-renders the form (no code issued).
  const bad = p.approve({ ...base, coach_token: "nope" });
  assert.equal(bad.ok, false);
  assert.equal(bad.status, 401);
  assert.match(bad.html, /Try again/); // re-renders the consent form with an error (apostrophe is HTML-escaped)

  // Unregistered redirect → rejected even with the right token.
  const badRedir = p.approve({ ...base, coach_token: "secret-token", redirect_uri: "https://evil.example/cb" });
  assert.equal(badRedir.ok, false);

  // Correct token + registered redirect → issues a code; redirect echoes code + state.
  const good = p.approve({ ...base, coach_token: "secret-token" });
  assert.equal(good.ok, true);
  const redir = new URL(good.redirect);
  const code = redir.searchParams.get("code");
  assert.ok(code && code.length > 10);
  assert.equal(redir.searchParams.get("state"), "xyz");

  // The stored PKCE challenge is retrievable for the right client, not another.
  assert.equal(await p.challengeForAuthorizationCode(client, code), "chal-123");
  await assert.rejects(() => p.challengeForAuthorizationCode({ ...client, client_id: "other" }, code));
});

test("authorization codes are single-use and exchange to verifiable access + refresh tokens", async () => {
  const { CoachOAuthProvider } = await import("../src/auth/coachOAuthProvider.js");
  const p = new CoachOAuthProvider("secret-token");
  const client = registerClient(p);
  const good = p.approve({ coach_token: "secret-token", client_id: "client-1", redirect_uri: "https://claude.ai/api/mcp/auth_callback", code_challenge: "c", scope: "coach" });
  const code = new URL(good.redirect).searchParams.get("code")!;

  const tokens = await p.exchangeAuthorizationCode(client, code);
  assert.equal(tokens.token_type, "bearer");
  assert.ok(tokens.access_token && tokens.refresh_token);
  assert.equal(tokens.scope, "coach");

  // Code is consumed — a replay fails.
  await assert.rejects(() => p.exchangeAuthorizationCode(client, code));

  // Access token verifies; junk doesn't.
  const info = await p.verifyAccessToken(tokens.access_token);
  assert.equal(info.clientId, "client-1");
  assert.deepEqual(info.scopes, ["coach"]);
  await assert.rejects(() => p.verifyAccessToken("garbage"));

  // Refresh rotates: a new access token is issued and the old refresh token is now spent.
  const refreshed = await p.exchangeRefreshToken(client, tokens.refresh_token!);
  assert.ok(refreshed.access_token && refreshed.access_token !== tokens.access_token);
  await assert.rejects(() => p.exchangeRefreshToken(client, tokens.refresh_token!));
  assert.ok(await p.verifyAccessToken(refreshed.access_token));
});

test("the consent page escapes interpolated values (no HTML injection via client/redirect)", async () => {
  const { CoachOAuthProvider } = await import("../src/auth/coachOAuthProvider.js");
  const p = new CoachOAuthProvider("secret-token");
  registerClient(p, "client-1");
  // A wrong-token attempt re-renders the form with the submitted values echoed into hidden fields.
  const r = p.approve({ coach_token: "wrong", client_id: "client-1", redirect_uri: 'https://x/cb"><script>alert(1)</script>', code_challenge: "c" });
  assert.equal(r.ok, false);
  assert.doesNotMatch(r.html, /<script>alert\(1\)<\/script>/);
  assert.match(r.html, /&lt;script&gt;/);
});
