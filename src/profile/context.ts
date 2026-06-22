import { computeDoseCycle, type DoseCycle, type Profile } from "./schema.js";
import { bikeRaceWeights } from "./equipment.js";
import { medicalExposed } from "../mcp/medicalExposure.js";
import type { LoadedProfile } from "./load.js";

/**
 * Render the athlete profile for prompts. Two surfaces:
 *  - `renderProfileContext` → a compact block injected into the LIVE coaching context (weekly / race /
 *    ask / deep-dive), so the coach knows the medical/biomechanical/availability context AI Endurance
 *    can't hold. Stable context ONLY — never live numbers (those are elsewhere in the prompt, live).
 *  - `formatProfileForTool` → the readable `get_profile` MCP output (the validated profile + dose_cycle).
 *
 * Everything is defensive: only fields that are actually present render, nothing is invented, and the
 * free-form blocks are read through small type-guards so a partially-filled profile can't throw.
 */

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const arr = (v: unknown): unknown[] | null => (Array.isArray(v) ? v : null);

/** Whole years from a YYYY-MM-DD date of birth to `today`, or null. */
function ageFrom(dob: string | null, today: string): number | null {
  if (!dob) return null;
  const b = new Date(`${dob}T00:00:00Z`);
  const t = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(b.getTime()) || Number.isNaN(t.getTime())) return null;
  let age = t.getUTCFullYear() - b.getUTCFullYear();
  const m = t.getUTCMonth() - b.getUTCMonth();
  if (m < 0 || (m === 0 && t.getUTCDate() < b.getUTCDate())) age--;
  return age >= 0 && age < 150 ? age : null;
}

function identityLine(p: Profile, today: string): string | null {
  const id = p.identity ?? {};
  const age = ageFrom(str(id.date_of_birth), today);
  const bits = [str(id.name), str(id.sex), age != null ? `${age}y` : null, str(id.location)].filter(Boolean);
  if (!bits.length) return null;
  const units = str(id.units);
  const tz = str(id.timezone);
  const tail = [units ? `units ${units}` : null, tz].filter(Boolean).join(", ");
  return `- Identity: ${bits.join(", ")}${tail ? ` (${tail})` : ""}.`;
}

function medicationLines(p: Profile, today: string): string[] {
  const med = p.health?.medication;
  if (!med) return [];
  const name = str(med.name);
  const head = [name, str(med.brand) && str(med.dose) ? `${str(med.brand)} ${str(med.dose)}` : str(med.brand) ?? str(med.dose)]
    .filter(Boolean)
    .join(", ");
  if (!head) return [];
  const dc: DoseCycle | null = computeDoseCycle(p, today);
  const cyc = dc
    ? ` Dose ${dc.dose_day}; today ${dc.days_since_dose}d since dose, ${dc.in_gi_trough ? "IN" : "not in"} the GI trough${dc.gi_trough_days.length ? ` (${dc.gi_trough_days.join("/")})` : ""}.`
    : "";
  const impl = (med.implications ?? []).map((s) => String(s)).filter(Boolean);
  const out = [`- Medication: ${head}.${cyc}`.trim()];
  if (impl.length) out.push(`  Coaching implications: ${impl.join(" ")}`);
  return out;
}

/** Whole months from `fromDate` to `today` (both YYYY-MM-DD), or null on a bad/future date. */
function monthsBetween(fromDate: string, today: string): number | null {
  const a = new Date(`${fromDate}T00:00:00Z`);
  const b = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months--;
  return months >= 0 ? months : null;
}

/** A panel older than this surfaces a re-test nudge — bloods are typically worth refreshing ~yearly. */
const STALE_BLOOD_PANEL_MONTHS = 12;

/**
 * Surface the most recent blood panel as a SNAPSHOT (never as a current number): its date + age, the
 * curated flags/notes, and a pointer to get_profile for the full marker values — raw markers are NOT
 * dumped into the compact block. Honest-models rule: a value is always reported with how old it is, and
 * a panel over a year old gets a re-test nudge.
 */
function bloodsLines(p: Profile, today: string): string[] {
  const b = obj(p.bloods);
  if (!b) return [];
  const panels = (arr(b.panels) ?? [])
    .map(obj)
    .filter((x): x is Record<string, unknown> => Boolean(x && str(x.date)));
  if (!panels.length) return [];
  panels.sort((x, y) => String(y.date).localeCompare(String(x.date)));
  const latest = panels[0];
  const date = str(latest.date)!;
  const months = monthsBetween(date, today);
  const ageBit = months != null ? `, ~${months} month${months === 1 ? "" : "s"} ago` : "";
  const stale = months != null && months >= STALE_BLOOD_PANEL_MONTHS;
  const source = str(latest.source);
  const takeaways = [...(arr(latest.flags) ?? []), ...(arr(latest.notes) ?? [])]
    .map(str)
    .filter((s): s is string => Boolean(s));
  const markerCount = obj(latest.markers) ? Object.keys(obj(latest.markers)!).length : 0;
  const head = `- Bloods (latest panel ${date}${ageBit}${source ? `, ${source}` : ""} — SNAPSHOT, not live${stale ? "; over a year old, consider a re-test" : ""}):`;
  const body = takeaways.length ? ` ${takeaways.join(" | ")}.` : " no notes recorded.";
  const tail = markerCount ? ` ${markerCount} marker${markerCount === 1 ? "" : "s"} recorded — full values via get_profile.` : "";
  const out = [`${head}${body}${tail}`];
  if (panels.length > 1) out.push(`  (${panels.length} panels on file; trend available via get_profile.)`);
  return out;
}

function biomechanicsLine(p: Profile): string | null {
  const b = obj(p.biomechanics);
  if (!b) return null;
  const parts: string[] = [];
  const lld = obj(b.leg_length_difference);
  if (lld && lld.present === true) {
    const seg = [
      str(lld.shorter_side) ? `${str(lld.shorter_side)} leg shorter` : "leg-length difference",
      num(lld.run_correction_mm) != null ? `${num(lld.run_correction_mm)}mm run lift (${str(lld.run_correction_status) ?? "status?"})` : null,
      num(lld.bike_correction_mm) != null ? `${num(lld.bike_correction_mm)}mm bike shim (${str(lld.bike_correction_status) ?? "status?"})` : null,
    ].filter(Boolean);
    parts.push(seg.join(", "));
  }
  const asym = obj(b.asymmetry);
  if (asym && str(asym.side)) parts.push(`${str(asym.side)}-side asymmetry`);
  const cleat = obj(b.cleat);
  if (cleat && str(cleat.cue)) parts.push(`cleat cue: ${str(cleat.cue)}`);
  return parts.length ? `- Biomechanics: ${parts.join("; ")}.` : null;
}

function availabilityLine(p: Profile): string | null {
  const a = obj(p.availability);
  if (!a) return null;
  const parts = [
    a.weekly_hours != null ? `${a.weekly_hours}h/week` : null,
    str(a.rest_day) ? `rest ${str(a.rest_day)}` : null,
  ].filter(Boolean) as string[];
  const fixed = obj(a.fixed_sessions);
  if (fixed) {
    const f = Object.entries(fixed)
      .map(([d, v]) => (str(v) ? `${d} ${str(v)}` : null))
      .filter(Boolean);
    if (f.length) parts.push(`fixed: ${f.join(", ")}`);
  }
  const notes = str(a.notes);
  let line = parts.length ? `- Availability: ${parts.join("; ")}.` : null;
  if (notes) line = `${line ?? "- Availability:"} Note: ${notes}`;
  return line;
}

function bikeWeightLine(p: Profile): string | null {
  const bikes = bikeRaceWeights(p);
  if (!bikes.length) return null;
  const parts = bikes.map((b) => `${b.name} ${b.raceWeightKg}kg`);
  // The rider's live weight is already in this prompt (from get_state); flag the combination so the
  // coach can size tyre pressure off total system weight rather than asking for the bike mass.
  return `- Bike race weight (as-raced, incl. bottle) [add the live weight above for total system weight, e.g. tyre pressure]: ${parts.join(", ")}.`;
}

function fuellingLine(p: Profile): string | null {
  const f = obj(p.fuelling);
  if (!f) return null;
  const parts: string[] = [];
  const carb = obj(f.carb_target_g_per_hour);
  if (carb) {
    const c = Object.entries(carb)
      .map(([k, v]) => (num(v) != null ? `${k} ${num(v)}g/h` : null))
      .filter(Boolean);
    if (c.length) parts.push(`carb ${c.join(", ")}`);
  }
  if (str(f.caffeine)) parts.push(`caffeine: ${str(f.caffeine)}`);
  return parts.length ? `- Fuelling: ${parts.join("; ")}.` : null;
}

function raceTargetLines(p: Profile): string[] {
  const races = (p.races ?? []).filter((r) => str(r.name) || str(r.date));
  if (!races.length) return [];
  const rows = races.map((r) => {
    const bits = [str(r.name), str(r.date), str(r.priority) ? `priority ${str(r.priority)}` : null, str(r.target_time) ? `target ${str(r.target_time)}` : null]
      .filter(Boolean)
      .join(", ");
    return `  · ${bits}`;
  });
  return ["- Race targets (the athlete's own; mirror in AI Endurance — read-only from here):", ...rows];
}

function todoLine(p: Profile): string | null {
  const t = obj(p.ai_endurance_todo);
  if (!t) return null;
  const parts = Object.entries(t)
    .map(([k, v]) => (str(v) ? `${k}=${str(v)}` : null))
    .filter(Boolean);
  return parts.length ? `- Set-in-AI-Endurance (read-only here): ${parts.join(", ")}.` : null;
}

/**
 * Compact profile block for the coaching prompts. Returns "" when there's nothing meaningful to add.
 * `exposeMedical` (default: the surface gate, ON locally) drops the medication + bloods lines so the
 * remote HTTP/Cowork surface doesn't launder medical detail into an LLM prompt unless opted in.
 */
export function renderProfileContext(profile: Profile, today: string, exposeMedical = medicalExposed()): string {
  const lines = [
    identityLine(profile, today),
    ...(exposeMedical ? medicationLines(profile, today) : []),
    ...(exposeMedical ? bloodsLines(profile, today) : []),
    biomechanicsLine(profile),
    availabilityLine(profile),
    bikeWeightLine(profile),
    fuellingLine(profile),
    ...raceTargetLines(profile),
    todoLine(profile),
  ].filter((l): l is string => Boolean(l));
  if (!lines.length) return "";
  return [
    "ATHLETE PROFILE [local profile.local.yaml — STABLE context only; live numbers come from AI Endurance/Garmin above]:",
    ...lines,
  ].join("\n");
}

/** Strip the medical context (medication/conditions, blood panels, date of birth) from a profile copy
 *  for a surface that isn't allowed to see it. Pure — returns a shallow copy, mutates nothing. */
function withoutMedical(p: Profile): Profile {
  const copy = { ...p } as Record<string, unknown>;
  delete copy.health;
  delete copy.bloods;
  if (copy.identity && typeof copy.identity === "object") {
    const id = { ...(copy.identity as Record<string, unknown>) };
    delete id.date_of_birth;
    copy.identity = id;
  }
  return copy as Profile;
}

/**
 * Readable `get_profile` MCP output: which file won, the dose-cycle, then the validated profile JSON.
 * `exposeMedical` (default: the surface gate, ON locally) withholds medical context — medication/dose
 * cycle, blood panels, date of birth — on the remote HTTP/Cowork surface unless the operator opts in.
 */
export function formatProfileForTool(loaded: LoadedProfile, today: string, exposeMedical = medicalExposed()): string {
  const dc = computeDoseCycle(loaded.profile, today);
  const header = [
    `Athlete profile [source: ${loaded.source} — ${loaded.path}]`,
    exposeMedical
      ? dc
        ? `dose_cycle (computed for ${today}): ${dc.days_since_dose}d since ${dc.dose_day} dose, in_gi_trough=${dc.in_gi_trough}`
        : "dose_cycle: n/a (no medication.dose_day set)"
      : "medical context (medication, dose cycle, bloods, date of birth) is WITHHELD on this surface — set COACH_MCP_EXPOSE_MEDICAL=true to include it.",
    "Live numbers (FTP, weight, paces, swim CSS, HRV, load) are NOT here — use get_state for those.",
    "",
  ].join("\n");
  const body = exposeMedical ? { ...loaded.profile, dose_cycle: dc } : withoutMedical(loaded.profile);
  return header + JSON.stringify(body, null, 2);
}
