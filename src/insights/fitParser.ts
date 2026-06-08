/**
 * Dependency-free .FIT decoder (Phase 2, .FIT-canonical decision).
 *
 * Decodes a Garmin .FIT activity into per-second samples + a session summary, so the stream layer can
 * read RAW .FIT exports directly (no Python/extraction step). Field numbers and scales below were
 * verified against the athlete's own FR970/Edge files: power=7, cadence=4, temperature=13, HR=3,
 * enhanced_speed=73 (×1000 m/s), distance=5 (×100 m), enhanced_altitude=78 (×5 −500 m), and the
 * running-dynamics fields (vertical_oscillation=39, stance_time=41, vertical_ratio=83, step_length=85,
 * stance_time_balance=84) that populate on running-power/HRM runs — verified against a real FR970 run.
 *
 * It handles the FIT essentials: 12/14-byte header, definition/data/compressed-timestamp records,
 * per-message architecture (endianness), developer fields (skipped), arrays (first element), and the
 * per-base-type "invalid" sentinels (→ null). Manufacturer-proprietary messages/fields are ignored.
 */

const BASE: Record<number, { size: number; invalid: number | bigint }> = {
  0: { size: 1, invalid: 0xff }, // enum
  1: { size: 1, invalid: 0x7f }, // sint8
  2: { size: 1, invalid: 0xff }, // uint8
  3: { size: 2, invalid: 0x7fff }, // sint16
  4: { size: 2, invalid: 0xffff }, // uint16
  5: { size: 4, invalid: 0x7fffffff }, // sint32
  6: { size: 4, invalid: 0xffffffff }, // uint32
  7: { size: 1, invalid: 0x00 }, // string (byte-wise; not used here)
  8: { size: 4, invalid: 0xffffffff }, // float32
  9: { size: 8, invalid: 0xffffffffffffffffn }, // float64
  10: { size: 1, invalid: 0x00 }, // uint8z
  11: { size: 2, invalid: 0x0000 }, // uint16z
  12: { size: 4, invalid: 0x00000000 }, // uint32z
  13: { size: 1, invalid: 0xff }, // byte
  14: { size: 8, invalid: 0x7fffffffffffffffn }, // sint64
  15: { size: 8, invalid: 0xffffffffffffffffn }, // uint64
  16: { size: 8, invalid: 0x0000000000000000n }, // uint64z
};

interface FieldDef {
  num: number;
  size: number;
  base: number;
  dev: boolean;
}
interface MsgDef {
  global: number;
  le: boolean;
  fields: FieldDef[];
}

/** One decoded scalar (already endian-aware), or null if it was the invalid sentinel. */
function readScalar(buf: Buffer, off: number, base: number, le: boolean): number | null {
  const b = base & 0x1f;
  const meta = BASE[b] ?? BASE[2];
  let v: number | bigint;
  switch (b) {
    case 1: v = buf.readInt8(off); break;
    case 2: case 0: case 10: case 13: v = buf.readUInt8(off); break;
    case 3: v = le ? buf.readInt16LE(off) : buf.readInt16BE(off); break;
    case 4: case 11: v = le ? buf.readUInt16LE(off) : buf.readUInt16BE(off); break;
    case 5: v = le ? buf.readInt32LE(off) : buf.readInt32BE(off); break;
    case 6: case 12: v = le ? buf.readUInt32LE(off) : buf.readUInt32BE(off); break;
    case 8: v = le ? buf.readFloatLE(off) : buf.readFloatBE(off); break;
    case 9: v = le ? buf.readDoubleLE(off) : buf.readDoubleBE(off); break;
    case 14: case 15: case 16: v = le ? buf.readBigInt64LE(off) : buf.readBigInt64BE(off); break;
    default: v = buf.readUInt8(off);
  }
  if (typeof v === "bigint") return v === meta.invalid ? null : Number(v);
  return v === meta.invalid ? null : v;
}

export interface FitSample {
  t?: number; // unix-ish seconds (FIT epoch + 631065600)
  hr?: number;
  cadence?: number;
  power?: number;
  speed?: number; // m/s
  distance?: number; // m
  altitude?: number; // m
  temperature?: number; // °C
  vo?: number; // vertical oscillation, mm
  gct?: number; // ground contact / stance time, ms
  verticalRatio?: number; // %
  stepLength?: number; // mm
  gctBalance?: number; // stance-time L/R balance, %
  lrBalance?: number; // raw bike left/right power balance field
}

export interface FitActivity {
  sport: number; // FIT sport enum: 1=run, 2=bike, 5=swim
  sportName: string;
  samples: FitSample[];
  session: {
    durationSec?: number;
    distanceKm?: number;
    avgHr?: number;
    avgPower?: number;
    avgCadence?: number;
    avgTempC?: number;
  };
}

const SPORT_NAMES: Record<number, string> = { 0: "generic", 1: "Run", 2: "Ride", 5: "Swim", 11: "Walk", 17: "Hike" };
const FIT_EPOCH_OFFSET = 631065600; // FIT timestamps are seconds since 1989-12-31

/** Map a record's raw field map into a typed sample, applying FIT scales/offsets. */
function toSample(f: Record<number, number | null>): FitSample {
  const g = (k: number) => (f[k] == null ? undefined : (f[k] as number));
  const s: FitSample = {
    t: f[253] != null ? (f[253] as number) + FIT_EPOCH_OFFSET : undefined,
    hr: g(3),
    cadence: g(4) != null ? g(4)! + (g(53) != null ? g(53)! / 128 : 0) : undefined,
    power: g(7),
    speed: g(73) != null ? g(73)! / 1000 : g(6) != null ? g(6)! / 1000 : undefined,
    distance: g(5) != null ? g(5)! / 100 : undefined,
    altitude: g(78) != null ? g(78)! / 5 - 500 : g(2) != null ? g(2)! / 5 - 500 : undefined,
    temperature: g(13),
    vo: g(39) != null ? g(39)! / 10 : undefined, // vertical_oscillation, mm
    gct: g(41) != null ? g(41)! / 10 : undefined, // stance_time, ms
    verticalRatio: g(83) != null ? g(83)! / 100 : undefined, // field 83 (verified on a real run), %
    stepLength: g(85) != null ? g(85)! / 10 : undefined, // mm
    gctBalance: g(84) != null ? g(84)! / 100 : undefined, // stance_time_balance, %
    lrBalance: g(30), // bike left/right power balance (raw)
  };
  return s;
}

function mean(xs: number[]): number | undefined {
  return xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : undefined;
}

export function parseFit(buf: Buffer): FitActivity | null {
  if (buf.length < 14) return null;
  const headerSize = buf.readUInt8(0);
  if (buf.toString("ascii", 8, 12) !== ".FIT") return null;
  const dataSize = buf.readUInt32LE(4);
  let pos = headerSize;
  const end = Math.min(buf.length, headerSize + dataSize);

  const defs = new Map<number, MsgDef>();
  const samples: FitSample[] = [];
  let sportEnum = 0;
  let session: Record<number, number | null> = {};

  try {
    while (pos < end) {
      const h = buf.readUInt8(pos++);
      if (h & 0x80) {
        // compressed-timestamp data record
        const def = defs.get((h >> 5) & 0x3);
        if (!def) break;
        const rec = readData(buf, pos, def);
        pos = rec.pos;
        if (def.global === 20) samples.push(toSample(rec.fields));
        continue;
      }
      const local = h & 0x0f;
      if (h & 0x40) {
        // definition message
        const le = buf.readUInt8(pos + 1) === 0;
        const global = le ? buf.readUInt16LE(pos + 2) : buf.readUInt16BE(pos + 2);
        const nFields = buf.readUInt8(pos + 4);
        pos += 5;
        const fields: FieldDef[] = [];
        for (let i = 0; i < nFields; i++) {
          fields.push({ num: buf.readUInt8(pos), size: buf.readUInt8(pos + 1), base: buf.readUInt8(pos + 2), dev: false });
          pos += 3;
        }
        if (h & 0x20) {
          const nDev = buf.readUInt8(pos++);
          for (let i = 0; i < nDev; i++) {
            fields.push({ num: 1000 + buf.readUInt8(pos), size: buf.readUInt8(pos + 1), base: 0x0d, dev: true });
            pos += 3;
          }
        }
        defs.set(local, { global, le, fields });
      } else {
        // data message
        const def = defs.get(local);
        if (!def) break;
        const rec = readData(buf, pos, def);
        pos = rec.pos;
        if (def.global === 20) samples.push(toSample(rec.fields));
        else if (def.global === 18) session = rec.fields;
        else if (def.global === 12 && rec.fields[0] != null) sportEnum = rec.fields[0] as number;
      }
    }
  } catch {
    // Truncated/odd file — return whatever we decoded so far rather than throwing.
  }

  if (session[5] != null) sportEnum = session[5] as number;
  const temps = samples.map((s) => s.temperature).filter((x): x is number => x != null);
  const ts = samples.map((s) => s.t).filter((x): x is number => x != null);

  return {
    sport: sportEnum,
    sportName: SPORT_NAMES[sportEnum] ?? `sport-${sportEnum}`,
    samples,
    session: {
      durationSec: ts.length > 1 ? ts[ts.length - 1] - ts[0] : undefined,
      distanceKm: session[9] != null ? +(((session[9] as number) / 100) / 1000).toFixed(2) : undefined,
      avgHr: session[16] != null && (session[16] as number) < 255 ? (session[16] as number) : undefined,
      avgPower: session[20] != null && (session[20] as number) < 65535 ? (session[20] as number) : undefined,
      avgCadence: session[18] != null && (session[18] as number) < 255 ? (session[18] as number) : undefined,
      avgTempC: mean(temps),
    },
  };
}

function readData(buf: Buffer, pos: number, def: MsgDef): { pos: number; fields: Record<number, number | null> } {
  const fields: Record<number, number | null> = {};
  for (const fd of def.fields) {
    const baseSize = (BASE[fd.base & 0x1f] ?? BASE[2]).size;
    if (!fd.dev && fd.size >= baseSize && pos + baseSize <= buf.length) {
      // Arrays (size > one element) → take the first element; the rest is skipped.
      fields[fd.num] = readScalar(buf, pos, fd.base, def.le);
    }
    pos += fd.size;
  }
  return { pos, fields };
}
