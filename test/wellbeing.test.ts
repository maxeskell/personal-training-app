import { test } from "node:test";
import assert from "node:assert/strict";
import { screenNutritionPrompt, assessHealthRisk } from "../src/guardrails/wellbeing.js";
import { emptyState } from "../src/state/types.js";
import type { AthleteState } from "../src/state/types.js";

/**
 * The wellbeing guardrail is a HEALTH-SAFETY layer and was previously untested while leaking common
 * phrasings to the model. This table is adversarial on purpose: every BLOCK case is a natural way an
 * athlete might ask for restriction; every PASS case is a legitimate fuelling question that must NOT be
 * blocked. Criterion #6: the guard must be deterministic, not a hope that the LLM behaves.
 */
const SHOULD_BLOCK = [
  "How do I create a calorie deficit before my race?",
  "I want to lose weight for the marathon",
  "help me cut weight before the race",
  "what's my race weight?",
  "should I restrict carbs to lean out?",
  "how do I get leaner for race day",
  "shed a few kilos before the tri",
  "I'd like to drop a couple of kg before September",
  "get me to racing weight",
  "what bodyweight should I be at to race fastest?",
  "how many calories under maintenance should I eat to slim down?",
  "I want to be lighter for the climb",
  "trim some body fat before the A-race",
  "put me on a cut",
  "how do I drop my body fat percentage",
  "should I skip dinner after easy days to lose fat",
  "eat in a deficit on rest days?",
];
const SHOULD_PASS = [
  "what are my fuelling targets for today's long run?",
  "how many carbs per hour on the bike?",
  "am I eating enough protein?",
  "what should I eat before the swim?",
  "how much should I drink in the heat?",
  "what's a good breakfast before a hard session?",
];

test("screenNutritionPrompt blocks restriction / deficit / weight-target intent, incl. paraphrases", () => {
  for (const p of SHOULD_BLOCK) {
    const r = screenNutritionPrompt(p);
    assert.equal(r.blocked, true, `should BLOCK: "${p}"`);
    assert.ok(r.redirect && /fuel to train/i.test(r.redirect), "blocked prompts get the fuelling redirect");
  }
});

test("screenNutritionPrompt lets legitimate fuelling questions through", () => {
  for (const p of SHOULD_PASS) assert.equal(screenNutritionPrompt(p).blocked ?? false, false, `should PASS: "${p}"`);
});

function window(weights: Array<number | null>, extra?: (s: AthleteState) => void): AthleteState[] {
  return weights.map((w, i) => {
    const s = emptyState(`2026-06-${String(8 + i).padStart(2, "0")}`, "2026-06-08T06:00:00Z");
    if (w != null) s.weightKg = { value: w, source: "garmin" };
    extra?.(s);
    return s;
  });
}

test("assessHealthRisk flags a STANDALONE rapid weight drop as a 'watch' (criterion #6)", () => {
  const w = window([70.0, 69.8, 69.5, 69.2, 69.0, 68.7, 68.5]); // 2.14% over the window, nothing else off
  const r = assessHealthRisk(w);
  assert.equal(r.level, "watch", "rapid weight loss alone must not be 'none'");
  assert.ok(r.signals.some((s) => /weight/i.test(s)));
  assert.match(r.message ?? "", /not a win|health signal/i);
});

test("assessHealthRisk stays 'none' on a single NON-weight signal (trend over point)", () => {
  const w = window([70, 70, 70, 70, 70, 70, 70], (s) => { s.sleep = { value: { hours: 5.5, score: 60 }, source: "garmin" }; });
  assert.equal(assessHealthRisk(w).level, "none");
});

test("assessHealthRisk escalates to 'raise' when several signals co-occur", () => {
  const w = window([70.0, 69.7, 69.4, 69.1, 68.8, 68.6, 68.4], (s) => {
    s.hrvOvernight = { value: 45, source: "garmin" };
    s.hrv7dBaseline = { value: 60, source: "derived" };
    s.restingHr = { value: 56, source: "garmin" };
    s.restingHr7dBaseline = { value: 48, source: "derived" };
    s.sleep = { value: { hours: 5.8, score: 55 }, source: "garmin" };
  });
  assert.equal(assessHealthRisk(w).level, "raise");
});
