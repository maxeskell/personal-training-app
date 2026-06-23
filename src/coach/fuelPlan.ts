import type { PlannedSession } from "../state/types.js";
import {
  type FuelProduct,
  carbCandidates,
  chooseCarbCombo,
  electrolyteProducts,
  recoveryProducts,
  nitrateProducts,
  caffeineSources,
} from "./fuelInventory.js";

/**
 * Deterministic per-session fuelling plan — NO LLM (dashboard-card discipline: estimated, cheap, render-time).
 *
 * The governing rule (the athlete's own): only surface what's actually needed. A short, easy session
 * returns `needed:false` with "water's fine" — no pre/during/after sections invented for the sake of it.
 * A section appears ONLY when a threshold is crossed:
 *   - DURING carbs: long enough OR hard enough to deplete glycogen / need on-bike (≥ ~75 min, or quality).
 *   - DURING fluid/sodium: scales with duration and heat.
 *   - PRE: a key/long/hard session that benefits from topping up (and nitrate/caffeine timing when owned).
 *   - AFTER: a glycogen-depleting or hard session (protein + carbs in the window).
 *
 * Everything is labelled a MODEL with its assumptions. Carb-per-hour targets follow mainstream sports-
 * nutrition guidance and are capped by the athlete's LEARNED tolerance ceiling (fuelReview.ts feeds this
 * back over time). Honest about gaps: with no dedicated carb product the plan still gives the g/h target
 * and says real food covers it.
 */

export interface FuelPrefs {
  /** Learned per-hour carb tolerance cap (g/h) — the gut-trained ceiling; the plan never exceeds it. */
  carbCeilingGPerHour?: number;
  /** The athlete's OWN stated carb/hr target for endurance/long efforts. n=1 data outranks the generic
   *  ranges: when the athlete has trained to (and prefers) a number, the plan uses it, not the textbook. */
  carbTargetGPerHour?: number;
  /** Local hour (0–23) after which caffeine is avoided (sleep) — steers to caffeine-free electrolytes. */
  caffeineCutoffHour?: number;
  /** Free-text the athlete/learning-loop wants echoed (e.g. "gels sit badly running — prefer drink"). */
  notes?: string;
}

export interface FuelPlanInput {
  date?: string;
  sport?: string;
  durationMin?: number;
  /** Session title/type — used to infer intensity (interval/tempo/threshold/race vs easy/recovery). */
  title?: string;
  /** A key / A-priority / race-rehearsal session — raises pre + during + after attention. */
  isKey?: boolean;
  /** Bodyweight (kg) for per-kg pre-load + protein math; null degrades to per-hour-only guidance. */
  weightKg?: number | null;
  /** Forecast high (°C) for the session day — drives heat fluid/sodium bumps. Optional. */
  tempC?: number | null;
  /** Local clock hour the session starts (0–23), if known — gates caffeine vs the cutoff. */
  startHour?: number | null;
  inventory: FuelProduct[];
  prefs?: FuelPrefs;
}

export type Intensity = "easy" | "endurance" | "hard";

export interface FuelSection {
  label: "Pre" | "During" | "After";
  lines: string[];
}

export interface FuelPlan {
  date?: string;
  sport: string;
  durationMin?: number;
  intensity: Intensity;
  needed: boolean;
  pre: FuelSection | null;
  during: FuelSection | null;
  after: FuelSection | null;
  /** One-line headline — the whole card for a "nothing needed" session. */
  summary: string;
  /** MODEL assumptions, surfaced so the estimate is honest. */
  assumptions: string[];
}

const HARD = /(interval|vo2|threshold|tempo|race|hard|sharpen|crit|hill repeat|fartlek|brick|sprint|time.?trial|\btt\b|max)/i;
const EASY = /(easy|recovery|shakeout|z1|z2|zone 1|zone 2|aerobic base|spin|easy run|easy ride|technique|drills|mobility)/i;

/** Infer intensity from the session title/type. Defaults to "endurance" when nothing matches. */
export function inferIntensity(title: string | undefined, sport: string | undefined): Intensity {
  const t = `${title ?? ""}`;
  if (HARD.test(t)) return "hard";
  if (EASY.test(t)) return "easy";
  // Long sessions without a quality keyword read as endurance; short untyped sessions read as easy.
  return "endurance";
}

/**
 * Target carbohydrate g/h for the session. The generic thresholds below decide WHETHER a session needs
 * carbs at all (mainstream gut-trained ranges); but if the athlete has stated their OWN carb/hr target,
 * that number wins for HOW MUCH (n=1 data outranks the textbook) — capped by the learned ceiling.
 *   < 75 min, not hard → 0 (water's fine)
 *   75–150 min easy/endurance → ~45 g/h ; hard → ~60 g/h
 *   > 150 min or a key/race effort → ~75 g/h (endurance)
 * With an athlete target set (e.g. 80 g/h), any fuelled session uses it instead of the generic figure.
 */
export function carbTargetGPerHour(
  durationMin: number,
  intensity: Intensity,
  isKey: boolean,
  ceiling?: number,
  athleteTarget?: number,
): number {
  let target = 0;
  if (durationMin >= 150 || (isKey && durationMin >= 90)) target = 75;
  else if (durationMin >= 75) target = intensity === "hard" ? 60 : 45;
  else if (intensity === "hard" && durationMin >= 60) target = 30; // long-ish hard session still benefits
  else target = 0;
  // The athlete's own stated target replaces the generic figure whenever carbs are actually needed — it's
  // their gut-trained number (and, on appetite-suppressing meds, under-fuelling is the riskier error).
  if (target > 0 && athleteTarget != null && athleteTarget > 0) target = athleteTarget;
  if (ceiling != null && ceiling > 0) target = Math.min(target, ceiling);
  return target;
}

/** Fluid ml/h — base ~500, +250 in real heat. Coarse by design (sweat rate is individual). */
function fluidMlPerHour(tempC: number | null | undefined): number {
  if (tempC != null && tempC >= 24) return 750;
  if (tempC != null && tempC >= 18) return 600;
  return 500;
}

/** Product label with any serving-size parenthetical ("(120 g)", "(500 ml)") stripped, so a bar's WEIGHT
 *  is never shown next to — and confused with — a carbohydrate figure. */
function cleanProductName(p: FuelProduct): string {
  const label = p.brand ? `${p.brand} ${p.name}` : p.name;
  return label.replace(/\s*\(\s*\d+(?:\.\d+)?\s*(?:g|kg|ml|oz)\b[^)]*\)\s*$/i, "").trim();
}

/** A during-carb pick as "2× OTE Energy Gel (40 g carb)" — the carb CONTRIBUTION (count × per-serving), so
 *  the picks visibly sum to the stated total. The serving weight is dropped (it isn't a carb figure). */
function fmtCarbProduct(p: FuelProduct, count: number): string {
  const n = count > 1 ? `${count}× ` : "";
  const carbs = p.carbsG != null ? Math.round(p.carbsG * count) : undefined;
  return `${n}${cleanProductName(p)}${carbs != null ? ` (${carbs} g carb)` : ""}`;
}

function isLateForCaffeine(startHour: number | null | undefined, cutoff: number | undefined): boolean {
  if (startHour == null || cutoff == null) return false;
  return startHour >= cutoff;
}

/**
 * Build the plan for one session. Pure. Returns `needed:false` (with a "water's fine" summary) when no
 * section clears its threshold — that quiet path is the point of the feature.
 */
export function planFuel(input: FuelPlanInput): FuelPlan {
  const sport = input.sport ?? "Session";
  const dur = input.durationMin ?? 0;
  const intensity = inferIntensity(input.title, input.sport);
  const isKey = !!input.isKey;
  const inv = input.inventory;
  const ceiling = input.prefs?.carbCeilingGPerHour;
  const hours = dur / 60;
  const hot = input.tempC != null && input.tempC >= 24;
  const warm = input.tempC != null && input.tempC >= 18;
  const lateCaffeine = isLateForCaffeine(input.startHour, input.prefs?.caffeineCutoffHour);

  const assumptions: string[] = [];
  const athleteCarbTarget = input.prefs?.carbTargetGPerHour;
  const carbTarget = carbTargetGPerHour(dur, intensity, isKey, ceiling, athleteCarbTarget);

  // ---- DURING -------------------------------------------------------------
  let during: FuelSection | null = null;
  const duringLines: string[] = [];
  if (carbTarget > 0) {
    // Grouped, timeline-style: a steady feed CADENCE, not a pile of products. Pick a per-feed amount and
    // the combo that hits it — small amounts naturally land on gels/liquid, which is easier on the gut.
    const startMin = intensity === "hard" && dur < 90 ? 0 : 20; // let the pre-fuel settle on an endurance day
    const intervalMin = 30;
    const perFeed = Math.max(1, Math.round((carbTarget * intervalMin) / 60));
    const feed = chooseCarbCombo(perFeed, carbCandidates(inv), { avoidCaffeine: lateCaffeine });
    if (feed.items.length) {
      const each = feed.items.map((e) => fmtCarbProduct(e.product, e.count)).join(" + ");
      duringLines.push(`From H+${startMin}: ${each} every ~${intervalMin} min — ≈ ${carbTarget} g carb/hr.`);
    } else {
      duringLines.push(
        `From H+${startMin}: ~${perFeed} g carb every ~${intervalMin} min (≈ ${carbTarget} g carb/hr) — no dedicated carb fuel logged; a flapjack/banana/real food covers it, ideally a drink-mix or gels.`,
      );
    }
  }
  // Fluid + sodium: meaningful past ~60 min, or sooner in heat.
  if (dur >= 60 || (warm && dur >= 45)) {
    const ml = fluidMlPerHour(input.tempC);
    const tabs = electrolyteProducts(inv);
    const tab = lateCaffeine ? tabs.find((t) => (t.caffeineMg ?? 0) === 0) ?? tabs[0] : tabs[0];
    const tabBit = tab
      ? ` Add electrolytes — ${tab.brand ? `${tab.brand} ${tab.name}` : tab.name}${lateCaffeine && (tab.caffeineMg ?? 0) === 0 ? " (caffeine-free for an evening session)" : ""}${hot ? ", a tab per bottle in this heat" : ""}.`
      : hot
        ? " Add electrolytes (you've none logged) — a salt/electrolyte source matters in this heat."
        : "";
    duringLines.push(`Drink ~${ml} ml/hr${hot ? " (hot day — toward the upper end)" : ""}.${tabBit}`);
  }
  if (duringLines.length) during = { label: "During", lines: duringLines };

  // ---- PRE ----------------------------------------------------------------
  let pre: FuelSection | null = null;
  const preLines: string[] = [];
  const wantsPre = isKey || (intensity === "endurance" && dur >= 90) || (intensity === "hard" && dur >= 75);
  if (wantsPre) {
    const bars = carbCandidates(inv).filter((p) => p.category === "bar" || p.category === "real_food");
    const topUp = bars[0];
    // Chronological (earliest first): nitrate ~2–3 h out, carb meal ~2 h out, caffeine ~45 min out.
    if (isKey || dur >= 120) {
      const beet = nitrateProducts(inv)[0];
      if (beet) preLines.push(`H-150: ${cleanProductName(beet)} (nitrate — best evidence for sustained endurance).`);
    }
    const perKg = input.weightKg ? ` (~${Math.round(input.weightKg)}–${Math.round(input.weightKg * 2)} g, ≈1–2 g/kg)` : "";
    preLines.push(`H-120: carb meal${perKg}${topUp ? ` — e.g. ${cleanProductName(topUp)}` : ""}.`);
    const caf = caffeineSources(inv)[0];
    if ((intensity === "hard" || isKey) && caf) {
      if (lateCaffeine) preLines.push(`Skip caffeine this late (after your ${input.prefs?.caffeineCutoffHour}:00 cut-off) so it doesn't cost you sleep.`);
      else preLines.push(`H-45: ${cleanProductName(caf)} (caffeine for a quality session).`);
    }
  }
  if (preLines.length) pre = { label: "Pre", lines: preLines };

  // ---- AFTER --------------------------------------------------------------
  let after: FuelSection | null = null;
  const afterLines: string[] = [];
  const wantsAfter = isKey || dur >= 90 || (intensity === "hard" && dur >= 45);
  if (wantsAfter) {
    const rec = recoveryProducts(inv);
    const protein = rec.find((p) => (p.proteinG ?? 0) >= 15) ?? rec[0];
    const proteinTarget = input.weightKg ? `~${Math.round(input.weightKg * 0.3)} g protein` : "~20–30 g protein";
    const carbHeavy = dur >= 120 || carbTarget >= 60;
    if (protein) {
      const carbNote = carbHeavy
        ? ` Add carbs alongside it (it's protein-led) — a flapjack or the chocolate milk — after a depleting session.`
        : "";
      afterLines.push(`Recovery within 30–60 min: ${protein.brand ? `${protein.brand} ${protein.name}` : protein.name} (${proteinTarget}).${carbNote}`);
    } else {
      afterLines.push(`Recovery within 30–60 min: ${proteinTarget} + carbs (you've no recovery product logged — a protein shake or chocolate milk works).`);
    }
  }
  if (afterLines.length) after = { label: "After", lines: afterLines };

  const needed = !!(pre || during || after);

  // Assumptions (honest model). Only the ones that bear on this plan.
  assumptions.push(`${intensity} ${sport.toLowerCase()}${dur ? `, ${Math.round(dur)} min` : ""}`);
  if (carbTarget > 0 && athleteCarbTarget != null && athleteCarbTarget > 0) {
    assumptions.push(
      `carb/hr from your stated ${athleteCarbTarget} g/h target` +
        (ceiling != null && athleteCarbTarget > ceiling ? `, capped at your ${ceiling} g/h ceiling` : ""),
    );
  } else if (carbTarget > 0 && ceiling != null) {
    assumptions.push(`carb/hr capped at your learned ${ceiling} g/h ceiling`);
  }
  if (input.weightKg) assumptions.push(`per-kg amounts use ${input.weightKg} kg`);
  if (input.tempC != null) assumptions.push(`forecast ~${Math.round(input.tempC)}°C`);
  assumptions.push("MODEL estimate — gut-train any new carb rate gradually");

  const summary = needed
    ? `${cap(intensity)} ${sport.toLowerCase()}${dur ? ` · ${Math.round(dur)} min` : ""} — ${[pre ? "pre" : "", during ? "during" : "", after ? "after" : ""].filter(Boolean).join(" + ")} below.`
    : `${cap(intensity)} ${sport.toLowerCase()}${dur ? ` · ${Math.round(dur)} min` : ""} — nothing needed, water's fine.`;

  return { date: input.date, sport, durationMin: input.durationMin, intensity, needed, pre, during, after, summary, assumptions };
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface WeekFuelContext {
  weightKg?: number | null;
  inventory: FuelProduct[];
  prefs?: FuelPrefs;
  /** Optional per-day forecast high (°C), keyed by YYYY-MM-DD. */
  tempByDate?: Record<string, number | undefined>;
  /** Race/A-priority dates (YYYY-MM-DD) → mark those sessions key. */
  keyDates?: Set<string>;
}

/** Build a fuel plan for each upcoming planned session (deterministic). */
export function buildWeekFuelPlans(sessions: PlannedSession[], ctx: WeekFuelContext): FuelPlan[] {
  return sessions
    .filter((s) => s.sport !== "Strength") // strength fuelling is a different (and quieter) story — skip for now
    .map((s) =>
      planFuel({
        date: s.date.slice(0, 10),
        sport: s.sport ?? "Session",
        durationMin: s.durationMin,
        title: s.title ?? s.type,
        isKey: ctx.keyDates?.has(s.date.slice(0, 10)) ?? false,
        weightKg: ctx.weightKg ?? null,
        tempC: ctx.tempByDate?.[s.date.slice(0, 10)] ?? null,
        inventory: ctx.inventory,
        prefs: ctx.prefs,
      }),
    );
}

function fuelWeekday(iso?: string): string {
  if (!iso) return "";
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()]} ${Number(iso.slice(8, 10))}`;
}

/** One plan as plain text (for the MCP `fuelling` tool / CLI). Mirrors the card's only-what-you-need shape. */
export function formatFuelPlanText(plan: FuelPlan): string {
  const head = `${fuelWeekday(plan.date)} ${plan.sport}${plan.durationMin ? ` · ${Math.round(plan.durationMin)} min` : ""}`;
  if (!plan.needed) return `${head} — nothing needed, water's fine.`;
  const sec = (s: FuelSection | null) => (s ? `  ${s.label}:\n${s.lines.map((l) => `   - ${l}`).join("\n")}` : "");
  const body = [sec(plan.pre), sec(plan.during), sec(plan.after)].filter(Boolean).join("\n");
  return `${head}\n${body}\n  (${plan.assumptions.join(" · ")})`;
}

/** The whole week as plain text — needed sessions in full, the quiet ones in a single line. */
export function formatWeekFuelText(plans: FuelPlan[]): string {
  if (!plans.length) return "No upcoming sessions in the plan to fuel for.";
  const needed = plans.filter((p) => p.needed);
  const quiet = plans.filter((p) => !p.needed);
  const out = needed.map(formatFuelPlanText);
  if (quiet.length) out.push(`Nothing needed (water's fine): ${quiet.map((p) => `${fuelWeekday(p.date)} ${p.sport.toLowerCase()}`).join(", ")}.`);
  out.push("\nEstimates (MODEL) — gut-train any new carb rate. This is fuelling guidance, not medical advice.");
  return out.join("\n\n");
}

/** Read learned fuelling preferences from the profile's fuelling block (defensive). */
export function loadFuelPrefs(fuelling: unknown): FuelPrefs {
  const o = fuelling && typeof fuelling === "object" && !Array.isArray(fuelling) ? (fuelling as Record<string, unknown>) : {};
  const prefs = o.preferences && typeof o.preferences === "object" ? (o.preferences as Record<string, unknown>) : {};
  const numOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v.trim()) : undefined);
  // The athlete's own carb/hr target is a map by session type (e.g. {olympic_and_long_rides: 80, sprint: 0});
  // take the highest stated number as the endurance/long-effort target the plan should hit.
  const targetMap = o.carb_target_g_per_hour && typeof o.carb_target_g_per_hour === "object" && !Array.isArray(o.carb_target_g_per_hour)
    ? (o.carb_target_g_per_hour as Record<string, unknown>)
    : {};
  const statedTargets = Object.values(targetMap).map(numOf).filter((n): n is number => n != null && n > 0);
  return {
    carbCeilingGPerHour: numOf(prefs.carb_ceiling_g_per_hour) ?? numOf(prefs.carb_ceiling),
    carbTargetGPerHour: statedTargets.length ? Math.max(...statedTargets) : undefined,
    caffeineCutoffHour: numOf(prefs.caffeine_cutoff_hour),
    notes: typeof prefs.notes === "string" ? prefs.notes : typeof o.notes === "string" ? o.notes : undefined,
  };
}
