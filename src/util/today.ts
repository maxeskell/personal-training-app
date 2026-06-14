import { config } from "../config.js";

/**
 * "Today" as a YYYY-MM-DD string in the athlete's configured timezone (UK by default).
 *
 * Previously every caller used `new Date().toISOString().slice(0,10)`, i.e. the UTC date — which
 * mis-dates a late-night session/readiness window for a UK athlete on BST (UTC+1): between 00:00 and
 * 01:00 local, UTC is still the previous calendar day. Deriving the local date fixes that (DATA-3).
 */
export function todayIso(tz: string = config.athlete.timezone): string {
  // en-CA formats as YYYY-MM-DD; build from parts so the order is locale-proof.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
