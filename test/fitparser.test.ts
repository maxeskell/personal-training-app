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
