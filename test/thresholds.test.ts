import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGarminThresholds } from "../src/state/assemble.js";
import { emptyState } from "../src/state/types.js";

function stateWithAieFtp(ftpW: number) {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.thresholds = { value: { bikeFtpW: ftpW }, source: "aie", note: "AIE getUser" };
  return s;
}

test("Garmin FTP that is lower than the AIE/test value is NOT applied; the higher value is kept and flagged", () => {
  const s = stateWithAieFtp(223);
  mapGarminThresholds(s, { functional_threshold_power_watts: 139, sport: "CYCLING" }, { weight_kg: 70 });
  assert.equal(s.thresholds.value!.bikeFtpW, 223, "keeps the higher test-based FTP");
  assert.ok(/139 W/.test(s.thresholds.value!.bikeFtpNote ?? ""), "flags the Garmin value in the note");
  assert.ok(/223 W/.test(s.thresholds.value!.bikeFtpNote ?? ""), "note names the kept value");
  assert.equal(s.thresholds.value!.bikeFtpWkg, +(223 / 70).toFixed(2), "W/kg derived from the kept value");
});

test("Garmin FTP that is higher than the AIE value wins (genuine power-detected gain) with no conflict note", () => {
  const s = stateWithAieFtp(223);
  mapGarminThresholds(s, { functional_threshold_power_watts: 250, sport: "CYCLING" }, { weight_kg: 70 });
  assert.equal(s.thresholds.value!.bikeFtpW, 250);
  assert.equal(s.thresholds.value!.bikeFtpNote, undefined);
});

test("Garmin FTP is used as-is when there is no prior (AIE) value", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  mapGarminThresholds(s, { functional_threshold_power_watts: 139, sport: "CYCLING" }, {});
  assert.equal(s.thresholds.value!.bikeFtpW, 139);
  assert.equal(s.thresholds.value!.bikeFtpNote, undefined);
});
