import { test } from "node:test";
import assert from "node:assert/strict";
import { costUsd, summarizeCost, type CostRecord } from "../src/llm/costLog.js";

test("costUsd: prices each token bucket at the configured rate (5/25/6.25/0.5 per MTok)", () => {
  assert.equal(costUsd({ input: 200_000, output: 100_000, cacheWrite: 0, cacheRead: 0 }), 3.5); // 1.0 + 2.5
  assert.equal(costUsd({ input: 0, output: 0, cacheWrite: 0, cacheRead: 1_000_000 }), 0.5);
  assert.equal(costUsd({ input: 0, output: 0, cacheWrite: 1_000_000, cacheRead: 0 }), 6.25);
  assert.equal(costUsd({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }), 0);
});

function rec(operation: string, ageDays: number, cost: number): CostRecord {
  return {
    ts: new Date(Date.now() - ageDays * 86_400_000).toISOString(),
    operation,
    model: "claude-opus-4-8",
    input: 100,
    output: 200,
    cacheWrite: 0,
    cacheRead: 0,
    costUsd: cost,
    schemaVersion: 1,
  };
}

test("summarizeCost: windows by trailing days and breaks down by operation (cost-desc)", () => {
  const records = [rec("ask", 0, 0.05), rec("ask", 3, 0.05), rec("weekly", 10, 0.2)];

  const w7 = summarizeCost(records, 7);
  assert.equal(w7.total.calls, 2, "10-day-old weekly is outside the 7-day window");
  assert.equal(w7.total.costUsd, 0.1);
  assert.deepEqual(w7.byOperation.map((o) => o.operation), ["ask"]);

  const all = summarizeCost(records);
  assert.equal(all.windowDays, null);
  assert.equal(all.total.calls, 3);
  assert.equal(all.total.costUsd, 0.3);
  assert.deepEqual(all.byOperation.map((o) => o.operation), ["weekly", "ask"]); // sorted by cost desc
  assert.equal(all.byOperation[0].costUsd, 0.2);
  assert.equal(all.byOperation[1].calls, 2);
});
