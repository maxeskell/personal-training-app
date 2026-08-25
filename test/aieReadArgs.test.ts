import { test } from "node:test";
import assert from "node:assert/strict";
import { AIE_STATE_READS } from "../src/state/assemble.js";
import { BACKFILL_SPORTS } from "../src/archive/backfill.js";

/**
 * Pin the AIE read-arg contract (spec 10, AIE reply 2026-08-25): the DFA-α1 threshold/value fields are
 * opt-in on the list tools via `with_dfa_alpha1: true` (default false upstream). If a refactor drops the
 * flag, nothing crashes — the a1 fields just silently vanish from every new state AND every newly
 * archived row (the archive is append-once, so that's a permanent hole in the trend history). These
 * asserts turn that silent regression into a red test.
 */

const FLAGGED = new Set(["getRunningActivity", "getCyclingActivity"]);

test("assembleState reads run + ride lists with with_dfa_alpha1 (and swim without — no R-R in water)", () => {
  for (const [tool, args] of AIE_STATE_READS) {
    if (FLAGGED.has(tool)) assert.equal(args.with_dfa_alpha1, true, `${tool} must request the a1 fields`);
    else assert.equal(args.with_dfa_alpha1, undefined, `${tool} should stay lean — no a1 flag`);
  }
});

test("backfill archives run + ride with with_dfa_alpha1 (and swim without)", () => {
  for (const [tool, , extraArgs] of BACKFILL_SPORTS) {
    if (FLAGGED.has(tool)) assert.equal(extraArgs.with_dfa_alpha1, true, `${tool} must archive the a1 fields`);
    else assert.equal(extraArgs.with_dfa_alpha1, undefined, `${tool} should stay lean — no a1 flag`);
  }
});
