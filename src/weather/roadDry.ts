import type { HourForecast } from "./forecast.js";

/**
 * Road-dryness MODEL (user ask: "when are the roads dry after rain?"). A water-film budget marched
 * hour by hour: rain adds film (runoff-capped — tarmac sheds heavy rain), and each rain-free hour
 * evaporates some of it as a function of temperature+humidity (vapour-pressure deficit), wind, and
 * sun. The constants are calibrated to lived reality (sunny+breezy ≈ dry in 1–2h; cool damp night ≈
 * wet until morning), not measured — treat the output as an estimate to plan around.
 */
export interface RoadOpts {
  /** Max film (mm) the model lets the surface hold — rain beyond this runs off, it doesn't pool forever. */
  maxFilmMm: number;
  /** An hour raining at/above this (mm/h) marks the road wet regardless of remaining film. */
  rainWetMmPerH: number;
  /** Residual film below this counts as dry (a trace dries on contact). */
  dryBelowMm: number;
  /** Fraction of solar energy that evaporates film (the rest heats air/tarmac). */
  solarEfficiency: number;
}

export const DEFAULT_ROAD_OPTS: RoadOpts = { maxFilmMm: 1, rainWetMmPerH: 0.1, dryBelowMm: 0.05, solarEfficiency: 0.4 };

/** Evaporation from a wet road surface, mm/h: aerodynamic (VPD × wind) + radiative (sun) terms. */
export function evapMmPerHour(
  h: Pick<HourForecast, "tempC" | "humidityPct" | "windKmh" | "solarWm2">,
  opts: RoadOpts = DEFAULT_ROAD_OPTS,
): number {
  const es = 0.6108 * Math.exp((17.27 * h.tempC) / (h.tempC + 237.3)); // saturation vapour pressure, kPa (Tetens)
  const vpd = Math.max(0, es * (1 - h.humidityPct / 100));
  const aero = (0.06 + 0.063 * (h.windKmh / 3.6)) * vpd; // sweep-equation form, wind in m/s
  const solar = ((h.solarWm2 * 3.6) / 1000 / 2.45) * opts.solarEfficiency; // W/m² → MJ/m²/h → mm/h (λ=2.45 MJ/kg)
  return aero + solar;
}

export interface RoadHour {
  time: string;
  wet: boolean;
  filmMm: number;
}

/** Hours must be consecutive (feed yesterday's too, so earlier rain carries into today). */
export function roadWetness(hours: HourForecast[], opts: RoadOpts = DEFAULT_ROAD_OPTS): RoadHour[] {
  let film = 0;
  return hours.map((h) => {
    const raining = h.precipMm >= opts.rainWetMmPerH;
    film = h.precipMm > 0 ? Math.min(opts.maxFilmMm, film + h.precipMm) : Math.max(0, film - evapMmPerHour(h, opts));
    return { time: h.time, wet: raining || film > opts.dryBelowMm, filmMm: Math.round(film * 1000) / 1000 };
  });
}
