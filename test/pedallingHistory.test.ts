import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPedallingHistory,
  summarisePedallingHistory,
  formatPedallingHistory,
  type PedallingRide,
} from "../src/insights/pedallingHistory.js";

/**
 * Pedalling history walks the archive + fit-streams, caches per file, and summarises by month. These build
 * real (minimal) .FIT bytes in a temp dir — no network — and pin the scan, the cache, the dedup and the maths.
 */

const FIT_EPOCH_OFFSET = 631065600;

/** A ride .FIT: `n` 1 Hz records (timestamp, power, cadence, L/R balance, left/right PCO) + a sport msg. */
function rideFit(startUnix: number, n: number, leftPct: number, pcoL: number, sport = 2, subSport = 0): Buffer {
  const def = Buffer.from([
    0x40, 0, 0, 20, 0, 6, // definition, local 0, LE, global 20, 6 fields
    253, 4, 0x86, 7, 2, 0x84, 4, 1, 0x02, 30, 1, 0x02, 67, 1, 0x01, 68, 1, 0x01,
  ]);
  const recs: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const v = Buffer.alloc(11);
    v.writeUInt8(0, 0); // data header, local 0
    v.writeUInt32LE(startUnix - FIT_EPOCH_OFFSET + i, 1);
    v.writeUInt16LE(200, 5);
    v.writeUInt8(90, 7);
    v.writeUInt8(0x80 | (100 - leftPct), 8); // right-flagged share
    v.writeInt8(pcoL, 9);
    v.writeInt8(2, 10);
    recs.push(v);
  }
  const sportDef = Buffer.from([0x41, 0, 0, 12, 0, 2, 0, 1, 0x00, 1, 1, 0x00]);
  const sportData = Buffer.from([0x01, sport, subSport]);
  const body = Buffer.concat([def, ...recs, sportDef, sportData]);
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt32LE(body.length, 4);
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, body]);
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "pedal-"));
  const archiveDir = join(root, "archive");
  const streamsDir = join(root, "streams");
  mkdirSync(join(archiveDir, "by-year", "2026"), { recursive: true });
  mkdirSync(streamsDir, { recursive: true });
  return { root, archiveDir, streamsDir, cachePath: join(root, "pedalling-history.json") };
}

function archive(dir: string, name: string, buf: Buffer, hash: string, sport = "Ride") {
  writeFileSync(join(dir, "by-year", "2026", name), buf);
  const e = { id: name, contentHash: hash, date: "", sport, format: "fit", gzipped: false, source: "garmin", originalName: name, path: `by-year/2026/${name}`, bytes: buf.length, importedAt: "2026-10-24" };
  writeFileSync(join(dir, "manifest.jsonl"), JSON.stringify(e) + "\n", { flag: "a" });
}

const MAR = Date.UTC(2026, 2, 10) / 1000;
const SEP = Date.UTC(2026, 8, 10) / 1000;

test("buildPedallingHistory: scans archive + streams, caches, and dedups the same ride", () => {
  const d = setup();
  try {
    archive(d.archiveDir, "a.fit", rideFit(MAR, 1500, 53, -6), "h1");
    archive(d.archiveDir, "b.fit", rideFit(SEP, 1500, 51, -2), "h2");
    archive(d.archiveDir, "run.fit", rideFit(SEP + 86400, 1500, 50, 0, 1), "h3", "Run"); // a run: skipped
    writeFileSync(join(d.streamsDir, "dup.fit"), rideFit(SEP, 1500, 51, -2)); // same ride as b.fit
    const first = buildPedallingHistory(d);
    assert.equal(first.rides.length, 2, "two rides: the run is skipped, the streams copy deduped");
    assert.equal(first.parsed, 3, "a, b and the streams file parsed; the run never reaches the parser");
    assert.equal(first.rides[0].date, "2026-03-10");
    assert.equal(first.rides[0].balanceLeftPct, 53);
    assert.equal(first.rides[0].pcoLeftMm, -6);
    assert.equal(first.rides[1].source, "archive", "archive copy wins over the streams copy");
    assert.ok(existsSync(d.cachePath));
    const again = buildPedallingHistory(d);
    assert.equal(again.parsed, 0, "second run is all cache");
    assert.deepEqual(again.rides, first.rides);
  } finally {
    rmSync(d.root, { recursive: true, force: true });
  }
});

test("buildPedallingHistory: indoor rides are tagged; no archive at all gives an empty history", () => {
  const d = setup();
  try {
    writeFileSync(join(d.streamsDir, "trainer.fit"), rideFit(SEP, 1500, 50, 0, 2, 6));
    const h = buildPedallingHistory(d);
    assert.equal(h.rides[0].indoor, true);
    const empty = buildPedallingHistory({ archiveDir: join(d.root, "nope"), streamsDir: join(d.root, "nope2"), cachePath: join(d.root, "c2.json") });
    assert.equal(empty.rides.length, 0);
  } finally {
    rmSync(d.root, { recursive: true, force: true });
  }
});

test("buildPedallingHistory: a corrupt cache is rebuilt, not fatal", () => {
  const d = setup();
  try {
    writeFileSync(join(d.streamsDir, "r.fit"), rideFit(SEP, 1500, 52, 1));
    writeFileSync(d.cachePath, "{ not json");
    assert.equal(buildPedallingHistory(d).rides.length, 1);
    assert.equal(JSON.parse(readFileSync(d.cachePath, "utf8")).version, 1);
  } finally {
    rmSync(d.root, { recursive: true, force: true });
  }
});

function ride(date: string, over: Partial<PedallingRide> = {}): PedallingRide {
  return {
    date, startTimeS: null, source: "archive", indoor: false, pedallingMin: 60, avgPowerW: 200,
    balanceLeftPct: 52, balanceLoadShiftPct: 0.5, balanceDriftPct: 0, teLeft: 75, teRight: 73, psLeft: 22, psRight: 21,
    pcoLeftMm: -4, pcoRightMm: 1, phaseStartLeftDeg: 350, phaseStartRightDeg: 355, phaseArcLeftDeg: 230, phaseArcRightDeg: 225,
    ...over,
  };
}

test("summarisePedallingHistory: monthly medians, short rides dropped, before/after split", () => {
  const rides = [
    ride("2026-03-01", { balanceLeftPct: 53 }),
    ride("2026-03-08", { balanceLeftPct: 53 }),
    ride("2026-03-15", { balanceLeftPct: 70 }), // a glitchy ride: the median ignores it
    ride("2026-03-20", { pedallingMin: 10, balanceLeftPct: 90 }), // too short to count
    ride("2026-09-01", { balanceLeftPct: 51, pcoLeftMm: -1 }),
    ride("2026-09-08", { balanceLeftPct: 51, pcoLeftMm: -1, indoor: true }),
  ];
  const s = summarisePedallingHistory(rides, { splitAt: "2026-06-01" });
  assert.equal(s.total, 5);
  assert.deepEqual(s.months.map((m) => [m.label, m.rides, m.balanceLeftPct]), [["2026-03", 3, 53], ["2026-09", 2, 51]]);
  assert.equal(s.before!.pcoLeftMm, -4);
  assert.equal(s.after!.pcoLeftMm, -1);
  assert.equal(s.indoor.rides, 1);
  assert.equal(summarisePedallingHistory(rides, { indoor: "outdoor" }).total, 4);
  assert.equal(summarisePedallingHistory(rides, { from: "2026-09-01" }).total, 2);
});

test("formatPedallingHistory: missing channels read —, an empty history says how to fill it", () => {
  const text = formatPedallingHistory(summarisePedallingHistory([ride("2026-03-01", { teLeft: null, teRight: null })])).join("\n");
  assert.match(text, /2026-03\s+1\s+bal 52%/);
  assert.match(text, /TE —/);
  const empty = formatPedallingHistory(summarisePedallingHistory([])).join("\n");
  assert.match(empty, /archive:backfill/);
});
