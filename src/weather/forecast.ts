/**
 * Open-Meteo forecast client (free, no API key) + typed mapping for the week-ahead weather card.
 * Pulls hourly weather for the configured ride/run base — including yesterday, so the road-dryness
 * model knows about rain that fell before today. The mapping is pure (`mapOpenMeteo`) so tests run
 * on fixtures, never the network.
 */

import { config } from "../config.js";
import { retry, RetryableHttpError, isRetryableStatus, parseRetryAfterMs } from "../util/retry.js";

export interface HourForecast {
  /** Local ISO hour, e.g. "2026-06-11T14:00" (timezone=auto → venue-local). */
  time: string;
  tempC: number;
  humidityPct: number;
  precipMm: number;
  /** Probability % — null where the model doesn't provide one (e.g. past hours). */
  precipProbPct: number | null;
  windKmh: number;
  gustKmh: number;
  solarWm2: number;
  weatherCode: number;
}

export interface DayForecast {
  date: string;
  sunrise: string;
  sunset: string;
  weatherCode: number;
  tempMinC: number;
  tempMaxC: number;
  precipSumMm: number;
  precipProbMaxPct: number | null;
  gustMaxKmh: number;
  hours: HourForecast[];
}

export interface Forecast {
  fetchedAt: string;
  latitude: number;
  longitude: number;
  /** Yesterday + today + 6 more days; yesterday only feeds the dryness lead-in, it isn't displayed. */
  days: DayForecast[];
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function numOrNull(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapOpenMeteo(json: unknown, fetchedAt: string): Forecast {
  const j = json as {
    latitude?: number;
    longitude?: number;
    hourly?: Record<string, unknown[] | undefined>;
    daily?: Record<string, unknown[] | undefined>;
  };
  const h = j.hourly ?? {};
  const hours: HourForecast[] = ((h.time ?? []) as string[]).map((t, i) => ({
    time: String(t),
    tempC: num(h.temperature_2m?.[i]),
    humidityPct: num(h.relative_humidity_2m?.[i]),
    precipMm: num(h.precipitation?.[i]),
    precipProbPct: numOrNull(h.precipitation_probability?.[i]),
    windKmh: num(h.wind_speed_10m?.[i]),
    gustKmh: num(h.wind_gusts_10m?.[i]),
    solarWm2: num(h.shortwave_radiation?.[i]),
    weatherCode: num(h.weather_code?.[i]),
  }));
  const d = j.daily ?? {};
  const days: DayForecast[] = ((d.time ?? []) as string[]).map((date, i) => ({
    date: String(date),
    sunrise: String(d.sunrise?.[i] ?? `${date}T06:00`),
    sunset: String(d.sunset?.[i] ?? `${date}T20:00`),
    weatherCode: num(d.weather_code?.[i]),
    tempMinC: num(d.temperature_2m_min?.[i]),
    tempMaxC: num(d.temperature_2m_max?.[i]),
    precipSumMm: num(d.precipitation_sum?.[i]),
    precipProbMaxPct: numOrNull(d.precipitation_probability_max?.[i]),
    gustMaxKmh: num(d.wind_gusts_10m_max?.[i]),
    hours: hours.filter((x) => x.time.slice(0, 10) === String(date)),
  }));
  return { fetchedAt, latitude: num(j.latitude), longitude: num(j.longitude), days };
}

export async function fetchForecast(lat: number, lon: number, timeoutMs = 6000): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    hourly:
      "temperature_2m,relative_humidity_2m,precipitation,precipitation_probability,wind_speed_10m,wind_gusts_10m,shortwave_radiation,weather_code",
    daily:
      "sunrise,sunset,weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max",
    timezone: "auto",
    past_days: "1",
    forecast_days: "7",
  });
  // Best-effort GET → retry a transient 429/5xx (honouring Retry-After); the store layer still degrades
  // to a stale/undefined forecast if every attempt fails, so the card never crashes a flow.
  return retry(async () => {
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) {
      const msg = `open-meteo HTTP ${res.status}`;
      if (isRetryableStatus(res.status)) throw new RetryableHttpError(msg, res.status, parseRetryAfterMs(res.headers.get("retry-after")));
      throw new Error(msg);
    }
    return mapOpenMeteo(await res.json(), new Date().toISOString());
  }, { attempts: config.retry.attempts });
}

/** WMO weather code → glanceable label. */
export function weatherLabel(code: number): string {
  if (code === 0) return "☀️ clear";
  if (code <= 2) return "🌤 mostly clear";
  if (code === 3) return "☁️ overcast";
  if (code === 45 || code === 48) return "🌫 fog";
  if (code >= 51 && code <= 57) return "🌦 drizzle";
  if (code >= 61 && code <= 67) return "🌧 rain";
  if (code >= 71 && code <= 77) return "🌨 snow";
  if (code >= 80 && code <= 82) return "🌦 showers";
  if (code === 85 || code === 86) return "🌨 snow showers";
  if (code >= 95) return "⛈ thunderstorm";
  return "·";
}
