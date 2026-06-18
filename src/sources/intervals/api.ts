import { config } from "../../config.js";
import type { IntervalsRaw } from "./map.js";

/**
 * Thin intervals.icu REST client (Phase 3b). Read-only. Auth is HTTP Basic with username `API_KEY` and
 * the athlete's API key as the password (intervals.icu's scheme). Best-effort + bounded by a timeout;
 * a failure throws a clean error so the DataSource degrades to "keep last state", never a stack trace.
 *
 * NOTE: not exercised in CI (needs a real key + network). The endpoint paths/fields are intervals.icu's
 * documented shapes — verify on first live run.
 */

function authHeader(apiKey: string): string {
  return `Basic ${Buffer.from(`API_KEY:${apiKey}`).toString("base64")}`;
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

async function getJson<T>(path: string): Promise<T> {
  const { baseUrl, apiKey, athleteId, timeoutMs } = config.intervals;
  const url = `${baseUrl}/athlete/${encodeURIComponent(athleteId)}${path}`;
  const res = await fetch(url, {
    headers: { authorization: authHeader(apiKey), accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`intervals.icu ${res.status} for ${path.split("?")[0]} (check COACH_INTERVALS_API_KEY / ATHLETE_ID)`);
  return (await res.json()) as T;
}

/** Pull the analysis window: activities + wellness (trailing) and events (trailing + upcoming races). */
export async function fetchIntervals(today: Date): Promise<IntervalsRaw> {
  if (!config.intervals.apiKey || !config.intervals.athleteId) {
    throw new Error("intervals.icu source selected but COACH_INTERVALS_API_KEY / COACH_INTERVALS_ATHLETE_ID are not set.");
  }
  const oldest = new Date(today.getTime() - config.intervals.windowDays * 86_400_000);
  const future = new Date(today.getTime() + 365 * 86_400_000); // upcoming planned workouts + races
  const win = `oldest=${ymd(oldest)}&newest=${ymd(today)}`;
  const [activities, wellness, events] = await Promise.all([
    getJson<Record<string, unknown>[]>(`/activities?${win}`),
    getJson<Record<string, unknown>[]>(`/wellness?${win}`),
    getJson<Record<string, unknown>[]>(`/events?oldest=${ymd(oldest)}&newest=${ymd(future)}`),
  ]);
  return { activities, wellness, events };
}
