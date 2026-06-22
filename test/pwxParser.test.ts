import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePwx } from "../src/insights/pwxParser.js";
import { loadActivityFits } from "../src/insights/fit.js";

const PWX = `<?xml version="1.0"?>
<pwx xmlns="http://www.peaksware.com/PWX/1/0">
 <workout>
  <athlete><name>Max</name></athlete>
  <sportType>Bike</sportType>
  <time>2013-07-07T06:30:00Z</time>
  <summarydata>
    <beginning>0</beginning>
    <duration>9000</duration>
    <hr max="178" min="92" avg="150"/>
    <pwr max="420" min="0" avg="205"/>
    <dist>90000</dist>
  </summarydata>
  <segment>
    <name>Lap 1</name>
    <summarydata><beginning>0</beginning><duration>4500</duration><hr avg="148"/><pwr avg="210"/><dist>45000</dist></summarydata>
  </segment>
  <segment>
    <name>Lap 2</name>
    <summarydata><beginning>4500</beginning><duration>4500</duration><hr avg="152"/><pwr avg="200"/><dist>45000</dist></summarydata>
  </segment>
  <sample><timeoffset>0</timeoffset><pwr>200</pwr></sample>
 </workout>
</pwx>`;

test("parsePwx: decodes sportType, per-segment laps (avg-attribute stats) and the workout summary", () => {
  const fit = parsePwx(Buffer.from(PWX));
  assert.ok(fit);
  assert.equal(fit.sportName, "Ride");
  assert.equal(fit.sport, 2);
  assert.equal(fit.laps.length, 2);
  assert.equal(fit.laps[0].distanceM, 45000);
  assert.equal(fit.laps[0].timerS, 4500);
  assert.equal(fit.laps[0].avgPowerW, 210); // from <pwr avg="210"/>
  assert.equal(fit.laps[1].avgHr, 152);
  // workout-level summary (NOT a segment's)
  assert.equal(fit.session.durationSec, 9000);
  assert.equal(fit.session.distanceKm, 90);
  assert.equal(fit.session.avgHr, 150);
  assert.equal(fit.session.avgPower, 205);
  assert.equal(fit.samples.length, 0);
});

test("parsePwx: no workout → null", () => {
  assert.equal(parsePwx(Buffer.from("<pwx></pwx>")), null);
  assert.equal(parsePwx(Buffer.from("nonsense")), null);
});

test("loadActivityFits: recursive scan reads a gzipped .pwx in a subfolder", () => {
  const dir = mkdtempSync(join(tmpdir(), "pwx-"));
  mkdirSync(join(dir, "WorkoutFileExport-2013"));
  writeFileSync(join(dir, "WorkoutFileExport-2013", "ride.pwx.gz"), gzipSync(Buffer.from(PWX)));
  const fits = loadActivityFits(dir, { recursive: true, dropSamples: true });
  assert.equal(fits.length, 1);
  assert.equal(fits[0].sport, "Ride");
  assert.equal(fits[0].date, "2013-07-07");
  assert.equal(fits[0].fit.laps.length, 2);
});
