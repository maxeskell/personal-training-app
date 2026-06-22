import { test } from "node:test";
import assert from "node:assert/strict";
import { AieClient } from "../src/mcp/aieClient.js";

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
