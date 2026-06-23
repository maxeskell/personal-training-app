import { test } from "node:test";
import assert from "node:assert/strict";
import { planFuel, carbTargetGPerHour, inferIntensity, buildWeekFuelPlans, loadFuelPrefs } from "../src/coach/fuelPlan.js";
import { loadInventory } from "../src/coach/fuelInventory.js";
import type { Profile } from "../src/profile/schema.js";
import type { PlannedSession } from "../src/state/types.js";

/**
 * The deterministic engine's governing rule: only surface what's needed. The headline assertions are the
 * QUIET path (short easy session → needed:false, "water's fine") and the threshold crossings (a long ride
 * gets during carbs + a recovery line; a key session gets pre/during/after). Carb targets follow the
 * mainstream ranges and respect the learned ceiling.
 */

const inv = loadInventory({
  schema_version: 1,
  identity: {},
  fuelling: {
    products: [
      { name: "Flapjack", brand: "Flapjack Co", carbs_g: 65, category: "bar" },
      { name: "Gel", carbs_g: 22, category: "gel" },
      { name: "5 Electrolytes Mango", brand: "PowerBar", category: "electrolyte" },
      { name: "5 Electrolytes Lemon", brand: "PowerBar", category: "electrolyte", caffeine_mg: 75 },
      { name: "REGO Whey", brand: "SIS", category: "recovery", protein_g: 21, carbs_g: 4 },
      { name: "Beet It", brand: "Beet It", category: "nitrate" },
    ],
  },
} as unknown as Profile);

test("short easy run needs nothing — the quiet path", () => {
  const plan = planFuel({ sport: "Run", durationMin: 45, title: "Easy run", inventory: inv });
  assert.equal(plan.needed, false);
  assert.equal(plan.pre, null);
  assert.equal(plan.during, null);
  assert.equal(plan.after, null);
  assert.match(plan.summary, /water's fine/);
});

test("long endurance ride gets during-carbs + fluid + a recovery line, no pre for a non-key Z2", () => {
  const plan = planFuel({ sport: "Ride", durationMin: 180, title: "Endurance ride", weightKg: 72, inventory: inv });
  assert.equal(plan.needed, true);
  assert.ok(plan.during, "during section present");
  assert.match(plan.during!.lines.join(" "), /g carb\/hr/);
  assert.match(plan.during!.lines.join(" "), /ml\/hr/);
  assert.ok(plan.after, "after section present for a 3h ride");
  assert.match(plan.after!.lines.join(" "), /REGO Whey/);
});

test("key session pulls in pre (nitrate timing) + caffeine, and after", () => {
  const plan = planFuel({ sport: "Ride", durationMin: 150, title: "Race rehearsal", isKey: true, weightKg: 72, inventory: inv });
  assert.ok(plan.pre, "pre present for a key session");
  assert.match(plan.pre!.lines.join(" "), /Beet It/, "nitrate timing surfaced");
  assert.ok(plan.during && plan.after);
});

test("evening session steers to the caffeine-free electrolyte", () => {
  const plan = planFuel({ sport: "Ride", durationMin: 120, title: "Endurance", startHour: 19, prefs: { caffeineCutoffHour: 16 }, inventory: inv });
  const during = plan.during!.lines.join(" ");
  assert.match(during, /Mango/, "picks the caffeine-free tab in the evening");
  assert.doesNotMatch(during, /Lemon/, "avoids the caffeinated tab late");
});

test("carbTargetGPerHour follows the ranges and respects the learned ceiling", () => {
  assert.equal(carbTargetGPerHour(45, "easy", false), 0, "<75min easy → none");
  assert.equal(carbTargetGPerHour(90, "endurance", false), 45);
  assert.equal(carbTargetGPerHour(90, "hard", false), 60);
  assert.equal(carbTargetGPerHour(180, "endurance", false), 75);
  assert.equal(carbTargetGPerHour(180, "endurance", false, 60), 60, "ceiling caps the target");
});

test("carbTargetGPerHour uses the athlete's own stated target over the generic ranges", () => {
  // The athlete's stated 80 g/h replaces the generic figure whenever carbs are needed (n=1 > textbook).
  assert.equal(carbTargetGPerHour(120, "endurance", false, 90, 80), 80, "2h endurance → the stated 80, not 45");
  assert.equal(carbTargetGPerHour(180, "endurance", false, 90, 80), 80, "3h endurance → 80, not 75");
  assert.equal(carbTargetGPerHour(85, "hard", false, 90, 80), 80, "hard session → 80, not 60");
  // ...but the ceiling still caps it, and a session that needs no carbs stays at 0.
  assert.equal(carbTargetGPerHour(120, "endurance", false, 70, 80), 70, "ceiling caps the stated target");
  assert.equal(carbTargetGPerHour(45, "easy", false, 90, 80), 0, "short easy session → still water's fine");
});

test("inferIntensity reads the title", () => {
  assert.equal(inferIntensity("VO2 intervals", "Run"), "hard");
  assert.equal(inferIntensity("Easy recovery spin", "Ride"), "easy");
  assert.equal(inferIntensity("Long ride", "Ride"), "endurance");
});

test("with no carb product the plan still gives the g/h target and names the gap", () => {
  const noCarb = loadInventory({ schema_version: 1, identity: {}, fuelling: { products: [{ name: "Tab", category: "electrolyte" }] } } as unknown as Profile);
  const plan = planFuel({ sport: "Ride", durationMin: 180, title: "Endurance", inventory: noCarb });
  assert.match(plan.during!.lines.join(" "), /no dedicated carb fuel logged/);
});

test("the During line shows each pick's CARB contribution (summing to the total), not its serving weight", () => {
  const inv = loadInventory({ schema_version: 1, identity: {}, fuelling: { products: [
    { name: "Flapjack (120 g)", brand: "Flapjack Co", category: "bar", carbs_g: 65 },
    { name: "Energy Gel", brand: "OTE", category: "gel", carbs_g: 20 },
  ] } } as unknown as Profile);
  const plan = planFuel({ sport: "Ride", durationMin: 180, title: "Long ride", inventory: inv, prefs: { carbTargetGPerHour: 80, carbCeilingGPerHour: 90 } });
  const during = plan.during!.lines.join(" ");
  assert.match(during, /Flapjack Co Flapjack \(\d+ g carb\)/, "carb contribution shown per product");
  assert.doesNotMatch(during, /\(120 g\)/, "the bar's 120 g serving weight is stripped (not a carb figure)");
  // the per-product carb contributions sum to the stated total — the maths now adds up
  const contribs = [...during.matchAll(/\((\d+) g carb\)/g)].map((m) => Number(m[1]));
  // the line carries the target (≈240) then the products' delivered total at the end — take the LAST ≈.
  const totals = [...during.matchAll(/≈\s*(\d+) g carb/g)].map((m) => Number(m[1]));
  const deliveredTotal = totals[totals.length - 1];
  assert.ok(contribs.length >= 1 && Number.isFinite(deliveredTotal), "found per-product carbs and a delivered total");
  assert.equal(contribs.reduce((a, b) => a + b, 0), deliveredTotal, "per-product carbs sum to the delivered total");
});

test("buildWeekFuelPlans maps planned sessions and skips strength", () => {
  const sessions: PlannedSession[] = [
    { date: "2026-06-21", sport: "Run", durationMin: 40, title: "Easy" },
    { date: "2026-06-22", sport: "Ride", durationMin: 180, title: "Long ride" },
    { date: "2026-06-23", sport: "Strength", durationMin: 45, title: "Gym" },
  ];
  const plans = buildWeekFuelPlans(sessions, { inventory: inv, weightKg: 72, keyDates: new Set(["2026-06-22"]) });
  assert.equal(plans.length, 2, "strength dropped");
  assert.equal(plans[0].needed, false, "easy run quiet");
  assert.equal(plans[1].needed, true, "long key ride loud");
});

test("loadFuelPrefs reads the learned preferences + the athlete's stated carb target", () => {
  const prefs = loadFuelPrefs({ carb_target_g_per_hour: { olympic_and_long_rides: 80, sprint: 0 }, preferences: { carb_ceiling_g_per_hour: 70, caffeine_cutoff_hour: 16 } });
  assert.equal(prefs.carbCeilingGPerHour, 70);
  assert.equal(prefs.carbTargetGPerHour, 80, "highest stated carb target becomes the endurance target");
  assert.equal(prefs.caffeineCutoffHour, 16);
  assert.deepEqual(loadFuelPrefs(undefined), { carbCeilingGPerHour: undefined, carbTargetGPerHour: undefined, caffeineCutoffHour: undefined, notes: undefined });
});
