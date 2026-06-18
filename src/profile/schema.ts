import { z } from "zod";

/**
 * Athlete-profile schema — STABLE context only (body, kit, medical, availability, fuelling, race
 * targets). This is the residue no training API holds; live numbers (FTP, weight, paces, swim CSS,
 * HRV, training load) are pulled live from AI Endurance / Garmin and MUST NOT live here. The guard
 * `assertNoLiveNumbers` enforces that intent (see step 4 of the build brief).
 *
 * Validation is deliberately PERMISSIVE on the free-form blocks (biomechanics, equipment, bike_fit,
 * fuelling) so a richly-filled real profile isn't rejected — it strictly checks the CONTRACT instead:
 * enum domains (sex/units/priority/weekday), date formats, schema_version, and the no-live-numbers
 * rule. The blank `profile.example.yaml` (every field null) and a filled `profile.local.yaml` both
 * pass. Required-field enforcement for new users happens in the setup intake, not at load.
 */

const optStr = z.string().min(1).nullable().optional();
const optDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD")
  .nullable()
  .optional();
const strOrNum = z.union([z.string(), z.number()]).nullable().optional();

export const WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const;
const weekday = z.enum(WEEKDAYS);

/** Free-form map/list: type-checked as a container but its contents are left open (rich real data). */
const looseMap = z.record(z.unknown());
const looseList = z.array(z.unknown());

export const RaceSchema = z
  .object({
    name: optStr,
    priority: z.enum(["A", "B", "C"]).nullable().optional(),
    date: optDate,
    distance: z.enum(["sprint", "olympic", "70.3", "ironman", "other"]).nullable().optional(),
    target_time: optStr, // a TARGET like "sub 2:00" — never a live number
    note: optStr,
  })
  .passthrough();
export type Race = z.infer<typeof RaceSchema>;

export const MedicationSchema = z
  .object({
    name: optStr,
    brand: optStr,
    dose: optStr,
    dose_day: weekday.nullable().optional(),
    gi_trough_days: z.array(weekday).optional(),
    implications: z.array(z.string()).optional(),
  })
  .passthrough();

export const ProfileSchema = z
  .object({
    schema_version: z.number().int().positive(),
    identity: z
      .object({
        name: optStr,
        sex: z.enum(["male", "female", "other"]).nullable().optional(),
        date_of_birth: optDate,
        location: optStr,
        units: z.enum(["metric", "imperial"]).nullable().optional(),
        timezone: optStr,
      })
      .passthrough(),
    biomechanics: looseMap.optional(),
    health: z
      .object({
        conditions: looseList.optional(),
        strength_sessions_per_week: strOrNum,
        sleep: optStr,
        medication: MedicationSchema.optional(),
      })
      .passthrough()
      .optional(),
    availability: looseMap.optional(),
    equipment: looseMap.optional(),
    bike_fit: looseMap.optional(),
    fuelling: looseMap.optional(),
    races: z.array(RaceSchema).optional(),
    ai_endurance_todo: looseMap.optional(),
    open_items: looseList.optional(),
  })
  .passthrough();

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Live-performance keys that must NEVER appear as a number in the profile — they come live from AI
 * Endurance / Garmin. Matched against object keys; only a NUMERIC value trips the guard, so status
 * strings like `ai_endurance_todo.ftp_w: unresolved` / `swim_css: not_set` are fine, while a stray
 * `ftp_w: 223` anywhere fails loudly. Deliberately narrow so equipment/fit/fuelling numbers
 * (crank_length_mm, carb_target_g_per_hour, saddle_height_mm, …) are NOT caught.
 */
const LIVE_METRIC_KEY =
  /(ftp|css|vo2|hrv|resting_?hr|(^|_)rhr(_|$)|pace|weight|(^|_)(ctl|atl|tsb)(_|$)|training_load|load_ratio)/i;

/** Walk the profile and collect any live-metric key holding a numeric value, with its path. */
function findLiveNumbers(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findLiveNumbers(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (typeof v === "number" && Number.isFinite(v) && LIVE_METRIC_KEY.test(k)) out.push(`${here}: ${v}`);
      else findLiveNumbers(v, here, out);
    }
  }
}

/**
 * Enforce the "stable context only" intent: throw if the profile stores a live performance number.
 * Called by the loader after schema validation so a misuse fails loudly rather than silently shadowing
 * the live AI Endurance / Garmin value.
 */
export function assertNoLiveNumbers(profile: unknown): void {
  const found: string[] = [];
  findLiveNumbers(profile, "", found);
  if (found.length) {
    throw new Error(
      `Profile must hold no live performance numbers (found ${found.join(", ")}). ` +
        `FTP, weight, paces, swim CSS, HRV and training load come live from AI Endurance / Garmin — keep them out of the profile.`,
    );
  }
}

export interface DoseCycle {
  dose_day: string;
  /** Whole days since the most recent dose weekday (0 on dose day). */
  days_since_dose: number;
  /** Whether today's weekday falls in the configured GI-trough window. */
  in_gi_trough: boolean;
  gi_trough_days: string[];
}

// JS Date#getUTCDay order: 0 = Sunday … 6 = Saturday.
const DOW = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/**
 * Derive the medication dose-cycle for `today` (YYYY-MM-DD) from `dose_day` + `gi_trough_days`. The
 * key personalisation a generic endurance MCP can't do. Returns null when no `medication.dose_day` is
 * set (no medication context to compute).
 */
export function computeDoseCycle(profile: Profile, today: string): DoseCycle | null {
  const med = profile.health?.medication;
  const doseDay = med?.dose_day ? String(med.dose_day).toLowerCase() : null;
  if (!doseDay) return null;
  const doseIdx = DOW.indexOf(doseDay);
  if (doseIdx < 0) return null;
  const todayDow = new Date(`${today}T00:00:00Z`).getUTCDay();
  const days_since_dose = (todayDow - doseIdx + 7) % 7;
  const trough = (med?.gi_trough_days ?? []).map((d) => String(d).toLowerCase());
  return { dose_day: doseDay, days_since_dose, in_gi_trough: trough.includes(DOW[todayDow]), gi_trough_days: trough };
}

/**
 * Parse + validate a profile from YAML-parsed data: schema check, then the no-live-numbers guard.
 * Throws a clear error (caller decides loud vs degrade). Pure — no IO.
 */
export function validateProfile(data: unknown): Profile {
  const profile = ProfileSchema.parse(data);
  assertNoLiveNumbers(profile);
  return profile;
}
