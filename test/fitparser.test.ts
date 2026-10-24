import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFit } from "../src/insights/fitParser.js";

/**
 * The dependency-free .FIT decoder feeds confident biomechanics findings off hardcoded field numbers,
 * scales and base-type sizes — a wrong constant silently surfaces a wrong "cadence fades" watch, and it
 * had no parser test. This builds minimal but valid .FIT byte buffers (12-byte header + definition/data
 * records) and round-trips known values through `parseFit`, pinning the scales/offsets.
 */

const FIT_EPOCH_OFFSET = 631065600;

/** A FIT definition record (after the record header byte: reserved, arch=LE, global, nFields, fields×3). */
function def(local: number, global: number, fields: Array<[num: number, size: number, base: number]>): Buffer {
  const b = Buffer.alloc(6 + 3 * fields.length);
  b.writeUInt8(0x40 | local, 0); // definition message header
  b.writeUInt8(0, 1); // reserved
  b.writeUInt8(0, 2); // architecture: 0 = little-endian
  b.writeUInt16LE(global, 3); // global message number
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

/** A FIT data record: a header byte (local id) followed by the field values in definition order. */
function data(local: number, values: Buffer): Buffer {
  return Buffer.concat([Buffer.from([local & 0x0f]), values]);
}

/** Wrap data records in a 12-byte FIT header (the parser ignores the trailing CRC). */
function fitFile(records: Buffer[]): Buffer {
  const body = Buffer.concat(records);
  const header = Buffer.alloc(12);
  header.writeUInt8(12, 0); // header size
  header.writeUInt8(0x10, 1); // protocol version
  header.writeUInt16LE(0, 2); // profile version
  header.writeUInt32LE(body.length, 4); // data size
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, body]);
}

// base types: uint8=0x02, sint8=0x01, uint16=0x84, uint32=0x86 (high bit is endian-ability; parser masks it).
const recordDef = def(0, 20, [
  [253, 4, 0x86], // timestamp (uint32)
  [3, 1, 0x02], // heart_rate (uint8)
  [7, 2, 0x84], // power (uint16)
  [4, 1, 0x02], // cadence (uint8)
  [13, 1, 0x01], // temperature (sint8)
]);
function recordData(t: number, hr: number, power: number, cadence: number, temp: number): Buffer {
  const v = Buffer.alloc(9);
  v.writeUInt32LE(t, 0);
  v.writeUInt8(hr, 4);
  v.writeUInt16LE(power, 5);
  v.writeUInt8(cadence, 7);
  v.writeInt8(temp, 8);
  return data(0, v);
}

test("parseFit round-trips per-second record samples with the right scales", () => {
  const buf = fitFile([
    recordDef,
    recordData(1000, 150, 250, 90, 20),
    recordData(1030, 155, 240, 88, 22),
  ]);
  const act = parseFit(buf);
  assert.ok(act, "a valid .FIT must decode");
  assert.equal(act!.samples.length, 2);
  const [a, b] = act!.samples;
  assert.equal(a.t, 1000 + FIT_EPOCH_OFFSET); // FIT epoch offset applied
  assert.equal(a.hr, 150);
  assert.equal(a.power, 250);
  assert.equal(a.cadence, 90);
  assert.equal(a.temperature, 20);
  assert.equal(b.hr, 155);
  assert.equal(b.temperature, 22);
  assert.equal(act!.session.durationSec, 30); // last timestamp − first
});

test("parseFit reads the session summary (sport, distance scale, averages)", () => {
  const sessionDef = def(1, 18, [
    [9, 4, 0x86], // total_distance (uint32, ×100 m)
    [16, 1, 0x02], // avg_heart_rate (uint8)
    [20, 2, 0x84], // avg_power (uint16)
    [18, 1, 0x02], // avg_cadence (uint8)
    [5, 1, 0x02], // sport (enum)
  ]);
  const sv = Buffer.alloc(9);
  sv.writeUInt32LE(123450, 0); // 1234.5 m → 1.23 km
  sv.writeUInt8(145, 4);
  sv.writeUInt16LE(210, 5);
  sv.writeUInt8(85, 7);
  sv.writeUInt8(1, 8); // sport 1 = run
  const buf = fitFile([recordDef, recordData(1000, 150, 250, 90, 20), sessionDef, data(1, sv)]);

  const act = parseFit(buf)!;
  assert.equal(act.sport, 1);
  assert.equal(act.sportName, "Run");
  assert.equal(act.session.distanceKm, 1.23);
  assert.equal(act.session.avgHr, 145);
  assert.equal(act.session.avgPower, 210);
  assert.equal(act.session.avgCadence, 85);
});

test("parseFit rejects non-FIT buffers; the invalid sentinel decodes to undefined", () => {
  assert.equal(parseFit(Buffer.from("not a fit file at all padding padding")), null);
  // heart_rate = 0xFF is the uint8 invalid sentinel → null → sample.hr undefined.
  const buf = fitFile([recordDef, recordData(1000, 0xff, 250, 90, 20)]);
  assert.equal(parseFit(buf)!.samples[0].hr, undefined);
});

test("parseFit decodes sub_sport so an open-water swim is classified (not analysed as a pool swim)", () => {
  // session: sport=5 (swim), sub_sport=18 (open_water). The sub_sport tag is what lets the analysis use
  // GPS pace + drop pool-length assumptions instead of treating every swim the same.
  const sessionDef = def(1, 18, [
    [5, 1, 0x02], // sport (enum)
    [6, 1, 0x02], // sub_sport (enum)
  ]);
  const sv = Buffer.alloc(2);
  sv.writeUInt8(5, 0); // swim
  sv.writeUInt8(18, 1); // open_water
  const buf = fitFile([recordDef, recordData(1000, 130, 0, 30, 22), sessionDef, data(1, sv)]);
  const act = parseFit(buf)!;
  assert.equal(act.sport, 5);
  assert.equal(act.subSport, 18, "open_water sub_sport decoded from session field 6");

  // A pool swim (sub_sport 17 = lap_swimming) decodes distinctly, and an untagged swim is null (not faked).
  const poolV = Buffer.alloc(2);
  poolV.writeUInt8(5, 0);
  poolV.writeUInt8(17, 1);
  assert.equal(parseFit(fitFile([recordDef, recordData(1000, 130, 0, 30, 22), sessionDef, data(1, poolV)]))!.subSport, 17);

  const untaggedDef = def(1, 18, [[5, 1, 0x02]]);
  const uv = Buffer.alloc(1);
  uv.writeUInt8(5, 0);
  assert.equal(parseFit(fitFile([recordDef, recordData(1000, 130, 0, 30, 22), untaggedDef, data(1, uv)]))!.subSport, null);
});

test("parseFit decodes cycling dynamics: torque effectiveness, smoothness, PCO and power phase", () => {
  const dynDef = def(1, 20, [
    [253, 4, 0x86],
    [7, 2, 0x84], // power
    [43, 1, 0x02], // left_torque_effectiveness (scale 2)
    [44, 1, 0x02], // right_torque_effectiveness
    [45, 1, 0x02], // left_pedal_smoothness
    [46, 1, 0x02], // right_pedal_smoothness
    [67, 1, 0x01], // left_pco (sint8 mm)
    [68, 1, 0x01], // right_pco
    [69, 2, 0x02], // left_power_phase [start, end] (uint8, 256 per 360°)
    [71, 2, 0x02], // right_power_phase
  ]);
  const v = Buffer.alloc(16);
  v.writeUInt32LE(2000, 0);
  v.writeUInt16LE(230, 4);
  v.writeUInt8(150, 6); // 75.0 %
  v.writeUInt8(146, 7); // 73.0 %
  v.writeUInt8(44, 8); // 22.0 %
  v.writeUInt8(0xff, 9); // invalid → absent
  v.writeInt8(-3, 10); // left PCO −3 mm (inboard)
  v.writeInt8(4, 11); // right PCO +4 mm
  v.writeUInt8(Math.round((340 * 256) / 360), 12); // left phase starts 340°
  v.writeUInt8(Math.round((220 * 256) / 360), 13); // ends 220°
  v.writeUInt8(0xff, 14); // right phase invalid
  v.writeUInt8(0xff, 15);
  const s = parseFit(fitFile([dynDef, data(1, v)]))!.samples[0];
  assert.equal(s.leftTe, 75);
  assert.equal(s.rightTe, 73);
  assert.equal(s.leftPs, 22);
  assert.equal("rightPs" in s, false, "invalid sentinel → no key, not 0");
  assert.equal(s.leftPco, -3);
  assert.equal(s.rightPco, 4);
  assert.ok(Math.abs(s.leftPhase![0] - 340) < 1.5 && Math.abs(s.leftPhase![1] - 220) < 1.5, `left phase ${s.leftPhase}`);
  assert.equal("rightPhase" in s, false);
});

test("parseFit: a run sample carries no cycling-dynamics keys", () => {
  const s = parseFit(fitFile([recordDef, recordData(1000, 150, 250, 90, 20)]))!.samples[0];
  assert.equal("leftTe" in s || "leftPco" in s || "leftPhase" in s, false);
});

test("parseFit decodes paired sensors from device_info (skips the recorder, dedups repeats)", () => {
  const diDef = def(2, 23, [
    [0, 1, 0x02], // device_index
    [1, 1, 0x02], // device_type (ANT+)
    [2, 2, 0x84], // manufacturer
    [21, 2, 0x8b], // ant_device_number (uint16z)
  ]);
  const di = (index: number, type: number, antId: number) => {
    const v = Buffer.alloc(6);
    v.writeUInt8(index, 0);
    v.writeUInt8(type, 1);
    v.writeUInt16LE(1, 2);
    v.writeUInt16LE(antId, 4);
    return data(2, v);
  };
  const act = parseFit(fitFile([diDef, di(0, 0, 1), di(1, 123, 4242), di(2, 11, 777), di(1, 123, 4242)]))!;
  assert.deepEqual(
    act.devices!.map((d) => [d.deviceType, d.antId]),
    [[123, 4242], [11, 777]],
  );
});
