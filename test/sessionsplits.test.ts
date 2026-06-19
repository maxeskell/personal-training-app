import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFit } from "../src/insights/fitParser.js";
import {
  computeCss,
  detectCssEffortsFromLaps,
  parseClock,
  lapSplits,
  lengthSplits,
  formatSplits,
  formatCss,
} from "../src/insights/sessionSplits.js";

/**
 * Builds minimal valid .FIT buffers carrying lap (msg 19) and length (msg 101) records — pinning the
 * FIT field numbers/scales the splits + CSS layer relies on — then exercises the CSS math and its
 * maximal-effort confidence checks (the guardrail against a soft test yielding a soft CSS).
 */

function def(local: number, global: number, fields: Array<[num: number, size: number, base: number]>): Buffer {
  const b = Buffer.alloc(6 + 3 * fields.length);
  b.writeUInt8(0x40 | local, 0);
  b.writeUInt8(0, 1);
  b.writeUInt8(0, 2); // little-endian
  b.writeUInt16LE(global, 3);
  b.writeUInt8(fields.length, 5);
  let o = 6;
  for (const [num, size, base] of fields) {
    b.writeUInt8(num, o);
    b.writeUInt8(size, o + 1);
    b.writeUInt8(base, o + 2);
    o += 3;
  }
  return b;
}
function rec(local: number, values: Buffer): Buffer {
  return Buffer.concat([Buffer.from([local & 0x0f]), values]);
}
function fitFile(records: Buffer[]): Buffer {
  const body = Buffer.concat(records);
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0);
  header.writeUInt8(0x10, 1);
  header.writeUInt16LE(0, 2);
  header.writeUInt32LE(body.length, 4);
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, body]);
}

// base types: enum=0x00, uint8=0x02, uint16=0x84, uint32=0x86.
const sessionDef = def(0, 18, [[5, 1, 0x00], [44, 2, 0x84]]); // sport, pool_length
function sessionData(sport: number, poolLenHm: number): Buffer {
  const v = Buffer.alloc(3);
  v.writeUInt8(sport, 0);
  v.writeUInt16LE(poolLenHm, 1); // ×100 m
  return rec(0, v);
}
const lapDef = def(1, 19, [[254, 2, 0x84], [8, 4, 0x86], [9, 4, 0x86], [15, 1, 0x02]]); // index, timer, distance, avg_hr
function lapData(index: number, timerMs: number, distHm: number, hr: number): Buffer {
  const v = Buffer.alloc(11);
  v.writeUInt16LE(index, 0);
  v.writeUInt32LE(timerMs, 2); // ×1000 s
  v.writeUInt32LE(distHm, 6); // ×100 m
  v.writeUInt8(hr, 10);
  return rec(1, v);
}
const lengthDef = def(2, 101, [[254, 2, 0x84], [4, 4, 0x86], [12, 1, 0x00]]); // index, timer, length_type
function lengthData(index: number, timerMs: number, type: number): Buffer {
  const v = Buffer.alloc(7);
  v.writeUInt16LE(index, 0);
  v.writeUInt32LE(timerMs, 2);
  v.writeUInt8(type, 6);
  return rec(2, v);
}

test("parseFit decodes lap (19) and length (101) records with the right scales", () => {
  const buf = fitFile([
    sessionDef,
    sessionData(5, 2500), // swim, 25 m pool
    lapDef,
    lapData(1, 380000, 40000, 160), // 400 m in 380 s
    lapData(2, 175000, 20000, 165), // 200 m in 175 s
    lengthDef,
    lengthData(1, 30000, 1), // 30 s active
    lengthData(2, 20000, 0), // rest
  ]);
  const act = parseFit(buf)!;
  assert.ok(act);
  assert.equal(act.sport, 5);
  assert.equal(act.session.poolLengthM, 25);
  assert.equal(act.laps.length, 2);
  assert.equal(act.laps[0].distanceM, 400);
  assert.equal(act.laps[0].timerS, 380);
  assert.equal(act.laps[0].avgHr, 160);
  assert.equal(act.lengths.length, 2);
  assert.equal(act.lengths[0].timerS, 30);
  assert.equal(act.lengths[0].lengthType, 1);
  assert.equal(act.lengths[1].lengthType, 0);
});

test("computeCss: valid 400/200 → CSS = (T400−T200)/2, high confidence", () => {
  const r = computeCss({ t400Sec: 380, t200Sec: 175, source: "explicit" });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.cssSecPer100m, 103); // (380−175)/2 = 102.5 → 103
  assert.equal(r.confidence, "high");
  assert.match(r.display, /1:43/);
});

test("computeCss: swapped times error out (never invents a CSS)", () => {
  const r = computeCss({ t400Sec: 175, t200Sec: 380, source: "explicit" });
  assert.ok("error" in r);
});

test("computeCss: a 400 not slower per-100m than the 200 → low confidence + flag", () => {
  // t400=340, t200=175 → 340 ≤ 2·175=350, so the 400 wasn't the slower per-100m effort.
  const r = computeCss({ t400Sec: 340, t200Sec: 175, source: "explicit" });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.confidence, "low");
  assert.ok(r.flags.some((f) => /not slower|maximal|swapped/i.test(f)));
});

test("computeCss: submaximal HR downgrades confidence and is flagged", () => {
  const r = computeCss({ t400Sec: 380, t200Sec: 175, avgHr400: 140, avgHr200: 138, maxHr: 190, source: "auto-laps" });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.notEqual(r.confidence, "high");
  assert.ok(r.flags.some((f) => /submaximal|% of max/i.test(f)));
});

test("detectCssEffortsFromLaps: picks the FASTEST ~400 and ~200 laps", () => {
  const buf = fitFile([
    lapDef,
    lapData(1, 400000, 40000, 150), // slower 400
    lapData(2, 380000, 40000, 160), // faster 400 ← pick this
    lapData(3, 175000, 20000, 165), // 200
    lapData(4, 60000, 5000, 120), // 50 m — ignored
  ]);
  const act = parseFit(buf)!;
  const e = detectCssEffortsFromLaps(act.laps);
  assert.ok(e);
  assert.equal(e!.t400Sec, 380);
  assert.equal(e!.t200Sec, 175);
  assert.equal(e!.source, "auto-laps");
});

test("detectCssEffortsFromLaps: returns null when a 400 or 200 is absent (asks rather than guesses)", () => {
  const buf = fitFile([lapDef, lapData(1, 380000, 40000, 160)]); // only a 400
  const act = parseFit(buf)!;
  assert.equal(detectCssEffortsFromLaps(act.laps), null);
});

test("parseClock: seconds, m:ss and h:mm:ss; rejects junk", () => {
  assert.equal(parseClock(380), 380);
  assert.equal(parseClock("380"), 380);
  assert.equal(parseClock("6:20"), 380);
  assert.equal(parseClock("1:00:00"), 3600);
  assert.equal(parseClock("abc"), null);
  assert.equal(parseClock(undefined), null);
  assert.equal(parseClock(0), null);
});

test("lapSplits / lengthSplits: pace and distance derive correctly", () => {
  const buf = fitFile([
    sessionDef,
    sessionData(5, 2500),
    lapDef,
    lapData(1, 380000, 40000, 160),
    lengthDef,
    lengthData(1, 30000, 1),
  ]);
  const act = parseFit(buf)!;
  const laps = lapSplits(act);
  assert.equal(laps[0].distanceM, 400);
  assert.equal(laps[0].paceSecPer100m, 95); // 380/400*100
  const lens = lengthSplits(act);
  assert.equal(lens[0].distanceM, 25); // pool length
  assert.equal(lens[0].paceSecPer100m, 120); // 30 s / 25 m * 100
});

test("formatCss: labels a MODEL and keeps the read-only 'set it in AI Endurance' reminder", () => {
  const text = formatCss(computeCss({ t400Sec: 380, t200Sec: 175, source: "explicit" })).join("\n");
  assert.match(text, /MODEL/);
  assert.match(text, /AI Endurance/i);
  assert.match(text, /Read-only/i);
});

test("formatSplits: a continuous effort (no laps/lengths) says so rather than inventing splits", () => {
  const buf = fitFile([sessionDef, sessionData(2, 0)]); // a ride, no laps
  const act = parseFit(buf)!;
  assert.match(formatSplits(act).join("\n"), /No lap\/length structure/);
});
