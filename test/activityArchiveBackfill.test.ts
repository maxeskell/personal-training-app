import { test } from "node:test";
import assert from "node:assert/strict";
import { pendingActivityIds } from "../src/archive/activityArchiveBackfill.js";

test("pendingActivityIds: skips already-archived ids, de-dups, drops blanks, preserves order", () => {
  const acts = [{ id: "100" }, { id: "200" }, { id: "200" }, { id: "300" }, { id: "" }];
  const archived = new Set(["200"]); // already in the archive (e.g. via the TP import)
  assert.deepEqual(pendingActivityIds(acts, archived), ["100", "300"]);
});

test("pendingActivityIds: nothing pending when all archived", () => {
  const acts = [{ id: "1" }, { id: "2" }];
  assert.deepEqual(pendingActivityIds(acts, new Set(["1", "2"])), []);
});

test("pendingActivityIds: everything pending against an empty archive", () => {
  assert.deepEqual(pendingActivityIds([{ id: "1" }, { id: "2" }], new Set()), ["1", "2"]);
});
