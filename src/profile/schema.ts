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
// zod 4 requires an explicit key type — z.record(valueType) single-arg was removed. String keys preserve
// the prior "arbitrary keys" behaviour.
const looseMap = z.record(z.string(), z.unknown());
const looseList = z.array(z.unknown());

export const RaceSchema = z
  .object({
    name: optStr,
    priority: z.enum(["A", "B", "C"]).nullable().optional(),
    date: optDate,
    // "middle" is the standard UK term for a 70.3 (1.9/90/21.1) — a first-class distance, not "other".
    distance: z.enum(["sprint", "olympic", "70.3", "middle", "ironman", "other"]).nullable().optional(),
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

/**
 * One dated blood-panel snapshot. Bloods are a deliberate exception to "no numbers here": NO training
 * API holds them, so a dated snapshot is stable context, not a live duplicate. `markers` is a free-form
 * `name_unit → number` map (e.g. `ferritin_ug_l: 70.2`); the no-live-numbers guard still runs over it,
 * so a live-metric key (hr/hrv/ftp/pace/…) planted among markers is rejected. `date` is required for the
 * age/re-test nudge to be honest about how old the panel is.
 */
export const BloodPanelSchema = z
  .object({
    date: optDate,
    source: optStr,
    markers: looseMap.optional(),
    flags: z.array(z.string()).optional(),
    notes: z.array(z.string()).optional(),
  })
  .passthrough();

export const BloodsSchema = z
  .object({
    panels: z.array(BloodPanelSchema).optional(),
  })
  .passthrough();
export type Bloods = z.infer<typeof BloodsSchema>;

/**
 * Multi-season plan — the strategic arc the `/season` page grades against (rebuild → 70.3 → Ironman).
 * Holds INTENT only, never live numbers: `ctl_target` is a target expression ("55", "55-60"), like a
 * race `target_time` ("sub 2:00"), so the no-live-numbers guard is satisfied (a numeric CTL would be
 * rejected as a live metric). Each phase runs until its `until` date; the active phase is the first whose
 * `until` is still in the future.
 */
export const SeasonPhaseSchema = z
  .object({
    name: optStr, // e.g. "Rebuild base", "Threshold shift", "IM build"
    focus: optStr, // the one thing this phase is about
    until: optDate, // phase runs until this date (YYYY-MM-DD)
    ctl_target: optStr, // TARGET chronic load as text ("55" / "55-60") — intent, not a live number
  })
  .passthrough();

export const SeasonPlanSchema = z
  .object({
    horizon_goal: optStr, // e.g. "Ironman by 2028"
    target_date: optDate, // the far goal's date
    phases: z.array(SeasonPhaseSchema).optional(),
    notes: optStr,
  })
  .passthrough();
export type SeasonPlan = z.infer<typeof SeasonPlanSchema>;

export const ProfileSchema = z
  .object({
    schema_version: z.number().int().positive(),
    identity: z
      .object({
        name: optStr,
        sex: z.enum(["male", "female", "other"]).nullable().optional(),
        date_of_birth: optDate,
        // Stable anthropometry (NOT a live number): standing height in cm. Garmin/Connect holds this and
        // it barely changes, so it's pre-filled like DOB. Weight, by contrast, IS a live number and stays
        // out of the profile (it's pulled live and the no-live-numbers guard rejects it).
        height_cm: z.number().positive().nullable().optional(),
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
    bloods: BloodsSchema.optional(),
    availability: looseMap.optional(),
    equipment: looseMap.optional(),
    bike_fit: looseMap.optional(),
    fuelling: looseMap.optional(),
    races: z.array(RaceSchema).optional(),
    season_plan: SeasonPlanSchema.optional(),
    ai_endurance_todo: looseMap.optional(),
    open_items: looseList.optional(),
  })
  .passthrough();

export type Profile = z.infer<typeof ProfileSchema>;

/**
 * Live-performance metrics that must NEVER appear as a number in the profile — they come live from AI
 * Endurance / Garmin. We match against the KEY's underscore/camelCase SEGMENTS (not a raw substring),
 * so equipment/fit keys like `lightweight_wheels`, `paceline_offset`, `space_minutes` or `weight_g`
 * are NOT false-positives, while `ftp_w`, `max_hr`, `threshold_w`, `w_per_kg` are caught. A value trips
 * the guard when it's a finite number OR a purely-numeric string ("223") — so status strings like
 * `ai_endurance_todo.ftp_w: unresolved` / `swim_css: not_set` stay fine, but a live number snuck in as
 * text doesn't slip past. Equipment/fit/fuelling numbers (crank_length_mm, carb_target_g_per_hour,
 * saddle_height_mm, …) are NOT caught.
 *
 * Anthropometry note: `weight` IS a live number (changes daily, pulled live) so it stays denied, but
 * HEIGHT is stable body data the profile is allowed to hold — `height`/`height_cm` is in neither
 * LIVE_TOKENS nor LIVE_KEY_PATTERNS, so a numeric `identity.height_cm` validates while a numeric weight
 * anywhere still throws.
 */

/** Normalise a key to lowercase snake_case (so camelCase humps become segment boundaries). */
function normalizeKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

/** Tokens that mark a live metric when they appear as a WHOLE segment of a key. */
const LIVE_TOKENS = new Set(["ftp", "css", "hrv", "rhr", "hr", "lthr", "pace", "ctl", "atl", "tsb", "tss", "wkg"]);

/** Live metrics best matched as multi-segment patterns against the normalised key. */
const LIVE_KEY_PATTERNS: RegExp[] = [
  /(^|_)vo2(max)?(_|$)/,
  /(^|_)threshold(_|$)/, // threshold_w, functional_threshold, threshold_pace
  /(^|_)training_load(_|$)/,
  /(^|_)load_ratio(_|$)/,
  /(^|_)w(atts)?_per_kg(_|$)/,
  /^weight$/, // bare athlete bodyweight — equipment `weight_g`/`weight_grams` stays fine
  /(^|_)body_?weight(_|$)/,
  /(^|_)weight_kg(_|$)/,
];

function isLiveMetricKey(key: string): boolean {
  const norm = normalizeKey(key);
  const segments = norm.split(/[^a-z0-9]+/).filter(Boolean);
  if (segments.some((s) => LIVE_TOKENS.has(s))) return true;
  return LIVE_KEY_PATTERNS.some((re) => re.test(norm));
}

/** A live number, whether stored as a number or as a purely-numeric string (`"223"`, `"4.2"`). */
function isLiveNumberValue(v: unknown): boolean {
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v === "string") return /^[+-]?\d+(\.\d+)?$/.test(v.trim());
  return false;
}

/** Walk the profile and collect any live-metric key holding a live-number value, with its path. */
function findLiveNumbers(node: unknown, path: string, out: string[]): void {
  if (Array.isArray(node)) {
    node.forEach((v, i) => findLiveNumbers(v, `${path}[${i}]`, out));
    return;
  }
  if (node && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      const here = path ? `${path}.${k}` : k;
      if (isLiveMetricKey(k) && isLiveNumberValue(v)) out.push(`${here}: ${v}`);
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
