import { test } from "node:test";
import assert from "node:assert/strict";
import { costUsd, summarizeCost, isLocalModel, type CostRecord } from "../src/llm/costLog.js";

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

test("isLocalModel: Ollama models are local; Anthropic models are not", () => {
  for (const m of ["llama3.2:1b", "nomic-embed-text", "all-minilm", "qwen2.5:1.5b"]) {
    assert.equal(isLocalModel(m), true, `${m} should be local`);
  }
  for (const m of ["claude-opus-4-8", "claude-haiku-4-5", "claude-sonnet-4-6"]) {
    assert.equal(isLocalModel(m), false, `${m} should not be local`);
  }
});

test("summarizeCost: a $0 local row counts as a call + tokens but adds nothing to the dollar total", () => {
  // A local embeddings call (costUsd 0, real token volume) alongside a billed Anthropic call.
  const local: CostRecord = { ...rec("advice-embeddings", 0, 0), model: "nomic-embed-text", input: 120 };
  const s = summarizeCost([rec("readiness", 0, 1.5), local]);
  assert.equal(s.total.calls, 2, "the local call is counted");
  assert.equal(s.total.costUsd, 1.5, "but it adds $0 to the dollar total");
  const embed = s.byOperation.find((o) => o.operation === "advice-embeddings");
  assert.ok(embed, "the local operation shows in the breakdown");
  assert.equal(embed?.input, 120, "with its token volume preserved");
  assert.equal(embed?.costUsd, 0);
});
