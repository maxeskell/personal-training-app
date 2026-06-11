import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../config.js";
import { fetchForecast, type Forecast } from "./forecast.js";

/**
 * Forecast cache (data/weather.json, gitignored): the dashboard's GET / stays fast and offline-safe.
 * A fresh-enough cache is served as-is; a stale/missing one triggers a short-timeout fetch; and on
 * any failure the stale copy (or no card) beats an error. Sync (/refresh) force-refreshes it.
 */
const file = () => join(config.dataDir, "weather.json");

async function loadCached(): Promise<Forecast | undefined> {
  try {
    return JSON.parse(await readFile(file(), "utf8")) as Forecast;
  } catch {
    return undefined;
  }
}

async function save(fc: Forecast): Promise<void> {
  await mkdir(config.dataDir, { recursive: true });
  await writeFile(file(), JSON.stringify(fc));
}

/** Cached-or-fetched forecast. Best-effort: never throws — undefined just means "no weather card". */
export async function getForecast(maxAgeMs = 3 * 3_600_000): Promise<Forecast | undefined> {
  const cached = await loadCached();
  if (cached && Date.now() - new Date(cached.fetchedAt).getTime() < maxAgeMs) return cached;
  try {
    const fresh = await fetchForecast(config.weather.lat, config.weather.lon, config.weather.timeoutMs);
    await save(fresh);
    return fresh;
  } catch {
    return cached; // offline / API down — a stale forecast beats none
  }
}

/** Force-refresh during Sync. Best-effort — a weather failure must never break a refresh. */
export async function refreshForecast(): Promise<void> {
  try {
    await save(await fetchForecast(config.weather.lat, config.weather.lon, config.weather.timeoutMs));
  } catch {
    /* non-fatal */
  }
}
