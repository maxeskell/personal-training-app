import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * With persist=true the OAuth provider writes registered clients + issued tokens to disk (0600) and
 * reloads them on construct, so a Cowork connection survives a server restart with no re-authorization.
 * Short-lived auth codes are never persisted. These simulate a restart with a fresh provider instance.
 */

function reg(p: any, id = "c1") {
  return p.clientsStore.registerClient({ client_id: id, client_id_issued_at: 0, redirect_uris: ["https://claude.ai/cb"], token_endpoint_auth_method: "none" });
}
async function mintToken(p: any) {
  const client = reg(p);
  const good = p.approve({ coach_token: "secret", client_id: "c1", redirect_uri: "https://claude.ai/cb", code_challenge: "x", resource: "https://me.example/mcp" });
  return { client, tok: await p.exchangeAuthorizationCode(client, new URL(good.redirect).searchParams.get("code")) };
}

async function withTempSecrets(fn: (provider: typeof import("../src/auth/coachOAuthProvider.js").CoachOAuthProvider) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "coach-oauth-"));
  const { config } = await import("../src/config.js");
  const prev = config.secretsDir;
  (config as { secretsDir: string }).secretsDir = dir;
  try {
    const { CoachOAuthProvider } = await import("../src/auth/coachOAuthProvider.js");
    await fn(CoachOAuthProvider);
  } finally {
    (config as { secretsDir: string }).secretsDir = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("persist=true: a registered client + issued token survive a restart (new provider instance)", async () => {
  await withTempSecrets(async (CoachOAuthProvider) => {
    const p1 = new CoachOAuthProvider("secret", "https://me.example/mcp", { persist: true });
    const { tok } = await mintToken(p1);

    // Simulate a restart: a brand-new provider must reload state from disk.
    const p2 = new CoachOAuthProvider("secret", "https://me.example/mcp", { persist: true });
    assert.ok(p2.clientsStore.getClient("c1"), "the registered client survived the restart");
    assert.equal((await p2.verifyAccessToken(tok.access_token)).clientId, "c1"); // access token still valid
    const refreshed = await p2.exchangeRefreshToken(p2.clientsStore.getClient("c1")!, tok.refresh_token!);
    assert.ok(refreshed.access_token, "refresh works on the reloaded instance");
  });
});

test("persist=false (default): a new provider has no memory of prior tokens", async () => {
  await withTempSecrets(async (CoachOAuthProvider) => {
    const p1 = new CoachOAuthProvider("secret", "https://me.example/mcp"); // no persistence
    const { tok } = await mintToken(p1);
    const p2 = new CoachOAuthProvider("secret", "https://me.example/mcp");
    assert.equal(p2.clientsStore.getClient("c1"), undefined);
    await assert.rejects(() => p2.verifyAccessToken(tok.access_token), /invalid_token/);
  });
});
