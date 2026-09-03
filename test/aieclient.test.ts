import { test } from "node:test";
import assert from "node:assert/strict";
import { AieClient, ReauthRequiredError, UnauthorizedError, withoutSseGet } from "../src/mcp/aieClient.js";

/**
 * The AI Endurance plan is read-only except through the write gate. Two structural guards enforce it,
 * both BEFORE any network call, so they're testable with no connection:
 *  - read() refuses a write-set tool outright (writes must use the gate);
 *  - callRaw() refuses a write-set tool unless the caller asserts `allowWrite` — and only WriteGate.confirm does.
 */

test("callRaw direct-write guard: a write tool is refused unless allowWrite is set", async () => {
  const aie = new AieClient();
  // No allowWrite → blocked by the guard before any connect/network happens.
  await assert.rejects(() => aie.callRaw("setZones", { foo: 1 }), /direct-write guard/);
  await assert.rejects(() => aie.callRaw("createSwimWorkout", {}), /direct-write guard/);
  // With allowWrite (what WriteGate.confirm passes) the guard is bypassed; it then fails ONLY because
  // there's no connection — proving the guard, not the network, was the gate above.
  await assert.rejects(() => aie.callRaw("setZones", {}, { allowWrite: true }), /not connected/);
});

test("read() refuses a write tool before the network — the gate is the only write path", async () => {
  const aie = new AieClient();
  await assert.rejects(() => aie.read("setZones" as never), /write gate/);
});

/**
 * ensureAuthorized() is the fix for the 30 Aug 2026 outage's second half: AI Endurance answers `initialize`
 * and `tools/list` WITHOUT a token, so "connected" proved nothing and `auth:aie` could report success while
 * caching no token. These wire fake SDK parts into the client (no network, no browser) and check the two
 * modes: headless surfaces the re-auth error (and fails fast afterwards); interactive runs the dance and
 * counts only a read with the fresh token as authorized.
 */
function rig(aie: AieClient, parts: { callTool: (n: number) => Promise<unknown>; code?: string }) {
  let calls = 0;
  const seen = { finishAuthCode: undefined as string | undefined, reopened: 0, requests: [] as unknown[] };
  const a = aie as unknown as Record<string, unknown>;
  // The client issues the RAW tools/call request (not Client.callTool) — see the callOnce comment.
  a.client = { request: (req: unknown) => { seen.requests.push(req); return parts.callTool(++calls); } };
  a.transport = { finishAuth: async (c: string) => { seen.finishAuthCode = c; }, close: async () => {} };
  a.auth = { waitForCode: async () => parts.code ?? "code-1" };
  a.open = async () => { seen.reopened += 1; }; // a real open() would hit the network; keep the fake client
  return { seen, calls: () => calls };
}

test("ensureAuthorized (headless): a read that needs re-auth surfaces ReauthRequiredError, then later calls fail fast", async () => {
  const aie = new AieClient({ interactive: false });
  const r = rig(aie, { callTool: async () => { throw new ReauthRequiredError(); } });
  await assert.rejects(() => aie.ensureAuthorized(), ReauthRequiredError);
  assert.equal(r.calls(), 1);
  await assert.rejects(() => aie.read("getPlannedWorkouts"), ReauthRequiredError);
  assert.equal(r.calls(), 1, "short-circuited: no second discovery/authorization round-trip per tool");
});

test("ensureAuthorized (interactive): a 401 runs the dance — wait for the code, finish auth, reconnect, re-read", async () => {
  const aie = new AieClient({ interactive: true });
  const r = rig(aie, {
    callTool: async (n) => {
      if (n === 1) throw new UnauthorizedError();
      return { content: [{ text: "{}" }] };
    },
    code: "abc",
  });
  await aie.ensureAuthorized();
  assert.equal(r.seen.finishAuthCode, "abc", "the browser's code was exchanged");
  assert.equal(r.seen.reopened, 1, "reconnected so the session carries the fresh token");
  assert.equal(r.calls(), 2, "the proof is a second read with the fresh token");
});

test("ensureAuthorized (interactive): a read that already works is enough — no browser dance", async () => {
  const aie = new AieClient({ interactive: true });
  const r = rig(aie, { callTool: async () => ({ content: [{ text: "{}" }] }) });
  await aie.ensureAuthorized();
  assert.equal(r.seen.finishAuthCode, undefined);
  assert.equal(r.seen.reopened, 0);
  assert.equal(r.calls(), 1);
});

test("read() issues a raw tools/call and returns a text-only result even when the tool declares an outputSchema", async () => {
  // Since ~1 Sep 2026 AIE declares an outputSchema on every tool but answers text-only; Client.callTool()
  // would throw "did not return structured content" on every read. The raw request must not.
  const aie = new AieClient({ interactive: false });
  const r = rig(aie, { callTool: async () => ({ content: [{ type: "text", text: "{\"user_type\":\"Triathlete\"}" }], isError: false }) });
  const res = (await aie.read("getUser")) as { content: Array<{ text: string }> };
  assert.equal(res.content[0].text, "{\"user_type\":\"Triathlete\"}");
  assert.deepEqual(r.seen.requests[0], { method: "tools/call", params: { name: "getUser", arguments: {} } });
  // An MCP-level tool error (isError) is still surfaced as a throw, never parsed as data.
  const bad = new AieClient({ interactive: false });
  rig(bad, { callTool: async () => ({ content: [{ type: "text", text: "boom" }], isError: true }) });
  await assert.rejects(() => bad.read("getUser"), /returned an error: boom/);
});

test("withoutSseGet: only the SDK's event-stream GET to the MCP url is answered 405 locally; all else passes through", async () => {
  const seen: string[] = [];
  const base = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${input instanceof URL ? input.href : String(input)}`);
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  const f = withoutSseGet("https://aie.example/mcp", base);
  const sse = await f(new URL("https://aie.example/mcp"), { method: "GET", headers: new Headers({ accept: "text/event-stream" }) });
  assert.equal(sse.status, 405, "the SDK treats 405 as 'no event stream offered' and moves on");
  await f(new URL("https://aie.example/mcp"), { method: "POST", headers: new Headers({ accept: "application/json, text/event-stream" }) });
  await f("https://aie.example/.well-known/oauth-authorization-server", { method: "GET" });
  assert.deepEqual(seen, ["POST https://aie.example/mcp", "GET https://aie.example/.well-known/oauth-authorization-server"]);
});
