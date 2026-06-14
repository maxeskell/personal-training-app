import { test } from "node:test";
import assert from "node:assert/strict";
import { extractJson, garminInner, asNumber, lastNum, lastVal, lastEl, daysAgoIso, get } from "../src/state/payload.js";

/**
 * The payload helpers (extracted from assemble.ts) are the generic parsing surface — pin them directly
 * now that they live in their own module: the numeric coercions, the time-series tail accessors, the
 * nested getter, UTC date math, and the MCP / Garmin envelope unwrappers.
 */

test("asNumber / lastNum / lastVal / lastEl coerce and tail-read defensively", () => {
  assert.equal(asNumber(3), 3);
  assert.equal(asNumber("4.5"), 4.5);
  assert.equal(asNumber("x"), undefined);
  assert.equal(asNumber(Number.NaN), undefined);
  assert.equal(lastNum([1, 2, null, 5]), 5); // last FINITE element
  assert.equal(lastNum([null, "x"]), undefined);
  assert.equal(lastNum("nope"), undefined);
  assert.equal(lastVal(["a", "b"]), "b");
  assert.equal(lastVal([]), undefined);
  assert.equal(lastEl([1, 2, 3]), 3);
  assert.equal(lastEl(7), 7); // a scalar passes through unchanged
});

test("get() walks nested keys and returns undefined on any missing link", () => {
  assert.equal(get({ a: { b: { c: 9 } } }, "a", "b", "c"), 9);
  assert.equal(get({ a: {} }, "a", "b", "c"), undefined);
  assert.equal(get(null, "a"), undefined);
});

test("daysAgoIso does UTC date arithmetic (no TZ drift, handles month/year edges)", () => {
  assert.equal(daysAgoIso("2026-06-14", 7), "2026-06-07");
  assert.equal(daysAgoIso("2026-03-01", 1), "2026-02-28"); // 2026 is not a leap year
});

test("extractJson / garminInner unwrap the MCP and Garmin double-encoded envelopes", () => {
  assert.deepEqual(extractJson({ content: [{ type: "text", text: '{"x":1}' }] }), { x: 1 });
  const env = { content: [{ type: "text", text: JSON.stringify({ result: JSON.stringify({ w: 70 }) }) }] };
  assert.deepEqual(garminInner(env), { w: 70 });
  assert.equal(garminInner(null), null);
});
