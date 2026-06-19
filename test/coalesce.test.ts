import { test } from "node:test";
import assert from "node:assert/strict";
import { coalesce } from "../src/util/coalesce.js";

test("coalesce: concurrent same-key calls share ONE run (no double spend), then the slot frees", async () => {
  const m = new Map<string, Promise<number>>();
  let runs = 0;
  let release!: (n: number) => void;
  const task = () => {
    runs++;
    return new Promise<number>((res) => {
      release = res;
    });
  };
  const a = coalesce(m, "k", task);
  const b = coalesce(m, "k", task); // arrives while a is still pending
  assert.equal(runs, 1, "the task ran once for two concurrent callers");
  assert.equal(m.size, 1, "one in-flight entry shared by both");
  release(42);
  assert.equal(await a, 42);
  assert.equal(await b, 42, "both callers resolve to the same result");
  assert.equal(m.size, 0, "the slot is freed once it settles");
});

test("coalesce: distinct keys run independently; a later same-key call re-runs after the first settled", async () => {
  const m = new Map<string, Promise<string>>();
  let runs = 0;
  const task = (v: string) => () => {
    runs++;
    return Promise.resolve(v);
  };
  assert.equal(await coalesce(m, "x", task("a")), "a");
  assert.equal(await coalesce(m, "y", task("b")), "b");
  assert.equal(runs, 2, "different keys each run");
  assert.equal(await coalesce(m, "x", task("a2")), "a2", "after the first settled, a fresh same-key call runs again");
  assert.equal(runs, 3);
  assert.equal(m.size, 0, "no leaked slots");
});

test("coalesce: a failing task rejects all shared callers and still frees the slot", async () => {
  const m = new Map<string, Promise<number>>();
  let runs = 0;
  const task = () => {
    runs++;
    return Promise.reject(new Error("boom"));
  };
  const a = coalesce(m, "k", task);
  const b = coalesce(m, "k", task);
  assert.equal(runs, 1, "one shared run even when it fails");
  await assert.rejects(a, /boom/);
  await assert.rejects(b, /boom/);
  assert.equal(m.size, 0, "the slot is freed after a rejection too");
});

test("coalesce: a synchronous throw in the task becomes a rejection, not an uncaught error", async () => {
  const m = new Map<string, Promise<number>>();
  const a = coalesce(m, "k", () => {
    throw new Error("sync-boom");
  });
  await assert.rejects(a, /sync-boom/);
  assert.equal(m.size, 0);
});
