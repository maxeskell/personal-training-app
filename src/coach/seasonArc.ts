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
  peakYear?: YearStat; // biggest-volume year — the benchmark
  currentYear?: YearStat; // this season's volume so far
  trajectory?: YearStat[]; // full year-by-year arc (for the bar view)
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
    const arc = r.trajectory.map((y) => `${y.year}:${y.hours ?? 0}h`).join(" ");
    lines.push(`- Long arc (annual hours): ${arc}`);
    if (r.peakYear) lines.push(`- Peak year: ${r.peakYear.year} (${r.peakYear.hours}h). ${r.consistencyNote ?? ""}`.trim());
  }
  lines.push("- Structural levers:");
  for (const l of r.levers) lines.push(`    · ${l.name} [${l.status}]: ${l.note}`);
  lines.push(`- Risk flags: ${r.flags.length ? r.flags.join(" | ") : "none"}`);
  if (r.focus) lines.push(`- Deterministic focus: ${r.focus}`);
  return lines.join("\n");
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

  const trajectory = career?.trajectory ?? [];
  const peakYear = trajectory.reduce<YearStat | undefined>((best, y) => ((y.hours ?? 0) > (best?.hours ?? 0) ? y : best), undefined);
  const curYearNum = Number(today.slice(0, 4));
  const currentYear = trajectory.find((y) => y.year === curYearNum);

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
    peakYear,
    currentYear,
    trajectory: trajectory.length ? trajectory : undefined,
    consistencyNote,
    levers,
    focus,
    flags,
  };
}
