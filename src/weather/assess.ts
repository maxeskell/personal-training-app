import type { AthleteState, PlannedSession } from "../state/types.js";
import { weatherLabel, type DayForecast, type Forecast, type HourForecast } from "./forecast.js";
import { DEFAULT_ROAD_OPTS, roadWetness, type RoadHour } from "./roadDry.js";

/**
 * Week-ahead weather rules (user ask): join the next 7 days of PLANNED sessions with the forecast.
 * Rides want dry roads + low wind; runs go in any weather; open-water swims go in any weather except
 * thunderstorms, ideally with the water above the configured floor. Deterministic and display-only —
 * any actual plan change stays behind the gated propose → confirm flow.
 */
export interface AssessOpts {
  swimMinWaterC: number;
  /** Latest manual water-temp reading for the open-water venue — there is no public live feed. */
  waterTempC?: number;
  rideMaxGustKmh: number;
  rideMaxRainProbPct: number;
  /** Local ISO "now" — today's hours already past are not offered as ride windows. Defaults to wall clock. */
  now?: string;
}

export type WeatherVerdict = "good" | "marginal" | "poor";

export interface SessionVerdict {
  date: string;
  sport: string;
  title?: string;
  verdict: WeatherVerdict;
  reason: string;
  window?: { from: string; to: string };
  suggestion?: string;
}

export interface DayOutlook {
  date: string;
  label: string;
  tempMinC: number;
  tempMaxC: number;
  precipSumMm: number;
  precipProbMaxPct: number | null;
  gustMaxKmh: number;
  /** "dry all day" / "wet until ~10:00" / "wet all day" / interval list. */
  roads: string;
  rideWindow?: { from: string; to: string };
}

export interface WeekWeather {
  fetchedAt: string;
  days: DayOutlook[];
  sessions: SessionVerdict[];
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "2026-06-11" → "Thu 11" (UTC-anchored so the label never slips a day). */
export function weekday(date: string): string {
  return `${WEEKDAY[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${Number(date.slice(8, 10))}`;
}

const hhmm = (iso: string) => iso.slice(11, 16);

function localIsoNow(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function plusHour(t: string): string {
  const d = new Date(`${t.slice(0, 16)}:00`);
  d.setHours(d.getHours() + 1);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

function roadsSummary(road: RoadHour[]): string {
  if (!road.length) return "—";
  const wets: Array<{ from: string; to: string | null }> = [];
  let start: string | null = null;
  for (const r of road) {
    if (r.wet && start == null) start = r.time;
    if (!r.wet && start != null) {
      wets.push({ from: start, to: r.time });
      start = null;
    }
  }
  if (start != null) wets.push({ from: start, to: null });
  if (!wets.length) return "dry all day";
  if (wets.length === 1) {
    const w = wets[0];
    if (w.from === road[0].time && w.to == null) return "wet all day";
    if (w.from === road[0].time) return `wet until ~${hhmm(w.to!)}`;
    if (w.to == null) return `wet from ${hhmm(w.from)}`;
    return `wet ${hhmm(w.from)}–${hhmm(w.to)}`;
  }
  return "wet " + wets.map((w) => `${hhmm(w.from)}–${w.to ? hhmm(w.to) : "…"}`).join(", ");
}

interface RideWindow {
  from: string;
  to: string;
  hours: number;
  maxGust: number;
}

/** Contiguous daylight runs of rideable hours (dry roads, gusts + rain risk under threshold), best first. */
function rideWindows(day: DayForecast, road: Map<string, RoadHour>, opts: AssessOpts, now: string): RideWindow[] {
  let from = day.sunrise.slice(0, 16);
  if (day.date === now.slice(0, 10) && now > from) from = now;
  const rideable = (h: HourForecast) =>
    !(road.get(h.time)?.wet ?? false) &&
    h.gustKmh <= opts.rideMaxGustKmh &&
    (h.precipProbPct == null || h.precipProbPct <= opts.rideMaxRainProbPct) &&
    h.precipMm < DEFAULT_ROAD_OPTS.rainWetMmPerH;
  const out: RideWindow[] = [];
  let run: HourForecast[] = [];
  const flush = () => {
    if (run.length) {
      out.push({
        from: run[0].time,
        to: plusHour(run[run.length - 1].time),
        hours: run.length,
        maxGust: Math.max(...run.map((r) => r.gustKmh)),
      });
      run = [];
    }
  };
  for (const h of day.hours) {
    if (h.time >= from && h.time < day.sunset && rideable(h)) run.push(h);
    else flush();
  }
  flush();
  return out.sort((a, b) => b.hours - a.hours || a.maxGust - b.maxGust);
}

const thundery = (d: DayForecast) => d.weatherCode >= 95 || d.hours.some((h) => h.weatherCode >= 95);

function rideVerdict(
  p: PlannedSession,
  day: DayForecast,
  days: DayForecast[],
  road: Map<string, RoadHour>,
  opts: AssessOpts,
  now: string,
): SessionVerdict {
  const needH = Math.max(1, Math.ceil((p.durationMin ?? 60) / 60));
  const best = rideWindows(day, road, opts, now).find((w) => w.hours >= needH);
  const base = { date: day.date, sport: "Ride", title: p.title };
  if (!best) {
    let alt: { date: string; w: RideWindow } | undefined;
    for (const d of days) {
      if (d.date === day.date) continue;
      const w = rideWindows(d, road, opts, now).find((x) => x.hours >= needH);
      if (w && (!alt || w.maxGust < alt.w.maxGust)) alt = { date: d.date, w };
    }
    return {
      ...base,
      verdict: "poor",
      reason: `no ${needH}h daylight window with dry roads, gusts ≤${opts.rideMaxGustKmh} km/h and rain risk ≤${opts.rideMaxRainProbPct}%`,
      suggestion: alt
        ? `best looks like ${weekday(alt.date)} ${hhmm(alt.w.from)}–${hhmm(alt.w.to)} (gusts ≤${Math.round(alt.w.maxGust)} km/h) — or take it indoors`
        : "no better day in the forecast — indoor ride",
    };
  }
  const breezy = best.maxGust > 0.8 * opts.rideMaxGustKmh;
  const driesFirst = day.hours.some((h) => road.get(h.time)?.wet);
  return {
    ...base,
    verdict: breezy || driesFirst ? "marginal" : "good",
    window: { from: best.from, to: best.to },
    reason:
      `${driesFirst ? "roads dry by then" : "dry roads"}, gusts ≤${Math.round(best.maxGust)} km/h ` +
      `${hhmm(best.from)}–${hhmm(best.to)}${breezy ? " (breezy — expect to work for it)" : ""}`,
  };
}

function runVerdict(p: PlannedSession, day: DayForecast): SessionVerdict {
  const notes: string[] = [];
  let verdict: WeatherVerdict = "good";
  if (thundery(day)) {
    verdict = "marginal";
    notes.push("thunderstorms about — time it between cells");
  }
  if (day.tempMaxC >= 27) notes.push(`hot (${Math.round(day.tempMaxC)}°C) — go early, take fluids`);
  if (day.tempMinC <= 1 && day.precipSumMm > 0) {
    verdict = "marginal";
    notes.push("possible ice underfoot early");
  }
  return { date: day.date, sport: "Run", title: p.title, verdict, reason: notes.join("; ") || "runnable in any weather" };
}

function swimVerdict(p: PlannedSession, day: DayForecast, opts: AssessOpts): SessionVerdict {
  const base = { date: day.date, sport: "Swim", title: p.title };
  if (thundery(day)) return { ...base, verdict: "poor", reason: "thunderstorms forecast — stay out of open water (pool instead)" };
  if (opts.waterTempC == null)
    return {
      ...base,
      verdict: "good",
      reason: `swimmable in any weather; water temp unknown — check the venue's latest reading (your floor: ${opts.swimMinWaterC}°C)`,
    };
  if (opts.waterTempC < opts.swimMinWaterC)
    return {
      ...base,
      verdict: "marginal",
      reason: `water ~${opts.waterTempC}°C is below your ${opts.swimMinWaterC}°C floor — wetsuit and shorten, or take it to the pool`,
    };
  return { ...base, verdict: "good", reason: `water ~${opts.waterTempC}°C, at/above your ${opts.swimMinWaterC}°C floor` };
}

export function assessWeek(planned: PlannedSession[], fc: Forecast, opts: AssessOpts): WeekWeather {
  const now = opts.now ?? localIsoNow();
  const today = now.slice(0, 10);
  // Dryness marches over ALL hours (incl. yesterday's lead-in) so earlier rain carries forward.
  const road = new Map(roadWetness(fc.days.flatMap((d) => d.hours)).map((r) => [r.time, r]));
  const shown = fc.days.filter((d) => d.date >= today);

  const days: DayOutlook[] = shown.map((d) => {
    const best = rideWindows(d, road, opts, now)[0];
    return {
      date: d.date,
      label: weatherLabel(d.weatherCode),
      tempMinC: d.tempMinC,
      tempMaxC: d.tempMaxC,
      precipSumMm: d.precipSumMm,
      precipProbMaxPct: d.precipProbMaxPct,
      gustMaxKmh: d.gustMaxKmh,
      roads: roadsSummary(d.hours.map((h) => road.get(h.time)!)),
      rideWindow: best ? { from: best.from, to: best.to } : undefined,
    };
  });

  const sessions: SessionVerdict[] = [];
  for (const p of planned) {
    const day = shown.find((d) => d.date === p.date.slice(0, 10));
    if (!day) continue;
    if (p.sport === "Ride") sessions.push(rideVerdict(p, day, shown, road, opts, now));
    else if (p.sport === "Run") sessions.push(runVerdict(p, day));
    else if (p.sport === "Swim") sessions.push(swimVerdict(p, day, opts));
  }
  sessions.sort((a, b) => a.date.localeCompare(b.date));
  return { fetchedAt: fc.fetchedAt, days, sessions };
}

/** Upcoming planned sessions from the freshest state that has any — the plan for [today, today+horizon). */
export function upcomingPlanned(window: AthleteState[], today: string, horizonDays = 7): PlannedSession[] {
  const end = new Date(`${today}T00:00:00Z`);
  end.setUTCDate(end.getUTCDate() + horizonDays);
  const endIso = end.toISOString().slice(0, 10);
  for (let i = window.length - 1; i >= 0; i--) {
    const all = window[i].plannedSessions.value;
    if (all?.length) {
      return all.filter((p) => {
        const d = p.date.slice(0, 10);
        return d >= today && d < endIso;
      });
    }
  }
  return [];
}
