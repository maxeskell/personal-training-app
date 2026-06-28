/**
 * Dependency-free .TCX (Garmin Training Center XML) decoder — the companion to fitParser for archives that
 * aren't raw `.FIT` (e.g. a TrainingPeaks "WorkoutFileExport", whose older entries are `.tcx`/`.tcx.gz`).
 *
 * It decodes only what the career page needs: the per-`<Lap>` summary (time, distance, avg HR, avg power,
 * avg speed) + the activity sport, shaped into the SAME {@link FitActivity} the FIT path produces, so
 * `loadActivityFits` → `enrichRaceResults` / `lapSplits` consume it unchanged. Trackpoint streams are
 * deliberately skipped (samples: []) — laps carry the splits, and keeping a decade of per-second points in
 * memory isn't worth it. Regex-scanned (TCX laps are regular enough), tolerant of namespaced extension tags,
 * and best-effort: a file with no usable laps returns null rather than a fabricated activity.
 */

import type { FitActivity, FitLap } from "./fitParser.js";

const SPORT: Record<string, { num: number; name: string }> = {
  running: { num: 1, name: "Run" },
  biking: { num: 2, name: "Ride" },
  cycling: { num: 2, name: "Ride" },
  swimming: { num: 5, name: "Swim" },
};

function tcxSport(raw: string | undefined): { num: number; name: string } {
  const k = (raw ?? "").toLowerCase();
  return SPORT[k] ?? { num: 0, name: "Other" };
}

/** First `<tag>number</tag>` (namespace-agnostic) in a chunk, or undefined. */
function numTag(s: string, tag: string): number | undefined {
  const m = s.match(new RegExp(`<(?:[\\w-]+:)?${tag}>\\s*([\\d.]+)\\s*</(?:[\\w-]+:)?${tag}>`, "i"));
  return m ? Number(m[1]) : undefined;
}

/** The `<Value>` inside a named HR block (so Average vs Maximum aren't confused). */
function hrIn(s: string, block: string): number | undefined {
  const b = s.match(new RegExp(`<(?:[\\w-]+:)?${block}>([\\s\\S]*?)</(?:[\\w-]+:)?${block}>`, "i"));
  if (!b) return undefined;
  const v = b[1].match(/<(?:[\w-]+:)?Value>\s*([\d.]+)\s*<\/(?:[\w-]+:)?Value>/i);
  return v ? Math.round(Number(v[1])) : undefined;
}

function sumDefined(xs: Array<number | undefined>): number | undefined {
  const v = xs.filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) : undefined;
}

/** Time-weighted mean of a per-lap value (HR / power), weighting by lap duration. */
function timeWeighted(laps: FitLap[], pick: (l: FitLap) => number | undefined): number | undefined {
  let num = 0;
  let den = 0;
  for (const l of laps) {
    const v = pick(l);
    const w = l.timerS ?? 0;
    if (v != null && w > 0) {
      num += v * w;
      den += w;
    }
  }
  return den > 0 ? Math.round(num / den) : undefined;
}

export function parseTcx(buf: Buffer): FitActivity | null {
  const xml = buf.toString("utf8");
  if (!/<Lap\b/i.test(xml)) return null; // no laps → nothing usable
  const sport = tcxSport(xml.match(/<Activity\b[^>]*\bSport="([^"]*)"/i)?.[1]);

  const laps: FitLap[] = [];
  const lapRe = /<Lap\b([^>]*)>([\s\S]*?)<\/Lap>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = lapRe.exec(xml))) {
    // Drop the trackpoint block so lap-level DistanceMeters/HR aren't shadowed by per-point values; keep the
    // tail (Extensions, where avg watts/speed live, can follow </Track>).
    const summary = m[2].replace(/<Track>[\s\S]*?<\/Track>/gi, "");
    const timerS = numTag(summary, "TotalTimeSeconds");
    const distanceM = numTag(summary, "DistanceMeters");
    if (timerS == null && distanceM == null) continue; // not a real effort lap
    const startMs = m[1].match(/StartTime="([^"]*)"/i)?.[1];
    const startTimeS = startMs ? Date.parse(startMs) / 1000 : undefined;
    laps.push({
      index: ++i,
      startTimeS: startTimeS != null && Number.isFinite(startTimeS) ? startTimeS : undefined,
      elapsedS: timerS,
      timerS,
      distanceM,
      avgSpeedMs: numTag(summary, "AvgSpeed"),
      avgHr: hrIn(summary, "AverageHeartRateBpm"),
      avgPowerW: numTag(summary, "AvgWatts"),
    });
  }
  if (!laps.length) return null;

  const distM = sumDefined(laps.map((l) => l.distanceM));
  return {
    sport: sport.num,
    sportName: sport.name,
    subSport: null, // TCX carries no sub_sport
    samples: [],
    laps,
    lengths: [],
    sessions: [],
    session: {
      durationSec: sumDefined(laps.map((l) => l.timerS)),
      distanceKm: distM != null ? +(distM / 1000).toFixed(3) : undefined,
      avgHr: timeWeighted(laps, (l) => l.avgHr),
      avgPower: timeWeighted(laps, (l) => l.avgPowerW),
    },
  };
}
