import { test } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTcx } from "../src/insights/tcxParser.js";
import { loadActivityFits } from "../src/insights/fit.js";

const TCX = `<?xml version="1.0"?>
<TrainingCenterDatabase>
 <Activities><Activity Sport="Running">
  <Lap StartTime="2015-12-26T10:00:00Z">
    <TotalTimeSeconds>1500</TotalTimeSeconds>
    <DistanceMeters>5000</DistanceMeters>
    <AverageHeartRateBpm><Value>150</Value></AverageHeartRateBpm>
    <MaximumHeartRateBpm><Value>175</Value></MaximumHeartRateBpm>
    <Track><Trackpoint><DistanceMeters>10</DistanceMeters><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint></Track>
  </Lap>
  <Lap StartTime="2015-12-26T10:25:00Z">
    <TotalTimeSeconds>1400</TotalTimeSeconds>
    <DistanceMeters>5000</DistanceMeters>
    <AverageHeartRateBpm><Value>160</Value></AverageHeartRateBpm>
    <Track><Trackpoint><DistanceMeters>9000</DistanceMeters></Trackpoint></Track>
    <Extensions><ns3:LX><ns3:AvgSpeed>3.57</ns3:AvgSpeed><ns3:AvgWatts>250</ns3:AvgWatts></ns3:LX></Extensions>
  </Lap>
 </Activity></Activities>
</TrainingCenterDatabase>`;

test("parseTcx: decodes sport, per-lap splits and a time-weighted summary; trackpoints don't shadow laps", () => {
  const fit = parseTcx(Buffer.from(TCX));
  assert.ok(fit);
  assert.equal(fit.sportName, "Run");
  assert.equal(fit.sport, 1);
  assert.equal(fit.laps.length, 2);
  // lap-level distance (5000), NOT a trackpoint's (10 / 9000)
  assert.equal(fit.laps[0].distanceM, 5000);
  assert.equal(fit.laps[0].timerS, 1500);
  assert.equal(fit.laps[0].avgHr, 150); // the lap avg, not the trackpoint's 120, nor the max 175
  assert.equal(fit.laps[1].avgPowerW, 250); // namespaced AvgWatts from Extensions (after </Track>)
  assert.equal(fit.laps[1].avgSpeedMs, 3.57);
  // session summary aggregates the laps
  assert.equal(fit.session.durationSec, 2900);
  assert.equal(fit.session.distanceKm, 10);
  assert.equal(fit.session.avgHr, 155); // (150*1500 + 160*1400) / 2900
  assert.equal(fit.samples.length, 0); // trackpoint streams are intentionally skipped
});

test("parseTcx: a document with no laps → null (never fabricates)", () => {
  assert.equal(parseTcx(Buffer.from("<TrainingCenterDatabase></TrainingCenterDatabase>")), null);
  assert.equal(parseTcx(Buffer.from("not xml at all")), null);
});

test("loadActivityFits: recursive scan finds a gzipped .tcx in a subfolder and dates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tpexport-"));
  mkdirSync(join(dir, "WorkoutFileExport-2015"));
  writeFileSync(join(dir, "WorkoutFileExport-2015", "run.tcx.gz"), gzipSync(Buffer.from(TCX)));
  // non-recursive (default) misses the nested file; recursive finds it
  assert.equal(loadActivityFits(dir).length, 0);
  const fits = loadActivityFits(dir, { recursive: true, dropSamples: true });
  assert.equal(fits.length, 1);
  assert.equal(fits[0].sport, "Run");
  assert.equal(fits[0].date, "2015-12-26"); // from the lap StartTime
  assert.equal(fits[0].fit.laps.length, 2);
});
