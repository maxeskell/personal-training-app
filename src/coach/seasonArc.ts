import type { Profile, SeasonPlan } from "../profile/schema.js";
import type { CareerHistory, YearStat } from "./careerHistory.js";

/**
 * Season Arc — the DETERMINISTIC multi-season strategic review behind the `/season` page (see
 * docs/specs/Season_Arc_Spec.md). Pure: it takes the athlete's plan (intent), live chronic-load (CTL now +
 * a trend series), the career trajectory (year-by-year volume) and the profile, and returns a structured
 * {@link SeasonArcReport}. Every section degrades independently when its input is absent (degrade-don't-crash),
 * and NOTHING here calls an LLM (deterministic views make no model call — the cost model). Targets are the
 * athlete's own (`season_plan`); CTL is labelled the platform's MODEL in the UI. No live numbers are invented.
 */

export interface CtlPoint {
  date: string;
  v: number;
}

export interface SeasonArcInput {
  today: string; // YYYY-MM-DD
  plan?: SeasonPlan;
  ctlNow?: number;
  /** CTL over a trailing window (e.g. StateStore.series → {date,v}); used only for the trend direction. */
  ctlSeries?: CtlPoint[];
  career?: CareerHistory | null;
  profile?: Profile;
  /** Live per-activity volume from the local archive (see archiveVolume.ts) — fills the years the
   *  career file's trajectory stops short of, and feeds the current-year projection. Optional. */
  archive?: ArchiveVolume;
}

/** One activity's contribution to annual volume — the minimal shape the long arc needs. */
export interface VolumeActivity {
  date: string; // YYYY-MM-DD
  hours: number;
  km?: number;
}
export interface ArchiveVolume {
  /** Garmin activities: elapsed time, ALL sports — the same basis as the TrainingPeaks years. Preferred. */
  garmin: VolumeActivity[];
  /** AI Endurance swim/bike/run moving time — the fallback for a year Garmin doesn't cover. */
  aie: VolumeActivity[];
}

/** The current year's finish-line estimate — a MODEL, labelled as such wherever it's shown. */
export interface YearProjection {
  year: number;
  ytdHours: number;
  throughDate: string; // the `today` the year-to-date figure runs to
  daysElapsed: number;
  daysInYear: number;
  /** MODEL: year-to-date ÷ days elapsed × days in the year ("if the rest of the year looks like the average so far"). */
  atYearPace: number;
  /** MODEL: year-to-date + the last `recentWindowDays`' daily rate × days remaining ("if it looks like the last 8 weeks").
   *  Only when the year came from activity-level archive data. */
  atRecentPace?: number;
  recentWindowDays: number;
}

export interface SeasonPhaseView {
  name?: string;
  focus?: string;
  ctlTargetText?: string;
  ctlTarget?: number;
  until?: string;
  daysLeft?: number;
}

export interface Lever {
  name: string;
  status: "ok" | "watch" | "gap" | "info";
  note: string;
}

export interface SeasonArcReport {
  hasPlan: boolean;
  horizonGoal?: string;
  targetDate?: string;
  daysToTarget?: number;
  activePhase?: SeasonPhaseView;
  ctlNow?: number;
  ctlTrend?: "rising" | "flat" | "falling";
  ctlTarget?: number;
  ctlGap?: number; // ctlNow − ctlTarget (negative = below target)
  ctlSeries?: CtlPoint[]; // the trailing CTL series, for the gap-to-target graph
  peakYear?: YearStat; // biggest-volume year — the benchmark
  currentYear?: YearStat; // this season's volume so far
  trajectory?: YearStat[]; // full year-by-year arc (for the bar view)
  /** Where the current year would land if training continues — a MODEL (two pace bases). */
  currentYearProjection?: YearProjection;
  consistencyNote?: string;
  levers: Lever[];
  focus?: string;
  flags: string[];
}

/**
 * Deterministic text digest of the report — every number the strategic narrative should cite, and the
 * no-LLM fallback for `npm run season`. Pure. Mirrors deepDive's `insightMetricsSummary` pattern.
 */
export function seasonReportText(r: SeasonArcReport): string {
  const lines: string[] = ["SEASON ARC (computed locally; cite these):"];
  if (r.horizonGoal) lines.push(`- Horizon: ${r.horizonGoal}${r.targetDate ? ` (${r.targetDate}, ${r.daysToTarget ?? "?"}d out)` : ""}`);
  else lines.push("- Horizon: no multi-season goal set (profile.season_plan)");
  if (r.activePhase) {
    const p = r.activePhase;
    lines.push(`- Active phase: ${p.name ?? "—"} — focus "${p.focus ?? "—"}"${p.ctlTargetText ? `, CTL target ${p.ctlTargetText}` : ""}${p.until ? `, until ${p.until} (${p.daysLeft ?? "?"}d)` : ""}`);
  }
  lines.push(`- Chronic load (MODEL): CTL now ${r.ctlNow != null ? Math.round(r.ctlNow) : "—"}, trend ${r.ctlTrend ?? "—"}, target ${r.ctlTarget ?? "—"}, gap ${r.ctlGap != null ? (r.ctlGap >= 0 ? `+${r.ctlGap}` : r.ctlGap) : "—"}`);
  if (r.trajectory?.length) {
    const arc = r.trajectory.map((y) => `${y.year}:${y.hours ?? 0}h${y.partial ? " (to date)" : ""}`).join(" ");
    lines.push(`- Long arc (annual hours): ${arc}`);
    if (r.peakYear) lines.push(`- Peak year: ${r.peakYear.year} (${r.peakYear.hours}h). ${r.consistencyNote ?? ""}`.trim());
    const p = r.currentYearProjection;
    if (p) {
      lines.push(
        `- This year (MODEL): ${p.ytdHours}h to ${p.throughDate} (day ${p.daysElapsed} of ${p.daysInYear}) → ~${p.atYearPace}h at this year's average pace` +
          (p.atRecentPace != null ? `, ~${p.atRecentPace}h at the last ${Math.round(p.recentWindowDays / 7)} weeks' pace` : ""),
      );
    }
    const live = r.trajectory.filter((y) => y.source);
    if (live.length) lines.push(`- Years from ${live[0].year} are summed live from the local archive (${live.map((y) => y.source).filter((s, i, a) => a.indexOf(s) === i).join(" / ")}); earlier years from the TrainingPeaks export.`);
  }
  lines.push("- Structural levers:");
  for (const l of r.levers) lines.push(`    · ${l.name} [${l.status}]: ${l.note}`);
  lines.push(`- Risk flags: ${r.flags.length ? r.flags.join(" | ") : "none"}`);
  if (r.focus) lines.push(`- Deterministic focus: ${r.focus}`);
  return lines.join("\n");
}

/** Same sanity cap as scripts/build-career-history.ts (1200 min): a corrupt multi-day file must not inflate a year. */
const MAX_ACTIVITY_HOURS = 20;
/** Trailing window for the "recent pace" projection basis. */
const RECENT_PACE_DAYS = 56;

function sumByYear(acts: VolumeActivity[]): Map<number, { hours: number; km: number }> {
  const out = new Map<number, { hours: number; km: number }>();
  for (const a of acts) {
    const year = Number(a.date.slice(0, 4));
    if (!Number.isFinite(year) || !(a.hours > 0) || a.hours >= MAX_ACTIVITY_HOURS) continue;
    const d = out.get(year) ?? { hours: 0, km: 0 };
    d.hours += a.hours;
    if (a.km != null && a.km > 0 && a.km < 2000) d.km += a.km;
    out.set(year, d);
  }
  return out;
}

/**
 * The career file's trajectory (TrainingPeaks-built, stops where that export stopped) + every LATER year
 * summed live from the archive. Only MISSING years are filled — a year the career file already has is left
 * as the record of record. Garmin first (all sports, elapsed), AI Endurance as the fallback; the year in
 * progress is marked `partial`. Pure; sorted by year.
 */
export function fillTrajectory(trajectory: YearStat[], archive: ArchiveVolume | undefined, today: string): YearStat[] {
  const curYear = Number(today.slice(0, 4));
  const out: YearStat[] = trajectory.map((y) => (y.year === curYear ? { ...y, partial: true } : { ...y }));
  const have = new Set(out.map((y) => y.year));
  const sources: Array<[NonNullable<YearStat["source"]>, VolumeActivity[]]> = [
    ["garmin", archive?.garmin ?? []],
    ["ai-endurance", archive?.aie ?? []],
  ];
  for (const [source, acts] of sources) {
    for (const [year, v] of sumByYear(acts)) {
      if (have.has(year) || year < 2000 || year > curYear) continue;
      have.add(year);
      out.push({ year, hours: Math.round(v.hours), km: Math.round(v.km), source, partial: year === curYear });
    }
  }
  return out.sort((a, b) => a.year - b.year);
}

/**
 * Where the year in progress lands if training continues — a MODEL on two bases: this year's average daily
 * pace, and (when activity-level data exists for the year's source) the last 8 weeks' pace. Undefined until
 * two weeks of the year have passed, and for a complete year. Pure.
 */
export function projectYear(cur: YearStat | undefined, archive: ArchiveVolume | undefined, today: string): YearProjection | undefined {
  if (!cur?.partial || !(cur.hours != null && cur.hours > 0)) return undefined;
  const year = cur.year;
  const t = Date.parse(`${today.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return undefined;
  const daysElapsed = Math.floor((t - Date.UTC(year, 0, 1)) / 86_400_000) + 1;
  const daysInYear = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
  if (daysElapsed < 14 || daysElapsed >= daysInYear) return undefined;
  const atYearPace = Math.round((cur.hours / daysElapsed) * daysInYear);
  let atRecentPace: number | undefined;
  const acts = cur.source === "garmin" ? archive?.garmin : cur.source === "ai-endurance" ? archive?.aie : undefined;
  if (acts?.length) {
    const from = new Date(t - RECENT_PACE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const recent = acts.filter((a) => a.date > from && a.date <= today && a.hours > 0 && a.hours < MAX_ACTIVITY_HOURS).reduce((s, a) => s + a.hours, 0);
    atRecentPace = Math.round(cur.hours + (recent / RECENT_PACE_DAYS) * (daysInYear - daysElapsed));
  }
  return { year, ytdHours: cur.hours, throughDate: today.slice(0, 10), daysElapsed, daysInYear, atYearPace, atRecentPace, recentWindowDays: RECENT_PACE_DAYS };
}

function daysBetween(from: string, to: string): number | undefined {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / 86_400_000);
}

/** First number in a target expression: "55" → 55, "55-60" → 55, "~55 by spring" → 55. */
export function parseTarget(text: string | null | undefined): number | undefined {
  if (typeof text !== "string") return undefined;
  const m = text.match(/\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

function num(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const m = v.match(/\d+(?:\.\d+)?/);
    if (m) return Number(m[0]);
  }
  return undefined;
}

/** Active phase = the first (by date) whose `until` is still in the future relative to `today`. */
export function pickActivePhase(plan: SeasonPlan | undefined, today: string): SeasonPhaseView | undefined {
  const phases = Array.isArray(plan?.phases) ? plan!.phases : [];
  if (!phases.length) return undefined;
  const withUntil = phases
    .map((p) => ({ p, until: typeof p?.until === "string" ? p.until.slice(0, 10) : undefined }))
    .sort((a, b) => (a.until ?? "9999").localeCompare(b.until ?? "9999"));
  const active = withUntil.find((x) => !x.until || x.until >= today) ?? withUntil[withUntil.length - 1];
  const p = active.p;
  return {
    name: typeof p?.name === "string" ? p.name : undefined,
    focus: typeof p?.focus === "string" ? p.focus : undefined,
    ctlTargetText: typeof p?.ctl_target === "string" ? p.ctl_target : undefined,
    ctlTarget: parseTarget(p?.ctl_target as string | undefined),
    until: active.until,
    daysLeft: active.until ? daysBetween(today, active.until) : undefined,
  };
}

/** Trend over the series: last value vs the value ~21+ days earlier (else the first). ±2 CTL = flat band. */
export function ctlTrend(series: CtlPoint[] | undefined): "rising" | "flat" | "falling" | undefined {
  const pts = (series ?? []).filter((p) => typeof p.v === "number" && Number.isFinite(p.v)).sort((a, b) => a.date.localeCompare(b.date));
  if (pts.length < 2) return undefined;
  const last = pts[pts.length - 1];
  const lastTime = Date.parse(`${last.date.slice(0, 10)}T00:00:00Z`);
  // baseline: the most recent point at least 21 days before `last`, else the earliest point.
  const baseline = [...pts].reverse().find((p) => lastTime - Date.parse(`${p.date.slice(0, 10)}T00:00:00Z`) >= 21 * 86_400_000) ?? pts[0];
  const delta = last.v - baseline.v;
  return delta > 2 ? "rising" : delta < -2 ? "falling" : "flat";
}

function buildLevers(input: SeasonArcInput): Lever[] {
  const { profile, career } = input;
  const levers: Lever[] = [];

  // Strength — lean mass / bone; acute on a GLP-1.
  const strength = num(profile?.health?.strength_sessions_per_week);
  const onGlp1 = !!profile?.health?.medication?.name;
  if (strength == null || strength <= 0) {
    levers.push({ name: "Strength", status: "gap", note: `${strength === 0 ? "0×/wk" : "not logged"} — aim 2–3×/wk${onGlp1 ? " (protects muscle/bone on a GLP-1)" : ""}` });
  } else if (strength >= 2) {
    levers.push({ name: "Strength", status: "ok", note: `${strength}×/wk — on target` });
  } else {
    levers.push({ name: "Strength", status: "watch", note: `${strength}×/wk — build toward 2–3${onGlp1 ? " (GLP-1: protect lean mass)" : ""}` });
  }

  // Swim — the named blind spot. Proxy: is CSS set in AIE? (read-only flag in the profile.)
  const cssRaw = (profile?.ai_endurance_todo as Record<string, unknown> | undefined)?.swim_css;
  const cssSet = typeof cssRaw === "string" && cssRaw.trim() !== "" && !/not[_ ]?set/i.test(cssRaw);
  levers.push(
    cssSet
      ? { name: "Swim", status: "ok", note: "CSS set — keep technique a standing project" }
      : { name: "Swim", status: "gap", note: "set your CSS — swim is the discipline furthest from your ceiling" },
  );

  // Bloods — age of the latest panel.
  const panels = Array.isArray(profile?.bloods?.panels) ? profile!.bloods!.panels! : [];
  const latest = panels
    .map((p) => (typeof (p as { date?: unknown }).date === "string" ? (p as { date: string }).date.slice(0, 10) : undefined))
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  if (!latest) {
    levers.push({ name: "Bloods", status: "gap", note: "no panel on record — book a performance panel" });
  } else {
    const age = daysBetween(latest, input.today);
    if (age != null && age > 365) levers.push({ name: "Bloods", status: "watch", note: `last panel ${Math.floor(age / 30)} mo ago — re-test` });
    else levers.push({ name: "Bloods", status: "ok", note: `panel from ${latest}` });
  }

  // Threshold band — standing strategic note (read-only; no live FTP stored).
  levers.push({ name: "Threshold", status: "info", note: "shift power toward the 20–60 min band — it decides the bike leg" });

  // Swim PB presence from career history (informational nudge if none recorded).
  const swimBests = career?.bests?.find((b) => /swim/i.test(b.sport));
  if (!swimBests) levers.push({ name: "Swim history", status: "info", note: "no swim PBs in your archive yet" });

  return levers;
}

export function buildSeasonArc(input: SeasonArcInput): SeasonArcReport {
  const { plan, today, ctlNow, career } = input;
  const hasPlan = !!(plan && (plan.horizon_goal || (Array.isArray(plan.phases) && plan.phases.length)));

  const activePhase = pickActivePhase(plan, today);
  const ctlTarget = activePhase?.ctlTarget;
  const trend = ctlTrend(input.ctlSeries);
  const ctlGap = ctlNow != null && ctlTarget != null ? Math.round((ctlNow - ctlTarget) * 10) / 10 : undefined;

  const trajectory = fillTrajectory(career?.trajectory ?? [], input.archive, today);
  const peakYear = trajectory.reduce<YearStat | undefined>((best, y) => ((y.hours ?? 0) > (best?.hours ?? 0) ? y : best), undefined);
  const curYearNum = Number(today.slice(0, 4));
  const currentYear = trajectory.find((y) => y.year === curYearNum);
  const currentYearProjection = projectYear(currentYear, input.archive, today);

  // Consistency: last COMPLETE year vs the all-time peak (the cliff signal).
  const complete = trajectory.filter((y) => y.year < curYearNum);
  const lastComplete = complete[complete.length - 1];
  let consistencyNote: string | undefined;
  let cliff = false;
  if (lastComplete && peakYear && (peakYear.hours ?? 0) > 0) {
    const ratio = (lastComplete.hours ?? 0) / (peakYear.hours ?? 1);
    consistencyNote = `${lastComplete.year}: ${lastComplete.hours}h vs peak ${peakYear.hours}h (${peakYear.year}) — ${Math.round(ratio * 100)}% of peak`;
    cliff = ratio < 0.6;
  }

  const levers = buildLevers(input);

  // Deterministic focus.
  let focus: string | undefined;
  if (activePhase?.focus) focus = activePhase.focus;
  else if (ctlGap != null && ctlGap < -5) focus = "Below CTL target — raise the floor: add one easy aerobic session/week and hold it.";
  else if (ctlGap != null && ctlGap >= -5) focus = "Around target — hold consistency and progress the block, don't spike intensity.";
  else if (ctlNow != null) focus = "Build chronic load patiently — raise the year's floor, not the week's ceiling.";

  // Flags (the multi-season risks worth surfacing).
  const flags: string[] = [];
  if (trend === "falling" && activePhase?.daysLeft != null && activePhase.daysLeft <= 56) flags.push("CTL is falling with a phase deadline approaching.");
  if (cliff) flags.push("Training volume is well below your peak years — consistency is your #1 multi-season risk.");
  for (const l of levers) {
    if (l.name === "Bloods" && (l.status === "gap" || l.status === "watch")) flags.push("Bloods are stale/absent — book a panel (you're managing body-comp blind otherwise).");
    if (l.name === "Strength" && l.status === "gap") flags.push("No strength logged — lean-mass/bone risk, sharpened on a GLP-1.");
    if (l.name === "Swim" && l.status === "gap") flags.push("Swim CSS not set — your biggest locked-up time.");
  }

  return {
    hasPlan,
    horizonGoal: typeof plan?.horizon_goal === "string" ? plan.horizon_goal : undefined,
    targetDate: typeof plan?.target_date === "string" ? plan.target_date.slice(0, 10) : undefined,
    daysToTarget: typeof plan?.target_date === "string" ? daysBetween(today, plan.target_date) : undefined,
    activePhase,
    ctlNow,
    ctlTrend: trend,
    ctlTarget,
    ctlGap,
    ctlSeries: input.ctlSeries,
    peakYear,
    currentYear,
    trajectory: trajectory.length ? trajectory : undefined,
    currentYearProjection,
    consistencyNote,
    levers,
    focus,
    flags,
  };
}
