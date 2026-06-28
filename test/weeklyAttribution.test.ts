import { test } from "node:test";
import assert from "node:assert/strict";
import { adhAttribution } from "../src/coach/weekly.js";

/**
 * adhAttribution turns the zone-adherence numbers into the CAUSE of a volume shortfall — missed sessions
 * vs trained-too-hard — so the weekly review can CITE the reason instead of the model guessing it. Pure.
 */

const z = (actualH: number, prescribedH: number) => ({ actualH, prescribedH });

test("easy short + harder zones over → intensity creep (trained too hard), not missed sessions", () => {
  const adh = { Endurance: z(3, 8), Tempo: z(1.5, 0.5), Threshold: z(1, 0.5) };
  const out = adhAttribution(adh);
  assert.match(out, /TOO HARD|intensity creep/);
  assert.match(out, /3\.0h of 8\.0h/); // easy actual vs prescribed cited
});

test("everything under prescription → missed/shortened sessions", () => {
  const adh = { Endurance: z(4, 8), Tempo: z(0.3, 1), Threshold: z(0.2, 1) };
  const out = adhAttribution(adh);
  assert.match(out, /MISSED or shortened/);
});

test("broadly on prescription → no alarm", () => {
  const adh = { Endurance: z(7.6, 8), Tempo: z(1, 1) };
  assert.match(adhAttribution(adh), /broadly on prescription/);
});

test("degrades cleanly with no data or no prescribed volume", () => {
  assert.match(adhAttribution(null), /unavailable/);
  assert.match(adhAttribution({ Endurance: z(0, 0) }), /no prescribed volume/);
});
