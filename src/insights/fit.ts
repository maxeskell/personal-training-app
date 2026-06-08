/**
 * Stream-level (.FIT) within-session analysis (data-scientist brief §1).
 *
 * The catalogue's marquee biomechanics signals — cadence drop late in a long run (A5), ground-contact-
 * time and vertical-oscillation decay (A7/A9), step-speed-loss — live in PER-SECOND streams, not the
 * activity summaries this app reads from AI Endurance. The brief's design is to keep those streams
 * "separate and joinable by activity ID".
 *
 * It reads RAW `.FIT` files directly from `FIT_STREAMS_DIR` (via the dependency-free decoder in
 * fitParser.ts — field numbers/scales verified against the athlete's own FR970/Edge files), and still
 * accepts pre-extracted JSON (`{ activityId, sport, date, samples: [{ t, cadence?, gct?, vo?, hr?,
 * power?, speed? }, ...] }`) for anything you've already exported. With no directory present it no-ops
 * cleanly, exactly like the optional Garmin gap-filler.
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mean, sd, type Maybe } from "./stats.js";
import type { Finding } from "./metrics.js";
import { parseFit, type FitActivity } from "./fitParser.js";

interface Sample {
  t?: number;
  cadence?: number;
  gct?: number;
  vo?: number;
  hr?: number;
  power?: number;
  speed?: number;
  temperature?: number;
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
  sport: string;
  durationMin: number;
  cadenceDropPct: number | null; // last quartile vs first quartile (drop = fatigue)
  gctRisePct: number | null; // GCT climbing late = fatigue
  voRisePct: number | null; // vertical oscillation climbing late = form decay
  hrDriftPct: number | null; // cardiac drift across the session
  /** Within-session aerobic decoupling: (EF first half − EF second half)/first half, %. >5% = fade. */
  decouplingPct: number | null;
  avgTempC: number | null; // session mean temperature (°C) — for the heat confounder
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

/** Aerobic decoupling: efficiency (output÷HR) in the first half vs the second — power if available, else speed. */
function halfDecoupling(s: Sample[]): number | null {
  const mid = Math.floor(s.length / 2);
  const ef = (slice: Sample[]) => {
    const pairs = slice
      .map((x) => ({ out: x.power ?? x.speed, hr: x.hr }))
      .filter((p): p is { out: number; hr: number } => p.out != null && p.hr != null && p.hr > 0 && p.out > 0);
    if (pairs.length < 30) return null;
    return mean(pairs.map((p) => p.out / p.hr));
  };
  const first = ef(s.slice(0, mid));
  const second = ef(s.slice(mid));
  return first != null && second != null && first !== 0 ? +(((first - second) / first) * 100).toFixed(1) : null;
}

export function analyseSession(f: StreamFile): SessionDecay | null {
  const s = f.samples ?? [];
  if (s.length < 60) return null;
  const cad = quartileMeans(s.map((x) => x.cadence ?? null));
  const gct = quartileMeans(s.map((x) => x.gct ?? null));
  const vo = quartileMeans(s.map((x) => x.vo ?? null));
  const hr = quartileMeans(s.map((x) => x.hr ?? null));
  const temps = s.map((x) => x.temperature).filter((t): t is number => typeof t === "number");
  const ts = s.map((x) => x.t).filter((t): t is number => typeof t === "number");
  const durationMin = ts.length >= 2 ? +(((ts[ts.length - 1] - ts[0]) / 60) || s.length / 60).toFixed(0) : +(s.length / 60).toFixed(0);
  return {
    activityId: String(f.activityId ?? "—"),
    date: String(f.date ?? "").slice(0, 10),
    sport: String(f.sport ?? "—"),
    durationMin,
    cadenceDropPct: deltaPct(cad.first, cad.last),
    gctRisePct: deltaPct(gct.first, gct.last),
    voRisePct: deltaPct(vo.first, vo.last),
    hrDriftPct: deltaPct(hr.first, hr.last),
    decouplingPct: halfDecoupling(s),
    avgTempC: temps.length ? +mean(temps)!.toFixed(1) : null,
  };
}

/** Convert a decoded .FIT activity into the StreamFile shape analyseSession consumes. */
function fitToStreamFile(act: FitActivity, name: string): StreamFile {
  const firstT = act.samples.find((s) => s.t != null)?.t;
  const date = firstT != null ? new Date(firstT * 1000).toISOString().slice(0, 10) : "";
  return {
    activityId: name.replace(/\.(fit|FIT)$/, ""),
    sport: act.sportName,
    date,
    samples: act.samples.map((s) => ({
      t: s.t,
      cadence: s.cadence,
      gct: s.gct,
      vo: s.vo,
      hr: s.hr,
      power: s.power,
      speed: s.speed,
      temperature: s.temperature,
    })),
  };
}

/** Load and analyse every stream file in `FIT_STREAMS_DIR` (or the passed dir). Empty if none. */
export function loadSessionDecays(dir = process.env.FIT_STREAMS_DIR): SessionDecay[] {
  if (!dir || !existsSync(dir)) return [];
  const out: SessionDecay[] = [];
  for (const name of readdirSync(dir)) {
    try {
      let f: StreamFile | null = null;
      if (/\.(fit|FIT)$/.test(name)) {
        const act = parseFit(readFileSync(join(dir, name)));
        if (act) f = fitToStreamFile(act, name);
      } else if (name.endsWith(".json")) {
        f = JSON.parse(readFileSync(join(dir, name), "utf8")) as StreamFile;
      }
      const d = f ? analyseSession(f) : null;
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
      confidence: 0.6,
    });
  }

  // Within-session aerobic decoupling on a long endurance effort (>60 min): output:HR drifting apart in
  // the second half = fatigue / heat / under-fuelling. The classic >5% durability flag (Friel).
  const longAerobic = decays.filter((d) => d.durationMin >= 60 && d.decouplingPct != null);
  const latestDec = longAerobic[longAerobic.length - 1];
  if (latestDec && latestDec.decouplingPct != null && latestDec.decouplingPct > 5) {
    out.push({
      family: "Durability (stream-level)",
      title: "Aerobic decoupling on long efforts",
      severity: "watch",
      detail:
        `Your last long ${latestDec.sport.toLowerCase()} decoupled ${latestDec.decouplingPct}% — output-to-HR drifted apart in the second half` +
        `${latestDec.avgTempC != null ? ` (avg ${latestDec.avgTempC}°C)` : ""}. Above ~5% points to fatigue, heat, or under-fuelling rather than true aerobic durability.`,
      evidence: `power:HR (or speed:HR) first half vs second, per-second .FIT [garmin]`,
      recommendation: "Hold long-effort intensity more conservatively and rehearse fuelling; expect decoupling to shrink as durability builds.",
      confidence: 0.6,
    });
  }
  return out;
}
