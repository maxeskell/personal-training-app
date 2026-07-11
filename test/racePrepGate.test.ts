import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: runRacePrep builds its gate plan via loadSessionDecays(), which defaults to the real
// data/fit-streams dir — point it at an empty temp dir so a machine with real archives stays out of
// the fixtures (same isolation pattern as dashboard.test.ts).
process.env.FIT_STREAMS_DIR = mkdtempSync(join(tmpdir(), "coach-raceprep-"));

import { runRacePrep } from "../src/coach/racePrep.js";
import { emptyState } from "../src/state/types.js";

function fixtureState() {
  const s = emptyState("2026-07-01", new Date().toISOString());
  s.raw = { getRaceGoalEvent: { goals: [{ event_name: "Local Olympic Triathlon", event_date: "2026-07-11", event_type: "Triathlon" }] } };
  s.thresholds = { value: { bikeFtpW: 200, swimCssSecPer100: 120, runThresholdPaceSecPerKm: 280 }, source: "garmin" } as never;
  s.weightKg = { value: 71, source: "garmin" } as never;
  return s;
}

function captureLlm() {
  const box = { prompt: "" };
  const llm = {
    text: async (p: string) => {
      box.prompt = p;
      return { text: "ok", cacheRead: 0, costUsd: 0 };
    },
  };
  return { box, llm: llm as never };
}

test("race prep: the prompt carries the deterministic model-vs-target gate and demands the lead on implausible", async () => {
  const { box, llm } = captureLlm();
  await runRacePrep(llm, fixtureState(), undefined, [
    { name: "Local Olympic Triathlon", date: "2026-07-11", target_time: "sub 1:30" },
  ]);
  assert.match(box.prompt, /RACE-TIME MODEL vs TARGET/);
  assert.match(box.prompt, /TARGET CHECK \[IMPLAUSIBLE\]/, "sub 1:30 vs a ~2:3x model must be called out");
  assert.match(box.prompt, /LEAD the report with this discrepancy/);
});

test("race prep: no athlete target → the gate says so instead of inventing one", async () => {
  const { box, llm } = captureLlm();
  await runRacePrep(llm, fixtureState(), undefined, []);
  assert.match(box.prompt, /RACE-TIME MODEL vs TARGET/);
  assert.match(box.prompt, /No athlete target found/);
  assert.doesNotMatch(box.prompt, /TARGET CHECK/);
});
