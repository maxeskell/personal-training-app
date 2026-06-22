import { test } from "node:test";
import assert from "node:assert/strict";
import { retry, RetryableHttpError, isRetryableStatus, parseRetryAfterMs, looksLikeRetryableHttp } from "../src/util/retry.js";

/**
 * The bounded retry-with-jitter helper for the read-only external spines. Fully injectable (sleep,
 * jitter, clock) so the backoff maths is tested with NO real waits and NO network.
 */

const noSleep = async (): Promise<void> => {};

test("retry: returns the first result without retrying on success", async () => {
  let calls = 0;
  const out = await retry(async () => {
    calls++;
    return "ok";
  }, { sleep: noSleep });
  assert.equal(out, "ok");
  assert.equal(calls, 1, "no retry when the first attempt succeeds");
});

test("retry: retries a transient 429/5xx then succeeds, honouring the attempt budget", async () => {
  let calls = 0;
  const out = await retry(
    async () => {
      calls++;
      if (calls < 3) throw new RetryableHttpError("AIE 503", 503);
      return "recovered";
    },
    { attempts: 3, sleep: noSleep },
  );
  assert.equal(out, "recovered");
  assert.equal(calls, 3, "two retries then a success");
});

test("retry: gives up after `attempts` and rethrows the last error", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          throw new RetryableHttpError("AIE 429", 429);
        },
        { attempts: 2, sleep: noSleep },
      ),
    /429/,
  );
  assert.equal(calls, 2, "exactly `attempts` tries, no more");
});

test("retry: does NOT retry a non-retryable error (plain Error)", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      retry(
        async () => {
          calls++;
          throw new Error("intervals 404 not found");
        },
        { attempts: 3, sleep: noSleep },
      ),
    /404/,
  );
  assert.equal(calls, 1, "a 4xx / non-retryable error fails immediately");
});

test("retry: honours a server Retry-After over backoff, capped at maxDelayMs", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  let calls = 0;
  await retry(
    async () => {
      calls++;
      if (calls < 2) throw new RetryableHttpError("rate limited", 429, 30_000); // server says wait 30s
      return "ok";
    },
    { attempts: 2, maxDelayMs: 8000, sleep, random: () => 0.5 },
  );
  assert.deepEqual(waits, [8000], "the 30s advice is capped to maxDelayMs (8000)");
});

test("retry: uses jittered exponential backoff when no Retry-After is given", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  let calls = 0;
  await retry(
    async () => {
      calls++;
      if (calls < 3) throw new RetryableHttpError("boom", 500);
      return "ok";
    },
    { attempts: 3, baseDelayMs: 100, maxDelayMs: 8000, sleep, random: () => 0.5 },
  );
  // wait_i = floor(random * min(cap, base*2^i)) → floor(0.5 * 100)=50, floor(0.5 * 200)=100
  assert.deepEqual(waits, [50, 100]);
});

test("isRetryableStatus: only 429 + 5xx", () => {
  for (const s of [429, 500, 502, 503, 599]) assert.equal(isRetryableStatus(s), true, `${s} retryable`);
  for (const s of [200, 400, 401, 404, 418, 600]) assert.equal(isRetryableStatus(s), false, `${s} not retryable`);
});

test("parseRetryAfterMs: delta-seconds, HTTP-date, and the absent/garbage cases", () => {
  assert.equal(parseRetryAfterMs("12"), 12_000);
  assert.equal(parseRetryAfterMs(" 0 "), 0);
  assert.equal(parseRetryAfterMs(null), undefined);
  assert.equal(parseRetryAfterMs(""), undefined);
  assert.equal(parseRetryAfterMs("not-a-date"), undefined);
  // HTTP-date branch with an injected clock: 5s in the future → ~5000ms.
  const now = Date.parse("2026-06-22T00:00:00Z");
  assert.equal(parseRetryAfterMs("Mon, 22 Jun 2026 00:00:05 GMT", now), 5000);
  // A past date never goes negative.
  assert.equal(parseRetryAfterMs("Mon, 22 Jun 2026 00:00:00 GMT", now + 10_000), 0);
});

test("looksLikeRetryableHttp: matches 429/5xx + rate-limit phrasing, not 4xx or timeouts", () => {
  for (const m of ["AIE tool failed: HTTP 429", "got a 503", "service unavailable", "model overloaded", "rate limit exceeded", "bad gateway"]) {
    assert.equal(looksLikeRetryableHttp(m), true, `"${m}" is retryable`);
  }
  for (const m of ["HTTP 404 not found", "401 unauthorized", "AI Endurance tool foo timed out after 20000ms", "ECONNREFUSED"]) {
    assert.equal(looksLikeRetryableHttp(m), false, `"${m}" is not retryable`);
  }
});
