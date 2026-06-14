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
