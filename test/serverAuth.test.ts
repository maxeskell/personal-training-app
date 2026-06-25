import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCookies, presentedToken, isAuthorized, timingSafeEqualStr, hostAllowed, parseAllowedHosts } from "../src/serverAuth.js";

test("parseCookies + presentedToken", () => {
  assert.deepEqual(parseCookies("a=1; coach_auth=tok; b=2"), { a: "1", coach_auth: "tok", b: "2" });
  assert.equal(presentedToken({ cookie: "coach_auth=tok" }), "tok");
  assert.equal(presentedToken({ "x-coach-token": "hdr" }), "hdr"); // header wins
  assert.equal(presentedToken({}), undefined);
});

test("timingSafeEqualStr / isAuthorized", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abd"), false);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false); // length differs
  assert.equal(timingSafeEqualStr("", ""), false); // empty never authorizes
  assert.equal(isAuthorized({ cookie: "coach_auth=secret" }, "secret"), true);
  assert.equal(isAuthorized({ "x-coach-token": "secret" }, "secret"), true);
  assert.equal(isAuthorized({ cookie: "coach_auth=nope" }, "secret"), false);
  assert.equal(isAuthorized({}, "secret"), false);
});

test("hostAllowed defeats DNS-rebinding", () => {
  assert.equal(hostAllowed("localhost:3000"), true);
  assert.equal(hostAllowed("127.0.0.1:3000"), true);
  assert.equal(hostAllowed("attacker.com:3000"), false); // rebound name → rejected
  assert.equal(hostAllowed("192.168.1.139:3000"), false); // LAN ip not allowed by default
  assert.equal(hostAllowed("192.168.1.139:3000", ["192.168.1.139"]), true); // allowed in LAN mode
  assert.equal(hostAllowed(undefined), false);
});

test("parseAllowedHosts normalizes COACH_ALLOWED_HOSTS", () => {
  assert.deepEqual(parseAllowedHosts(undefined), []);
  assert.deepEqual(parseAllowedHosts(""), []);
  assert.deepEqual(parseAllowedHosts("foo.ts.net"), ["foo.ts.net"]);
  assert.deepEqual(parseAllowedHosts("Foo.TS.net:3000"), ["foo.ts.net"]); // lower-cased, port stripped
  assert.deepEqual(parseAllowedHosts("https://foo.ts.net:3000"), ["foo.ts.net"]); // pasted URL tolerated
  assert.deepEqual(parseAllowedHosts("100.118.222.61, foo.ts.net"), ["100.118.222.61", "foo.ts.net"]);
});

test("a configured stable host reaches the dashboard", () => {
  const extra = parseAllowedHosts("100.118.222.61,maxs-macbook-neo.tail58512a.ts.net");
  assert.equal(hostAllowed("100.118.222.61:3000", extra), true);
  assert.equal(hostAllowed("maxs-macbook-neo.tail58512a.ts.net:3000", extra), true);
  assert.equal(hostAllowed("attacker.com:3000", extra), false); // still rejects everything else
});

test("server gates routes by token + host (integration)", async () => {
  process.env.COACH_TOKEN = "test-token-123";
  const { createCoachServer } = await import("../src/server.js");
  const server = createCoachServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  try {
    // No token → 401 on a mutating route, and it performs no work.
    const unauth = await fetch(`${base}/insight-feedback`, { method: "POST", body: "{}" });
    assert.equal(unauth.status, 401);

    // With the token header, a GET / is authorized (200).
    const ok = await fetch(`${base}/`, { headers: { "x-coach-token": "test-token-123" } });
    assert.equal(ok.status, 200);

    // Wrong token → still 401.
    const wrong = await fetch(`${base}/`, { headers: { "x-coach-token": "nope" } });
    assert.equal(wrong.status, 401);

    // The read-only digest view is token-gated like everything else, and degrades to a friendly empty
    // state (no digest in the test cwd) rather than erroring.
    assert.equal((await fetch(`${base}/digest`)).status, 401, "no token → 401");
    const digest = await fetch(`${base}/digest`, { headers: { "x-coach-token": "test-token-123" } });
    assert.equal(digest.status, 200);
    assert.match(await digest.text(), /research digest/i);

    // Oversized body → 413 (valid token + a route that always reads the body, so it's the size gate).
    const big = await fetch(`${base}/insight-feedback`, { method: "POST", headers: { "x-coach-token": "test-token-123" }, body: "x".repeat(70 * 1024) });
    assert.equal(big.status, 413);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    delete process.env.COACH_TOKEN;
  }
});
