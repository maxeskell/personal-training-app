/**
 * Deep feedback on a single training session (the `session` CLI command; dashboard card to follow).
 *
 * The per-session data already exists but is never assembled into one view or sent to the model:
 *   - AIE RichActivity      → power, HR, ESS, durability (DFA-α1), aerobic threshold
 *   - .FIT SessionDecay     → in-session cadence/GCT/VO drift, aerobic decoupling, temperature
 *   - archive FitSummary    → thermal bands, training effect, ambient weather
 * assembleSession() isolates the most recent (or named) activity and joins these by date+sport,
 * degrading cleanly when the .FIT stream / archive summary isn't present (never fabricates). The
 * context then frames the session against the prior comparable sessions and that day's load (TSB),
 * so the model gives real feedback — "harder/hotter/more efficient than your norm" — not a number dump.
 */

import type { CoachLLM } from "../llm/client.js";
import type { AthleteState } from "../state/types.js";
import type { InsightReport } from "../insights/engine.js";
import { fitStreamsDir, type SessionDecay } from "../insights/fit.js";
import type { FitSummary } from "../archive/store.js";
import { richActivities, type RichActivity } from "../insights/metrics.js";

function mean(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}
function r1(n: number | null): number | null {
  return n == null ? null : +n.toFixed(1);
}
function r3(n: number | null): number | null {
  return n == null ? null : +n.toFixed(3);
}
function fmt(n: number | null | undefined, d = 0): string {
  return n == null ? "—" : n.toFixed(d);
}

export interface ComparableContext {
  n: number; // prior same-sport sessions used for comparison
  efMean: number | null;
  essMean: number | null;
  durabilityMean: number | null;
  durMinMean: number | null;
}

export interface SessionDetail {
  date: string;
  sport: RichActivity["sport"];
  durationMin: number | null;
  avgPowerW: number | null;
  avgHr: number | null;
  ess: number | null;
  ef: number | null; // power ÷ HR
  durabilityPct: number | null;
  aerThrHr: number | null;
  aerThrW: number | null;
  decay: SessionDecay | null; // biomechanics from the .FIT stream (may be absent)
  fit: FitSummary | null; // thermal / training-effect from the archive (may be absent)
  comparable: ComparableContext;
  tsbOnDay: number | null; // form (TSB) on the session date, for fatigue context
  ctlOnDay: number | null;
}

export interface AssembleSessionOpts {
  date?: string; // YYYY-MM-DD; defaults to the most recent activity
  decays?: SessionDecay[];
  fitSummaries?: FitSummary[];
  /** Run the LLM even without the raw .FIT stream (summary-only feedback). */
  force?: boolean;
}

/** Pick the target activity: the named date, else the most recent; ties broken by longest moving time. */
function pickActivity(acts: RichActivity[], date?: string): RichActivity | null {
  const pool = date ? acts.filter((a) => a.date === date) : acts;
  if (!pool.length) return null;
  const latestDate = date ?? pool.reduce((m, a) => (a.date > m ? a.date : m), pool[0].date);
  const sameDay = pool.filter((a) => a.date === latestDate);
  return sameDay.sort((a, b) => (b.movingSec ?? 0) - (a.movingSec ?? 0))[0];
}

export function assembleSession(state: AthleteState, insights: InsightReport | undefined, opts: AssembleSessionOpts = {}): SessionDetail | null {
  const acts = richActivities(state.raw).sort((a, b) => b.date.localeCompare(a.date));
  const target = pickActivity(acts, opts.date);
  if (!target) return null;

  const ef = target.avwatts != null && target.avhr != null && target.avhr > 0 ? +(target.avwatts / target.avhr).toFixed(3) : null;

  // Prior comparable sessions: same sport, strictly before this one, most recent 5.
  const prior = acts.filter((a) => a.sport === target.sport && a.date < target.date).slice(0, 5);
  const priorEf = prior
    .map((a) => (a.avwatts != null && a.avhr != null && a.avhr > 0 ? a.avwatts / a.avhr : null))
    .filter((x): x is number => x != null);
  const comparable: ComparableContext = {
    n: prior.length,
    efMean: r3(mean(priorEf)),
    essMean: r1(mean(prior.map((a) => a.ess).filter((x): x is number => x != null))),
    durabilityMean: r1(mean(prior.map((a) => a.durabilityPct).filter((x): x is number => x != null))),
    durMinMean: r1(mean(prior.map((a) => (a.movingSec ? a.movingSec / 60 : NaN)).filter((x) => Number.isFinite(x)))),
  };

  // Join the .FIT biomechanics + archive thermal summary by date+sport (RichActivity carries no id).
  const sportTokens = target.sport === "Ride" ? ["ride", "cycl", "bike"] : [target.sport.toLowerCase()];
  const sameSport = (s: string) => sportTokens.some((t) => s.toLowerCase().includes(t));
  const decay = (opts.decays ?? []).find((d) => d.date === target.date && sameSport(d.sport)) ?? null;
  const fit = (opts.fitSummaries ?? []).find((f) => f.date === target.date && sameSport(f.sport)) ?? null;

  const loadPoint = insights?.load?.series.find((p) => p.date === target.date) ?? null;

  return {
    date: target.date,
    sport: target.sport,
    durationMin: target.movingSec ? Math.round(target.movingSec / 60) : null,
    avgPowerW: target.avwatts != null ? Math.round(target.avwatts) : null,
    avgHr: target.avhr != null ? Math.round(target.avhr) : null,
    ess: r1(target.ess ?? null),
    ef,
    durabilityPct: target.durabilityPct ?? null,
    aerThrHr: target.aerThrHr ?? null,
    aerThrW: target.aerThrW ?? null,
    decay,
    fit,
    comparable,
    tsbOnDay: loadPoint?.tsb ?? insights?.load?.tsb ?? null,
    ctlOnDay: loadPoint?.ctl ?? insights?.load?.ctl ?? null,
  };
}

/** Findings whose family is relevant to a single-session readout (heat/economy/durability/brick/fuel). */
function relevantFindings(insights: InsightReport, sport: string): string[] {
  const families = /heat|econom|durab|brick|fuel|illness/i;
  return insights.findings
    .filter((f) => families.test(f.family) && (sport === "Ride" || !/ride|cycl|bike/i.test(f.title) || /heat|fuel|illness/i.test(f.family)))
    .slice(0, 5)
    .map((f) => `- [${f.severity}] ${f.title}: ${f.detail}`);
}

/** Compact, single-session context the model answers from. Notes explicitly when .FIT data is absent. */
export function buildSessionContext(d: SessionDetail, state: AthleteState, insights: InsightReport | undefined): string {
  const c = d.comparable;
  const efVsNorm = d.ef != null && c.efMean != null ? `${(((d.ef - c.efMean) / c.efMean) * 100).toFixed(1)}% vs ${c.efMean}` : "—";
  const lines: string[] = [
    `SESSION (${d.date}, ${d.sport}) [provenance: ai-endurance unless noted]:`,
    `- Duration ${fmt(d.durationMin)}min, avg power ${fmt(d.avgPowerW)}W, avg HR ${fmt(d.avgHr)}bpm, ESS ${fmt(d.ess, 1)}`,
    `- Efficiency (power÷HR) ${fmt(d.ef, 3)} (${efVsNorm} vs your last ${c.n} ${d.sport.toLowerCase()} sessions)`,
    `- Durability (DFA-α1) ${fmt(d.durabilityPct)}% (norm ${fmt(c.durabilityMean)}%), aerobic threshold ${fmt(d.aerThrHr)}bpm / ${fmt(d.aerThrW)}W`,
    `- That day's form: TSB ${fmt(d.tsbOnDay)}, CTL ${fmt(d.ctlOnDay)} ${d.tsbOnDay != null && d.tsbOnDay < -10 ? "(deep in fatigue — read output in that light)" : ""}`,
    `- Comparable norm: ESS ${fmt(c.essMean, 1)}, duration ${fmt(c.durMinMean)}min`,
  ];

  if (d.decay) {
    const dy = d.decay;
    lines.push(
      "",
      `IN-SESSION BIOMECHANICS [.FIT stream — derived]:`,
      `- Aerobic decoupling ${fmt(dy.decouplingPct, 1)}% (>5% = aerobic fade in the second half)`,
      `- Cadence drop ${fmt(dy.cadenceDropPct, 1)}%, GCT rise ${fmt(dy.gctRisePct, 1)}%, vertical-osc rise ${fmt(dy.voRisePct, 1)}%, HR drift ${fmt(dy.hrDriftPct, 1)}% (late vs early quartile)`,
      `- Session mean temperature ${fmt(dy.avgTempC, 1)}°C`,
    );
  } else {
    lines.push("", `IN-SESSION BIOMECHANICS: no raw .FIT stream for this session — cadence/GCT/decoupling unavailable. Sync/fit-sync auto-downloads these when the Garmin download tool is available; the fallback is a per-second .FIT exported from Garmin Connect into data/fit-streams/.`);
  }

  if (d.fit) {
    const f = d.fit;
    lines.push(
      `THERMAL / EFFORT [archive .FIT summary — derived]:`,
      `- Temp ${fmt(f.avgTempC, 1)}°C (range ${fmt(f.minTempC, 1)}–${fmt(f.maxTempC, 1)}, ambient ${fmt(f.weatherTempC, 1)}), HR cool-third ${fmt(f.hrCoolThirdBpm)} vs hot-third ${fmt(f.hrHotThirdBpm)}, training effect ${fmt(f.trainingEffect, 1)}`,
    );
  }

  // What's coming next (user ask): the following 7 days of planned sessions, so the model can say
  // whether this session should change anything ahead — or explicitly that nothing should.
  const horizon = new Date(`${d.date}T00:00:00Z`);
  horizon.setUTCDate(horizon.getUTCDate() + 7);
  const horizonIso = horizon.toISOString().slice(0, 10);
  const upcoming = (state.plannedSessions.value ?? [])
    .filter((p) => p.date.slice(0, 10) > d.date && p.date.slice(0, 10) <= horizonIso)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 7)
    .map((p) => `- ${p.date.slice(0, 10)} ${p.sport ?? "?"}: ${p.title ?? p.type ?? "session"}${p.durationMin != null ? ` (${Math.round(p.durationMin)}min planned)` : ""}`);
  if (upcoming.length) lines.push("", `UPCOMING PLAN (next 7 days) [ai-endurance]:`, ...upcoming);

  if (insights) {
    const rel = relevantFindings(insights, d.sport);
    if (rel.length) lines.push("", `RELEVANT TRENDS (apply to this session):`, ...rel);
  }
  return lines.join("\n");
}

export interface SessionFeedback {
  detail: SessionDetail;
  markdown: string;
  cacheRead: number;
  costUsd: number;
  /** True when the LLM was skipped because the raw .FIT stream is missing (markdown = how to unlock). */
  skippedNoFit?: boolean;
}

/** Returned in place of LLM output when the raw .FIT stream is absent — no tokens spent. */
export function missingFitNote(d: SessionDetail): string {
  return [
    `# Session feedback — ${d.date} ${d.sport} (skipped)`,
    "",
    "Deep analysis needs this session's raw per-second .FIT — without it there are no in-session",
    "biomechanics (cadence/GCT/decoupling) to read, so the LLM call was skipped rather than spending",
    "tokens on a summary-only readout.",
    "",
    `To unlock: Garmin Connect → this activity → ⚙ → Export Original, drop the file into ${fitStreamsDir()}/.`,
    "(Sync normally fetches this automatically — seeing this note means the download failed or the",
    "Garmin download tool isn't available, so the manual export is the fallback.)",
  ].join("\n");
}

export async function runSessionFeedback(
  llm: CoachLLM,
  state: AthleteState,
  insights: InsightReport | undefined,
  opts: AssembleSessionOpts = {},
): Promise<SessionFeedback | null> {
  const detail = assembleSession(state, insights, opts);
  if (!detail) return null;

  // Without the raw .FIT stream the deep dive adds nothing over the summary the dashboard already
  // shows — skip the LLM spend and say how to unlock it (user ask). `force` overrides.
  if (!detail.decay && !opts.force) {
    return { detail, markdown: missingFitNote(detail), cacheRead: 0, costUsd: 0, skippedNoFit: true };
  }

  const prompt = [
    "Give the athlete in-depth, coach-quality feedback on this single training session, using ONLY the data below.",
    "Structure: (1) one-line verdict on what this session was and how it landed; (2) what went well; (3) what to",
    "watch or change next time; (4) 2–3 concrete, actionable takeaways (pacing, fuelling, recovery, technique);",
    "(5) if an UPCOMING PLAN section is present: what, if anything, this session should change in those sessions —",
    "name the specific session and the adjustment, or say plainly that nothing should change. You only suggest;",
    "plan writes happen elsewhere.",
    "Read every number against the athlete's own norm and that day's fatigue (TSB) — a dip in deep fatigue or heat is",
    "not the same as lost fitness. Honour the coaching stance: trend over single point, fuel to train, weight is a",
    "trend not a target. If the .FIT biomechanics are absent, say what you cannot assess rather than guessing. Do NOT",
    "invent numbers not present below. Be direct and specific; lead with the verdict.",
    "Formatting: this renders in a small dashboard panel — '## ' headers for the numbered sections, bold only for",
    "the verdict and key numbers, '- ' for lists; no tables, no nested emphasis.",
    "",
    "=== SESSION DATA ===",
    buildSessionContext(detail, state, insights),
  ].join("\n");

  const { text, cacheRead, costUsd } = await llm.text(prompt);
  return { detail, markdown: `# Session feedback — ${detail.date} ${detail.sport}\n\n${text}`, cacheRead, costUsd };
}
