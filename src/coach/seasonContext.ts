import type { AthleteState } from "../state/types.js";
import { config } from "../config.js";
import { renderProfileContext } from "../profile/context.js";

/**
 * Live coaching context, derived from AI Endurance — NOT hard-coded.
 *
 * The athlete's races, season structure and profile used to be frozen into the system prompt and the
 * per-flow prompts (Birmingham/Loch Ness/Alderford, "tri build to July"), so changing goals in AI
 * Endurance never reached the coaching. Everything here is computed from `getRaceGoalEvent` +
 * `getUser` at request time instead, so the coach follows the platform. Pure functions take goals +
 * `today` so they're unit-testable on fixtures; the `state` wrappers read the live payloads.
 */

export interface Goal {
  event_name?: string;
  event_date?: string;
  event_type?: string;
  priority?: unknown;
  target_completion_time_in_seconds?: number;
}

export type RaceKind = "tri" | "run" | "swim" | "bike" | "other";

export function liveGoals(state: AthleteState): Goal[] {
  const g = (state.raw?.getRaceGoalEvent as { goals?: Goal[] } | undefined)?.goals;
  return Array.isArray(g) ? g : [];
}

export function daysBetween(fromIso: string, toIso: string): number {
  const a = new Date(`${String(fromIso).slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${String(toIso).slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Priority rank, lower = more important. A/1 → 0, B/2 → 1, … unknown → 9. */
export function priorityRank(p: unknown): number {
  if (p == null) return 9;
  const s = String(p).trim().toUpperCase();
  if (/^[A-Z]$/.test(s)) return s.charCodeAt(0) - 65;
  const n = Number(s);
  return Number.isFinite(n) ? n - 1 : 9;
}

export const isARace = (g: Goal): boolean => priorityRank(g.priority) === 0;

/** Classify a goal from its type + name keywords (AIE event_type shapes vary). */
export function classifyRace(g: Goal): RaceKind {
  const t = `${g.event_type ?? ""} ${g.event_name ?? ""}`.toLowerCase();
  if (/tri\b|triathlon|sprint|olympic|standard|70\.?3|140\.?6|iron|aquabike|duathlon|brick/.test(t)) return "tri";
  if (/marathon|ultra|parkrun|trail|\brun\b|\d+\s?k\b|\d+\s?km\b|10k|5k|half/.test(t)) return "run";
  if (/swim|open.?water|\bow\b|aquathlon/.test(t)) return "swim";
  if (/bike|cycl|gran\s?fondo|sportive|time.?trial|\btt\b/.test(t)) return "bike";
  return "other";
}

const name = (g: Goal): string => g.event_name ?? "your race";

function taperFor(kind: RaceKind, g: Goal): string {
  if (kind === "run") return /marathon|ultra/.test(`${g.event_type ?? ""} ${g.event_name ?? ""}`.toLowerCase())
    ? `short marathon taper into ${name(g)}`
    : `brief freshen into ${name(g)}`;
  if (kind === "tri") return `~2-week taper into ${name(g)} (cut volume ~40–60%, hold intensity & frequency)`;
  return `freshen ~1 week into ${name(g)}`;
}

/** Future races, soonest first. */
function futureGoals(goals: Goal[], today: string): Goal[] {
  return goals
    .filter((g) => g.event_date && daysBetween(today, g.event_date) >= 0)
    .sort((a, b) => daysBetween(today, a.event_date!) - daysBetween(today, b.event_date!));
}

/** One line per upcoming race with countdown, kind and target — for prompt context. */
export function raceCalendarLines(goals: Goal[], today: string): string[] {
  return futureGoals(goals, today).map((g) => {
    const dt = daysBetween(today, g.event_date!);
    const kind = classifyRace(g);
    const tgt = g.target_completion_time_in_seconds ? `, target ${Math.round(g.target_completion_time_in_seconds / 60)}min` : "";
    return `- ${name(g)} in ${dt}d (${String(g.event_date).slice(0, 10)}${g.priority ? `, priority ${g.priority}` : ""}${kind !== "other" ? `, ${kind}` : ""}${tgt})`;
  });
}

/**
 * The periodisation calls, DERIVED from the live calendar (replaces the frozen "two calls you must
 * make"): per-A-race taper, don't-stack-peaks, capped-tempo for a race close before a bigger one, and
 * the run-off-a-tri-base injury window. Returns [] when there are no future races.
 */
export function deriveSeasonShape(goals: Goal[], today: string): string[] {
  const fut = futureGoals(goals, today);
  if (!fut.length) return [];
  const calls: string[] = [];

  for (const a of fut.filter(isARace)) calls.push(`Taper: ${taperFor(classifyRace(a), a)}.`);

  const aRaces = fut.filter(isARace);
  for (let i = 0; i < aRaces.length; i++)
    for (let j = i + 1; j < aRaces.length; j++) {
      const gap = daysBetween(aRaces[i].event_date!, aRaces[j].event_date!);
      if (gap > 0 && gap <= 21)
        calls.push(`${name(aRaces[i])} and ${name(aRaces[j])} are both A-races only ${gap}d apart — don't build two stacked peaks; pick one to peak for and carry fitness into the other.`);
    }

  for (const e of fut)
    for (const l of fut) {
      if (e === l) continue;
      const gap = daysBetween(e.event_date!, l.event_date!);
      if (gap > 0 && gap <= 21 && priorityRank(l.priority) < priorityRank(e.priority))
        calls.push(`${name(e)} sits ${gap}d before your higher-priority ${name(l)} — treat it as a hard-capped tempo, not a race, so it doesn't disrupt ${name(l)}'s taper/prep. Surface this as the explicit trade-off.`);
    }

  // Anchor the run-off-a-tri-base injury window to the marathon/ultra it's really about (the compressed
  // long-run ramp), not merely the FIRST future run goal — which might be an earlier, shorter race.
  const runGoals = fut.filter((g) => classifyRace(g) === "run");
  const run =
    runGoals.find((g) => /marathon|ultra/.test(`${g.event_type ?? ""} ${g.event_name ?? ""}`.toLowerCase())) ??
    runGoals[0];
  const runIdx = run ? fut.indexOf(run) : -1;
  if (runIdx >= 0 && fut.slice(0, runIdx).some((g) => classifyRace(g) === "tri")) {
    calls.push(`${name(run)} is a run goal built off a triathlon base — an injury window. Swim/bike volume spares the legs, so run-specific orthopedic load has been low; cap weekly run-volume jumps and watch getRecoveryModel.orthopedic.run early.`);
    calls.push(`Between the last triathlon and ${name(run)}, maintain (don't build) swim/bike — one build, not two stacked peaks.`);
  }
  return calls;
}

// --- state wrappers ---------------------------------------------------------

/** Identical legacy format kept for planAdjust + its test (no kind/target suffix). */
export function raceContext(state: AthleteState): string {
  const today = state.date;
  const rows = futureGoals(liveGoals(state), today).map(
    (g) => `- ${name(g)} in ${daysBetween(today, g.event_date!)}d (${String(g.event_date).slice(0, 10)}${g.priority ? `, priority ${g.priority}` : ""})`,
  );
  return rows.length ? rows.join("\n") : "(no upcoming races)";
}

/** Athlete profile from getUser (degrades to whatever the platform exposes) + configured kit. */
export function athleteContext(state: AthleteState): string {
  const p = state.athleteProfile.value;
  const t = state.thresholds.value;
  const bits: string[] = [];
  if (p?.name) bits.push(p.name);
  if (p?.age != null) bits.push(`${p.age}y`);
  if (p?.sex) bits.push(p.sex);
  const profile = bits.length ? `Athlete: ${bits.join(", ")} [ai-endurance getUser].` : "";
  const thr = t
    ? `Thresholds [ai-endurance]: ${[
        t.bikeFtpW != null ? `bike FTP ${t.bikeFtpW}W${t.bikeFtpWkg != null ? ` (${t.bikeFtpWkg} W/kg)` : ""}` : "",
        t.runThresholdPaceSecPerKm != null ? `run threshold pace set` : "",
        t.swimCssSecPer100 != null ? `swim CSS set` : "",
      ]
        .filter(Boolean)
        .join(", ")}.`
    : "";
  const kit = config.athlete.equipment ? `Kit: ${config.athlete.equipment}. Units: ${config.athlete.units}.` : "";
  // Stable profile context (medical/biomechanics/availability/fuelling/race targets) from
  // profile.local.yaml, when attached — no live numbers, those are elsewhere in the prompt.
  const profileBlock = state.profile ? renderProfileContext(state.profile, state.date) : "";
  return [profile, thr, kit, profileBlock].filter(Boolean).join("\n");
}

/**
 * The full LIVE block injected into every coaching flow's user prompt (NOT the cached system prompt,
 * since races are volatile). Centralised so weekly / race / deep-dive / session / ask all agree.
 */
export function liveCoachingContext(state: AthleteState): string {
  const today = state.date;
  const goals = liveGoals(state);
  const cal = raceCalendarLines(goals, today);
  const shape = deriveSeasonShape(goals, today);
  const profile = athleteContext(state);
  return [
    profile,
    "",
    "RACE CALENDAR [live from AI Endurance goals]:",
    cal.length ? cal.join("\n") : "- (no upcoming races set — suggest confirming goals in AI Endurance)",
    "",
    "SEASON SHAPE [derived from the calendar above — not assumed]:",
    shape.length ? shape.map((s) => `- ${s}`).join("\n") : "- (no future races to shape a season around yet)",
  ].join("\n");
}
