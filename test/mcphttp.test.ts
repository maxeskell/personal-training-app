import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * The HTTP/Cowork surface adds bearer-token auth and an optional read-only mode. These assert the pure
 * auth helpers and that the read-only toggle actually removes the write tools from the registered set
 * (verified through an in-memory MCP client — no network, no Ollama, no live AIE).
 */

test("bearerToken / bearerAuthorized parse and constant-time compare the Authorization header", async () => {
  const { bearerToken, bearerAuthorized } = await import("../src/serverAuth.js");
  assert.equal(bearerToken({ authorization: "Bearer abc123" }), "abc123");
  assert.equal(bearerToken({ authorization: "bearer  spaced  " }), "spaced");
  assert.equal(bearerToken({ authorization: "Basic abc" }), undefined);
  assert.equal(bearerToken({}), undefined);
  assert.equal(bearerAuthorized({ authorization: "Bearer s3cret" }, "s3cret"), true);
  assert.equal(bearerAuthorized({ authorization: "Bearer wrong" }, "s3cret"), false);
  assert.equal(bearerAuthorized({}, "s3cret"), false);
});

test("buildServer({ includeWrites: false }) drops the write tools but keeps the reads", async () => {
  const { buildServer } = await import("../src/mcpServer.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  async function toolNames(includeWrites: boolean): Promise<string[]> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = buildServer({ includeWrites });
    await server.connect(serverT);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(clientT);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name);
  }

  const writeTools = ["propose_adjustment", "confirm", "decline"];

  const ro = await toolNames(false);
  assert.ok(ro.includes("insights") && ro.includes("ask"), "read/analysis tools are kept");
  for (const w of writeTools) assert.ok(!ro.includes(w), `${w} is dropped in read-only mode`);

  const full = await toolNames(true);
  for (const w of writeTools) assert.ok(full.includes(w), `${w} is present by default`);
  assert.equal(full.length, ro.length + writeTools.length);
});

test("update_profile is gated by includeProfileWrite (off by default — opt-in on the remote surface)", async () => {
  const { buildServer } = await import("../src/mcpServer.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

  async function toolNames(opts: { includeWrites?: boolean; includeProfileWrite?: boolean }): Promise<string[]> {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = buildServer(opts);
    await server.connect(serverT);
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await client.connect(clientT);
    const { tools } = await client.listTools();
    await client.close();
    return tools.map((t) => t.name);
  }

  // Default (and a read-only remote surface) does NOT expose the local-file write tool.
  assert.ok(!(await toolNames({})).includes("update_profile"), "off by default");
  assert.ok(!(await toolNames({ includeWrites: false })).includes("update_profile"), "absent on a read-only surface unless opted in");
  // Opt-in (the local stdio surface passes this) exposes exactly update_profile, independent of AIE writes.
  assert.ok((await toolNames({ includeProfileWrite: true })).includes("update_profile"), "present when opted in");
  assert.ok((await toolNames({ includeWrites: false, includeProfileWrite: true })).includes("update_profile"), "opt-in works even on a read-only AIE surface");
});

test("httpStartupBanner spells out the exposed surface (incl. the medical profile) and escalates for risky configs", async () => {
  const { httpStartupBanner } = await import("../src/mcpHttp.js");
  const base = { host: "127.0.0.1", port: 8787, tokenFile: "/x/.endurance-coach/mcp.token" };

  // A read-only, token-authed server: names the data, says read-only, points at the token — no write/none scare lines.
  const tokenRO = httpStartupBanner({ ...base, auth: "token", includeWrites: false, profileWrite: false, fileAccess: false }).join("\n");
  assert.match(tokenRO, /MEDICAL profile via get_profile/);
  assert.match(tokenRO, /health metrics/);
  assert.match(tokenRO, /READ-ONLY/);
  assert.match(tokenRO, /every request needs your bearer token/);
  assert.doesNotMatch(tokenRO, /plan-WRITE/, "read-only mode doesn't advertise write tools");
  assert.doesNotMatch(tokenRO, /file-access/, "file access off → not advertised");
  assert.doesNotMatch(tokenRO, /auth=NONE/);

  // The dangerous combo (no auth + writes + profile-write + file-access) gets the loud lines.
  const none = httpStartupBanner({ ...base, auth: "none", includeWrites: true, profileWrite: true, fileAccess: true }).join("\n");
  assert.match(none, /auth=NONE: none of the above is password-protected/);
  assert.match(none, /plan-WRITE tools/);
  assert.match(none, /profile-write is ON/);
  assert.match(none, /file-access is ON/);
  assert.match(none, /read\/write project files/);
  assert.match(none, /PRIVATE tunnel/);
});
