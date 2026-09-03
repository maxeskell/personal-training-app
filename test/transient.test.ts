import { test } from "node:test";
import assert from "node:assert/strict";
import { isTransientConnectError, retryTransient } from "../src/util/transient.js";
import { ReauthRequiredError } from "../src/mcp/oauthProvider.js";
import { shouldRetryWithLongBudget } from "../src/llm/client.js";

/**
 * Unattended-flow retries (spec 11): a transient connect failure gets bounded retries; auth errors and LLM
 * budget aborts never do (waiting doesn't heal a missing token, and the LLM has its own single retry).
 */

test("isTransientConnectError: connect timeouts and network blips yes; re-auth and LLM budget aborts no", () => {
  assert.equal(isTransientConnectError(new Error("AI Endurance connect timed out after 20000ms")), true);
  assert.equal(isTransientConnectError(new Error("Streamable HTTP error: Error POSTing to endpoint: {\"error\":\"Failed to forward JSON-RPC message\",\"details\":\"fetch failed\"}")), true);
  assert.equal(isTransientConnectError(new Error("connect ECONNREFUSED 1.2.3.4:443")), true);
  assert.equal(isTransientConnectError(new ReauthRequiredError()), false, "a missing token is not transient");
  assert.equal(isTransientConnectError(new Error("CoachLLM readiness call exceeded its 120000ms wall-clock budget (COACH_LLM_TIMEOUT_MS).")), false);
  assert.equal(isTransientConnectError(new Error("AIE tool getUser failed: MCP error -32600: bad shape")), false);
});

test("retryTransient: retries a transient error with the given delays, gives up after them, never retries a non-transient one", async () => {
  const slept: number[] = [];
  const sleep = async (ms: number) => {
    slept.push(ms);
  };
  let n = 0;
  const flaky = async () => {
    n++;
    if (n < 3) throw new Error("AI Endurance connect timed out after 20000ms");
    return "ok";
  };
  assert.equal(await retryTransient(flaky, { delaysMs: [10, 20], sleep }), "ok");
  assert.deepEqual(slept, [10, 20]);
  assert.equal(n, 3);

  n = 0;
  await assert.rejects(() => retryTransient(async () => { n++; throw new Error("fetch failed"); }, { delaysMs: [1], sleep }), /fetch failed/);
  assert.equal(n, 2, "delays + 1 attempts, then the last error surfaces");

  n = 0;
  await assert.rejects(() => retryTransient(async () => { n++; throw new ReauthRequiredError(); }, { delaysMs: [1, 1], sleep }), ReauthRequiredError);
  assert.equal(n, 1, "auth errors are not retried");
});

test("shouldRetryWithLongBudget: only a wall-clock abort on a budget SHORTER than the long one", () => {
  const budgetErr = new Error("CoachLLM readiness call exceeded its 120000ms wall-clock budget (COACH_LLM_TIMEOUT_MS).");
  assert.equal(shouldRetryWithLongBudget(budgetErr, 120_000, 360_000), true);
  assert.equal(shouldRetryWithLongBudget(budgetErr, 360_000, 360_000), false, "already on the long budget");
  assert.equal(shouldRetryWithLongBudget(new Error("429 rate limited"), 120_000, 360_000), false);
  assert.equal(shouldRetryWithLongBudget("nope", 120_000, 360_000), false);
});
