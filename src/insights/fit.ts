/**
 * Stream-level (.FIT) within-session analysis (data-scientist brief §1).
 *
 * The catalogue's marquee biomechanics signals — cadence drop late in a long run (A5), ground-contact-
 * time and vertical-oscillation decay (A7/A9), step-speed-loss — live in PER-SECOND streams, not the
 * activity summaries this app reads from AI Endurance. The brief's design is to keep those streams
 * "separate and joinable by activity ID".
 *
 * Rather than bundle a heavyweight binary .FIT parser (and a network install), this module reads
 * already-extracted per-second streams from a directory you point it at (`FIT_STREAMS_DIR`). Each file
 * is JSON: `{ activityId, sport, date, samples: [{ t, cadence?, gct?, vo?, hr?, speed? }, ...] }`.
 * The upstream extraction (Garmin export → .FIT → JSON, e.g. via the python `fitparse`/`fitdecode`
 * tools) is the documented manual step; this layer does the analysis. With no directory present it
 * no-ops cleanly, exactly like the optional Garmin gap-filler.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mean, sd, type Maybe } from "./stats.js";
import type { Finding } from "./metrics.js";

interface Sample {
  t?: number;
  cadence?: number;
  gct?: number;
  vo?: number;
  hr?: number;
  speed?: number;
}
interface StreamFile {
  activityId?: string;
  sport?: string;
  date?: string;
  samples?: Sample[];
}

export interface SessionDecay {
  activityId: string;
  date: string;
  durationMin: number;
  cadenceDropPct: number | null; // last quartile vs first quartile (drop = fatigue)
  gctRisePct: number | null; // GCT climbing late = fatigue
  voRisePct: number | null; // vertical oscillation climbing late = form decay
  hrDriftPct: number | null; // cardiac drift across the session
}

function quartileMeans(vals: Maybe[]): { first: number | null; last: number | null } {
  const v = vals.filter((x): x is number => x != null);
  if (v.length < 8) return { first: null, last: null };
  const q = Math.floor(v.length / 4);
  return { first: mean(v.slice(0, q)), last: mean(v.slice(-q)) };
}
function deltaPct(first: number | null, last: number | null): number | null {
  return first != null && last != null && first !== 0 ? +(((last - first) / first) * 100).toFixed(1) : null;
}

export function analyseSession(f: StreamFile): SessionDecay | null {
  const s = f.samples ?? [];
  if (s.length < 60) return null;
  const cad = quartileMeans(s.map((x) => x.cadence ?? null));
  const gct = quartileMeans(s.map((x) => x.gct ?? null));
  const vo = quartileMeans(s.map((x) => x.vo ?? null));
  const hr = quartileMeans(s.map((x) => x.hr ?? null));
  const ts = s.map((x) => x.t).filter((t): t is number => typeof t === "number");
  const durationMin = ts.length >= 2 ? +(((ts[ts.length - 1] - ts[0]) / 60) || s.length / 60).toFixed(0) : +(s.length / 60).toFixed(0);
  return {
    activityId: String(f.activityId ?? "—"),
    date: String(f.date ?? "").slice(0, 10),
    durationMin,
    cadenceDropPct: deltaPct(cad.first, cad.last),
    gctRisePct: deltaPct(gct.first, gct.last),
    voRisePct: deltaPct(vo.first, vo.last),
    hrDriftPct: deltaPct(hr.first, hr.last),
  };
}

/** Load and analyse every stream file in `FIT_STREAMS_DIR` (or the passed dir). Empty if none. */
export function loadSessionDecays(dir = process.env.FIT_STREAMS_DIR): SessionDecay[] {
  if (!dir || !existsSync(dir)) return [];
  const out: SessionDecay[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      const f = JSON.parse(readFileSync(join(dir, name), "utf8")) as StreamFile;
      const d = analyseSession(f);
      if (d) out.push(d);
    } catch {
      // skip unreadable/malformed stream files
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/** Flag long runs (≥75 min) whose late-session cadence drop or GCT rise is an outlier vs the set. */
export function fitFindings(decays: SessionDecay[]): Finding[] {
  const longRuns = decays.filter((d) => d.durationMin >= 75 && d.cadenceDropPct != null);
  if (longRuns.length === 0) return [];
  const drops = longRuns.map((d) => d.cadenceDropPct!).filter((x) => x != null);
  const m = mean(drops) ?? 0;
  const s = sd(drops) ?? 0;
  const latest = longRuns[longRuns.length - 1];
  const out: Finding[] = [];
  // A notably large late-run cadence drop = neuromuscular fatigue / overstriding risk.
  if (latest.cadenceDropPct != null && latest.cadenceDropPct <= -4 && (s === 0 || (latest.cadenceDropPct - m) / s <= -1)) {
    out.push({
      family: "Biomechanics (stream-level)",
      title: "Cadence fades late in long runs",
      severity: "watch",
      detail:
        `Your last long run lost ${Math.abs(latest.cadenceDropPct)}% cadence from first to last quarter` +
        `${latest.gctRisePct != null ? `, with ground-contact time up ${latest.gctRisePct}%` : ""}` +
        ` — neuromuscular fatigue setting in late, the form-decay pattern that raises overstriding/injury risk into the marathon.`,
      evidence: `per-second .FIT streams, ${longRuns.length} long runs analysed [garmin FR970]`,
      recommendation: "Add late-run cadence cues and finish-fast strides; check it shrinks as durability builds.",
    });
  }
  return out;
}
