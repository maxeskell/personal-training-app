import { config } from "../config.js";

/**
 * "Today" as a YYYY-MM-DD string in the athlete's configured timezone (UK by default).
 *
 * Previously every caller used `new Date().toISOString().slice(0,10)`, i.e. the UTC date — which
 * mis-dates a late-night session/readiness window for a UK athlete on BST (UTC+1): between 00:00 and
 * 01:00 local, UTC is still the previous calendar day. Deriving the local date fixes that (DATA-3).
 */
export function todayIso(tz: string = config.athlete.timezone, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD; build from parts so the order is locale-proof.
  // `now` is injectable so the timezone/midnight edge (DATA-3) is deterministically testable.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function shiftIso(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
