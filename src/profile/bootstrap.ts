import type { AthleteState, ActualActivity } from "../state/types.js";
import type { Config } from "../config.js";
import type { Goal } from "../coach/seasonContext.js";
import { daysBetween } from "../coach/seasonContext.js";
import type { ProfileIntake } from "./setup.js";

/**
 * Pre-fill the athlete-profile intake from the user's CONNECTED INTEGRATIONS (AI Endurance, optional
 * Garmin), so `profile:init` only has to ask for what no integration holds. Every function here is
 * PURE — no network, no disk — taking the already-assembled `AthleteState` + `config` + `today` and
 * returning plain data, so they're unit-tested on fixtures. The live `buildTodayState()` call stays in
 * setup.ts (the IO seam); this module just maps.
 *
 * Generic by construction: nothing reads the original author's data — it maps whatever the connected
 * account exposes. Two fields are deliberately NOT auto-filled:
 *   - date of birth: AIE exposes `age` but not DOB, so we still ASK (the api age is shown as a hint).
 *   - weekly hours: ESTIMATED from recent training volume and labelled a MODEL — the user confirms.
 * Biomechanics / health / medication / equipment / fuelling are held by NO integration, so they're
 * left as the blank template for the user to hand-edit (the profile's whole reason to exist).
 */

/** Identity (name, sex) from AIE getUser, mapped into the intake shape. Pure. */
export function athleteToIntake(state: AthleteState): Partial<ProfileIntake> {
  const p = state.athleteProfile.value;
  const out: Partial<ProfileIntake> = {};
  if (p?.name && p.name.trim()) out.name = p.name.trim();
  // getUser's sex is already normalised to male/female/<raw> in assemble.ts; only pass the enum values.
  if (p?.sex && /^(male|female|other)$/i.test(p.sex.trim())) out.sex = p.sex.trim().toLowerCase();
  return out;
}

/**
 * Format a target completion time (whole seconds) as a readable "sub H:MM:SS" target — never a live
 * number, just the athlete's own goal. Sub-hour targets render "sub MM:SS". Returns "" for a missing
 * or non-positive value so the caller can omit the field.
 */
export function formatTargetTime(seconds: number | undefined | null): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return "";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  const hms = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  return `sub ${hms}`;
}

/**
 * Map a goal's event type/name to the profile's race `distance` enum
 * (sprint | olympic | 70.3 | ironman | other). The enum is triathlon-distance-centric; anything that
 * doesn't clearly name one of those distances falls back to "other" (a run/swim/bike race is "other").
 */
function distanceFor(g: Goal): "sprint" | "olympic" | "70.3" | "ironman" | "other" {
  const t = `${g.event_type ?? ""} ${g.event_name ?? ""}`.toLowerCase();
  if (/70\.?3|half.?iron|middle.?distance/.test(t)) return "70.3";
  if (/140\.?6|full.?iron|ironman\b|\biron\b/.test(t)) return "ironman";
  if (/\bsprint\b/.test(t)) return "sprint";
  if (/olympic|standard.?distance/.test(t)) return "olympic";
  return "other";
}

/** Map a goal's priority to the profile's A/B/C enum, or null when unknown/unmappable. */
function priorityFor(g: Goal): "A" | "B" | "C" | null {
  if (g.priority == null) return null;
  const s = String(g.priority).trim().toUpperCase();
  if (s === "A" || s === "B" || s === "C") return s;
  // Numeric priorities (1/2/3) map to A/B/C; anything else is left unset.
  if (s === "1") return "A";
  if (s === "2") return "B";
  if (s === "3") return "C";
  return null;
}

export interface BootstrapRace {
  name: string | null;
  priority: "A" | "B" | "C" | null;
  date: string | null;
  distance: "sprint" | "olympic" | "70.3" | "ironman" | "other" | null;
  target_time: string | null;
  note: null;
}

/**
 * Map upcoming AIE goals to the profile's race shape. Only future (or today) dated goals are kept,
 * soonest first, so the profile mirrors the live calendar. The output validates against RaceSchema.
 */
export function goalsToRaces(goals: Goal[], today: string): BootstrapRace[] {
  return goals
    .filter((g) => g.event_date && daysBetween(today, g.event_date) >= 0)
    .sort((a, b) => daysBetween(today, a.event_date!) - daysBetween(today, b.event_date!))
    .map((g) => {
      const name = g.event_name && g.event_name.trim() ? g.event_name.trim() : null;
      const target = formatTargetTime(g.target_completion_time_in_seconds);
      return {
        name,
        priority: priorityFor(g),
        date: g.event_date ? String(g.event_date).slice(0, 10) : null,
        distance: distanceFor(g),
        target_time: target || null,
        note: null,
      };
    });
}

/** ISO-week key (e.g. "2026-W24") for a YYYY-MM-DD date, using UTC. */
function isoWeekKey(dateIso: string): string | null {
  const d = new Date(`${String(dateIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  // ISO week: Thursday-anchored. Shift to the Thursday of this week, then count weeks from year start.
  const day = (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const firstDay = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDay + 3);
  const week = 1 + Math.round((d.getTime() - firstThu.getTime()) / (7 * 86_400_000));
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/**
 * ESTIMATE typical weekly training hours from recent activities — a MODEL, never a live number. Groups
 * activity `durationMin` by ISO week (over the trailing ~8 weeks), drops the partial current week and
 * any zero-volume weeks, takes the MEDIAN representative week, and returns a ±0.5h band (e.g. "10-11").
 * Returns null when there isn't enough data (no full week) so the caller falls back to ASKING.
 */
export function estimateWeeklyHours(
  activities: ActualActivity[] | null | undefined,
  today: string,
): { band: string; weeks: number } | null {
  if (!Array.isArray(activities) || !activities.length) return null;
  const thisWeek = isoWeekKey(today);
  // Only look back ~8 weeks so a long-ago block of training doesn't skew a currently-quiet athlete.
  const minDate = new Date(`${String(today).slice(0, 10)}T00:00:00Z`);
  minDate.setUTCDate(minDate.getUTCDate() - 56);
  const minIso = minDate.toISOString().slice(0, 10);

  const minutesByWeek = new Map<string, number>();
  for (const a of activities) {
    if (!a || !a.date) continue;
    const date = String(a.date).slice(0, 10);
    if (date < minIso || date > String(today).slice(0, 10)) continue;
    const wk = isoWeekKey(date);
    if (!wk || wk === thisWeek) continue; // drop the partial in-progress week
    const mins = typeof a.durationMin === "number" && Number.isFinite(a.durationMin) && a.durationMin > 0 ? a.durationMin : 0;
    minutesByWeek.set(wk, (minutesByWeek.get(wk) ?? 0) + mins);
  }
  // Keep only weeks with actual training volume; need at least one complete week to estimate from.
  const weekHours = [...minutesByWeek.values()].map((m) => m / 60).filter((h) => h > 0).sort((a, b) => a - b);
  if (!weekHours.length) return null;

  const mid = Math.floor(weekHours.length / 2);
  const median = weekHours.length % 2 ? weekHours[mid] : (weekHours[mid - 1] + weekHours[mid]) / 2;
  const lo = Math.max(0, Math.floor(median));
  const hi = lo + 1;
  return { band: `${lo}-${hi}`, weeks: weekHours.length };
}

/** Units/timezone/location pulled from `config` (getUser doesn't hold these). Pure. */
export function configToIntake(config: Config): Partial<ProfileIntake> {
  const out: Partial<ProfileIntake> = {};
  // COACH_UNITS is free text like "metric, UK" / "imperial, US"; map to the metric|imperial enum.
  const u = (config.athlete.units ?? "").toLowerCase();
  if (/imperial/.test(u)) out.units = "imperial";
  else if (/metric/.test(u)) out.units = "metric";
  const tz = config.athlete.timezone?.trim();
  if (tz) out.timezone = tz;
  return out;
}

/** Where a given pre-filled field came from — for the transparent "here's what we pulled" summary. */
export interface BootstrapSummary {
  /** Fields sourced from AI Endurance getUser. */
  fromAie: string[];
  /** Number of upcoming races pulled from the AIE goal calendar. */
  raceCount: number;
  /** Fields sourced from the local .env/config. */
  fromConfig: string[];
  /** The weekly-hours MODEL estimate, when one could be made (else null → asked). */
  weeklyEstimate: { band: string; weeks: number } | null;
  /** API-derived age (from getUser) shown as a sanity hint next to the DOB prompt; null if absent. */
  ageHint: number | null;
}

export interface PrefilledIntake {
  /** The pre-filled intake — gaps (DOB) left undefined for the wizard to ask. */
  intake: ProfileIntake;
  /** All upcoming races (the intake's single `race` is the first; the rest are applied separately). */
  races: BootstrapRace[];
  summary: BootstrapSummary;
}

/**
 * Assemble a fully pre-filled `ProfileIntake` from (state, config, today) plus the live goals.
 * Pure — the caller (setup.ts) passes in `liveGoals(state)` so this module never touches the raw
 * payload shape directly. DOB is deliberately left undefined (always asked).
 */
export function buildPrefilledIntake(
  state: AthleteState,
  goals: Goal[],
  config: Config,
  today: string,
): PrefilledIntake {
  const ath = athleteToIntake(state);
  const cfg = configToIntake(config);
  const races = goalsToRaces(goals, today);
  const weekly = estimateWeeklyHours(state.actualActivities.value, today);

  const fromAie: string[] = [];
  if (ath.name) fromAie.push("name");
  if (ath.sex) fromAie.push("sex");

  const fromConfig: string[] = [];
  if (cfg.units) fromConfig.push("units");
  if (cfg.timezone) fromConfig.push("timezone");

  const intake: ProfileIntake = {
    ...ath,
    ...cfg,
    // DOB intentionally omitted — always asked.
    weekly_hours: weekly ? weekly.band : undefined,
    race: races[0]
      ? {
          name: races[0].name ?? undefined,
          date: races[0].date ?? undefined,
          priority: races[0].priority ?? undefined,
          distance: races[0].distance ?? undefined,
          target_time: races[0].target_time ?? undefined,
        }
      : undefined,
    // Carry the remaining upcoming races so they're written too (not prompted individually).
    extraRaces: races.slice(1).map((r) => ({
      name: r.name ?? undefined,
      date: r.date ?? undefined,
      priority: r.priority ?? undefined,
      distance: r.distance ?? undefined,
      target_time: r.target_time ?? undefined,
    })),
  };

  return {
    intake,
    races,
    summary: {
      fromAie,
      raceCount: races.length,
      fromConfig,
      weeklyEstimate: weekly,
      ageHint: state.athleteProfile.value?.age ?? null,
    },
  };
}
