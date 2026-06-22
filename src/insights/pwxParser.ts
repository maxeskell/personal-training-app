/**
 * Dependency-free `.PWX` (TrainingPeaks PWX XML) decoder — the third format a TrainingPeaks
 * "WorkoutFileExport" ships (alongside `.fit` and `.tcx`), used here for older races (e.g. a 2013 Ironman).
 *
 * Like {@link parseTcx} it decodes only what the career page needs — the per-`<segment>` lap summaries and
 * the workout-level summary, shaped into the same {@link FitActivity} (so the loader → enrichment → render
 * path is unchanged). PWX puts metrics in a `<summarydata>` block: scalar children (`<duration>`, `<dist>`,
 * `<beginning>`) and stat elements whose value is an attribute (`<hr avg="…"/>`, `<pwr avg="…"/>`). Trackpoint
 * `<sample>`s are skipped (samples: []). Best-effort: a file with no usable summary returns null.
 */

import type { FitActivity, FitLap } from "./fitParser.js";

const SPORT: Record<string, { num: number; name: string }> = {
  bike: { num: 2, name: "Ride" },
  cycling: { num: 2, name: "Ride" },
  run: { num: 1, name: "Run" },
  running: { num: 1, name: "Run" },
  swim: { num: 5, name: "Swim" },
  swimming: { num: 5, name: "Swim" },
};

function pwxSport(raw: string | undefined): { num: number; name: string } {
  const k = (raw ?? "").trim().toLowerCase();
  return SPORT[k] ?? { num: 0, name: "Other" };
}

/** A scalar child element value, e.g. `<duration>3600</duration>`. */
function childNum(s: string, tag: string): number | undefined {
  const m = s.match(new RegExp(`<${tag}\\b[^>]*>\\s*([\\d.]+)\\s*</${tag}>`, "i"));
  return m ? Number(m[1]) : undefined;
}

/** A stat element's `avg` attribute, e.g. `<hr max="180" avg="150"/>`. */
function avgAttr(s: string, tag: string): number | undefined {
  const m = s.match(new RegExp(`<${tag}\\b[^>]*\\bavg="([\\d.]+)"`, "i"));
  return m ? Number(m[1]) : undefined;
}

function lapFromSummary(sd: string, index: number, startBase: number | undefined): FitLap | null {
  const timerS = childNum(sd, "duration");
  const distanceM = childNum(sd, "dist");
  if (timerS == null && distanceM == null) return null;
  const beginning = childNum(sd, "beginning");
  const hr = avgAttr(sd, "hr");
  const pwr = avgAttr(sd, "pwr");
  return {
    index,
    startTimeS: startBase != null ? startBase + (beginning ?? 0) : undefined,
    elapsedS: timerS,
    timerS,
    distanceM,
    avgHr: hr != null ? Math.round(hr) : undefined,
    avgPowerW: pwr != null ? Math.round(pwr) : undefined,
  };
}

export function parsePwx(buf: Buffer): FitActivity | null {
  const xml = buf.toString("utf8");
  if (!/<workout[\s>]/i.test(xml)) return null;
  const sport = pwxSport(xml.match(/<sportType>\s*([^<]+?)\s*<\/sportType>/i)?.[1]);
  const startIso = xml.match(/<time>\s*([^<]+?)\s*<\/time>/i)?.[1];
  const startBase = startIso ? Date.parse(startIso) / 1000 : undefined;
  const startOk = startBase != null && Number.isFinite(startBase) ? startBase : undefined;

  // <segment> blocks are the laps; each wraps its own <summarydata>.
  const laps: FitLap[] = [];
  const segRe = /<segment\b[^>]*>([\s\S]*?)<\/segment>/gi;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = segRe.exec(xml))) {
    const sd = m[1].match(/<summarydata\b[^>]*>([\s\S]*?)<\/summarydata>/i)?.[1] ?? m[1];
    const lap = lapFromSummary(sd, ++i, startOk);
    if (lap) laps.push(lap);
  }

  // The workout-level <summarydata> is the one NOT inside a <segment>.
  const overall = xml.replace(/<segment\b[\s\S]*?<\/segment>/gi, "").match(/<summarydata\b[^>]*>([\s\S]*?)<\/summarydata>/i)?.[1];

  if (!laps.length && overall) {
    const lap = lapFromSummary(overall, 1, startOk); // no segments → the whole workout is one lap
    if (lap) laps.push(lap);
  }
  if (!laps.length) return null;

  const distM = overall != null ? childNum(overall, "dist") : undefined;
  const distSum = distM ?? sumLap(laps, (l) => l.distanceM);
  return {
    sport: sport.num,
    sportName: sport.name,
    samples: [],
    laps,
    lengths: [],
    sessions: [],
    session: {
      durationSec: (overall != null ? childNum(overall, "duration") : undefined) ?? sumLap(laps, (l) => l.timerS),
      distanceKm: distSum != null ? +(distSum / 1000).toFixed(3) : undefined,
      avgHr: overall != null ? avgAttr(overall, "hr") : undefined,
      avgPower: overall != null ? avgAttr(overall, "pwr") : undefined,
    },
  };
}

function sumLap(laps: FitLap[], pick: (l: FitLap) => number | undefined): number | undefined {
  const v = laps.map(pick).filter((x): x is number => typeof x === "number");
  return v.length ? v.reduce((a, b) => a + b, 0) : undefined;
}
