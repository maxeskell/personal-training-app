import type { AthleteState, ActualActivity, ZoneSet } from "../state/types.js";
import type { DecisionRecord } from "../state/decisionLog.js";
import type { InsightReport } from "../insights/engine.js";
import { findingKey } from "../insights/metrics.js";
import { paceStr } from "../insights/zones.js";
import { coachHeadline, tsbBand, rampBand, type Tone } from "../insights/headline.js";
import { assembleSession } from "./session.js";

/**
 * Glanceable local dashboard (Path-B need #2): a single self-contained HTML file with
 * Today / Week / Trends / Race. No server, no build — generated on demand and opened in the
 * browser. Coaching PROSE still comes from the flows; this is the at-a-glance state view.
 */

function daysTo(fromIso: string, toIso: string): number {
  const a = new Date(`${fromIso}T00:00:00Z`).getTime();
  const b = new Date(`${String(toIso).slice(0, 10)}T00:00:00Z`).getTime();
  return Math.round((b - a) / 86_400_000);
}

/** Inline SVG sparkline from a numeric series (nulls skipped). */
function spark(values: Array<number | null | undefined>, w = 140, h = 30): string {
  const pts = values.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : null));
  const real = pts.filter((v): v is number => v != null);
  if (real.length < 2) return `<span class="muted">—</span>`;
  const min = Math.min(...real);
  const max = Math.max(...real);
  const span = max - min || 1;
  const n = pts.length;
  const coords = pts
    .map((v, i) => (v == null ? null : `${(i / (n - 1)) * w},${h - ((v - min) / span) * h}`))
    .filter((c): c is string => c != null);
  const last = real[real.length - 1];
  const first = real[0];
  const dir = last > first ? "up" : last < first ? "down" : "flat";
  return `<svg width="${w}" height="${h}" class="spark ${dir}"><polyline points="${coords.join(" ")}" fill="none" stroke-width="2"/></svg>`;
}

function activitiesLast7(today: AthleteState): Map<string, { n: number; min: number; km: number }> {
  const cut = new Date(`${today.date}T00:00:00Z`);
  cut.setUTCDate(cut.getUTCDate() - 7);
  const cutISO = cut.toISOString().slice(0, 10);
  const acts = (today.actualActivities.value ?? []).filter((a: ActualActivity) => a.date >= cutISO && a.date <= today.date);
  const m = new Map<string, { n: number; min: number; km: number }>();
  for (const a of acts) {
    const e = m.get(a.sport) ?? { n: 0, min: 0, km: 0 };
    e.n += 1;
    e.min += a.durationMin ?? 0;
    e.km += a.distanceKm ?? 0;
    m.set(a.sport, e);
  }
  return m;
}

export interface DashboardInput {
  window: AthleteState[];
  decisions: DecisionRecord[];
  insights?: InsightReport;
  /** Backfilled Garmin daily series — drives the multi-week Trends + health strip (not the 1-day state store). */
  garminDays?: Array<{
    date: string;
    hrvMs?: number;
    restingHr?: number;
    sleepHours?: number;
    sleepScore?: number;
    avgStressLevel?: number;
    bodyBatteryChange?: number;
    deepSleepSec?: number;
  }>;
}

const TONE_COLOR: Record<Tone, string> = { good: "#1a8a3a", neutral: "#777", warn: "#c98a00", bad: "#c0392b" };
const SEV_COLOR: Record<string, string> = { red: "#c0392b", amber: "#c98a00", green: "#1a8a3a", flag: "#c0392b", watch: "#c98a00", info: "#1a8a3a" };

function renderSignals(ins: InsightReport): string {
  const L = ins.load;
  const band = tsbBand(L?.tsb);
  const ramp = L ? rampBand(L.rampPerWeek) : null;
  const ctlSpark = L ? spark(L.series.map((p) => p.ctl), 160, 30) : "";
  const trend = (label: string, t: { recent: number | null; deltaPct: number | null; n: number }) =>
    t.recent == null
      ? ""
      : `<tr><td>${label}</td><td class="num">${t.recent}</td><td class="num">${t.deltaPct == null ? "—" : (t.deltaPct >= 0 ? "+" : "") + t.deltaPct + "%"}</td><td class="muted">${t.n} pts</td></tr>`;
  // Durability is a negative-based decay index — a % change is meaningless, so show recent vs prior absolute.
  const durabilityRow = (t: { recent: number | null; prior: number | null; n: number }) =>
    t.recent == null
      ? ""
      : `<tr><td>Run durability</td><td class="num">${t.recent}</td><td class="muted" colspan="2">${t.prior != null ? `was ${t.prior} · ` : ""}closer to 0 = more durable</td></tr>`;

  return `<div class="card"><h2>Load &amp; trends</h2>
    <div class="grid">
      <div><div class="k">Fitness (CTL)</div><div class="v">${L ? L.ctl : "—"}</div></div>
      <div><div class="k">Fatigue (ATL)</div><div class="v">${L ? L.atl : "—"}</div></div>
      <div><div class="k">Form (TSB)</div><div class="v">${L ? L.tsb : "—"}</div>${band ? `<div class="k" style="color:${TONE_COLOR[band.tone]}">${escapeHtml(band.label)}</div>` : ""}</div>
      <div><div class="k">CTL trend</div>${ctlSpark || '<span class="muted">—</span>'}${ramp ? `<div class="k" style="color:${TONE_COLOR[ramp.tone]}">+${L!.rampPerWeek}/wk · ${escapeHtml(ramp.label)}</div>` : ""}</div>
    </div>
    <table style="margin-top:12px"><tr class="k"><td>Trend (recent vs prior)</td><td>Now</td><td>Δ</td><td></td></tr>
      ${trend("Run efficiency (EF)", ins.ef.run)}
      ${trend("Ride efficiency (EF)", ins.ef.ride)}
      ${durabilityRow(ins.durability.run)}
      ${trend("Run aerobic threshold (HR)", ins.threshold.run)}
    </table>
    <details style="margin-top:10px"><summary style="cursor:pointer;color:#888;font-size:12px">Methods &amp; n=1 analytics — how these are computed</summary>
      <div class="k" style="margin-top:8px">CTL/ATL/TSB derived from daily ESS. EF on steady runs ≥40min. Durability/threshold from AI Endurance's DFA-α1. ACWR intentionally not used (validity).</div>
      ${renderAnalytics(ins)}
    </details>
  </div>`;
}

/** New n=1 analytics layers (Q1–Q7): backtested monitoring rule, regime shifts, tri execution, taper. */
function renderAnalytics(ins: InsightReport): string {
  const m = ins.monitoring.best;
  const tag = ins.monitoring.validated ? "held-out" : "exploratory";
  const rule = m
    ? `<b>${escapeHtml(m.name)}</b> → lead ${m.lead}d · hit ${Math.round(m.hitRate * 100)}% · false-alarm ${Math.round(m.falseAlarmRate * 100)}% <span class="muted">(${tag}${m.pValue != null ? `, p=${m.pValue}` : ""}; ${ins.monitoring.days}d, vs ${escapeHtml(ins.monitoring.outcomeName)})</span>`
    : `<span class="muted">no rule validated yet (${ins.monitoring.days}d history)</span>`;
  const cps = ins.changePoints
    .flatMap((s) => (s.points.length ? [{ metric: s.metric, p: s.points[s.points.length - 1] }] : []))
    .filter((x) => x.p.date)
    .map((x) => `${escapeHtml(x.metric)} ${x.p.before}→${x.p.after} <span class="muted">@ ${x.p.date}</span>`)
    .join(" · ");
  const brick = ins.brick.decouplingPct != null ? `${ins.brick.decouplingPct}% off-bike EF drop <span class="muted">(${ins.brick.brickDays} brick days)</span>` : `<span class="muted">need power-equipped runs</span>`;
  const taper = ins.taper.recommendedTsbLow != null ? `race-day TSB ~${ins.taper.recommendedTsbLow} to ${ins.taper.recommendedTsbHigh}` : `<span class="muted">no past race-day TSB yet</span>`;
  return `<table style="margin-top:12px"><tr class="k"><td>n=1 analytics</td><td></td></tr>
    <tr><td>Monitoring rule (backtested)</td><td>${rule}</td></tr>
    <tr><td>Regime shifts</td><td>${cps || '<span class="muted">none dated</span>'}</td></tr>
    <tr><td>Brick decoupling (Q4)</td><td>${brick}</td></tr>
    <tr><td>Taper target (Q6)</td><td>${taper}</td></tr>
  </table>`;
}

/** Top-5 insights box with agree / disagree / ignore actions (posts to /insight-feedback). */
function renderInsightsBox(ins: InsightReport): string {
  const sevColor = (s: string) => (s === "flag" ? "#c0392b" : s === "watch" ? "#c98a00" : "#1a8a3a");
  const top = ins.topFindings.slice(0, 5);
  if (!top.length) return `<div class="card"><h2>Top insights</h2><div class="muted">No strong signals right now — nothing worth your attention today.</div></div>`;
  const rows = top
    .map((f) => {
      const key = findingKey(f);
      const conf = Math.round((f.confidence ?? 0.6) * 100);
      return `<div class="insight sev-${f.severity}" data-key="${escapeHtml(key)}" data-summary="${escapeHtml(f.title)}">
        <div><span class="badge" style="background:${sevColor(f.severity)}">${f.severity}</span>
          <b style="${f.severity === "flag" ? "font-size:15px" : ""}">${escapeHtml(f.title)}</b> <span class="muted">· ${conf}% conf · ${escapeHtml(f.family)}</span></div>
        <div class="fdetail">${escapeHtml(f.detail)}</div>
        ${f.recommendation ? `<div class="ev">→ ${escapeHtml(f.recommendation)}</div>` : ""}
        <div class="ev">${escapeHtml(f.evidence)}</div>
        <div class="acts">
          <button class="agree" data-reaction="agree" onclick="feedback(this)">👍 Agree</button>
          <button class="disagree" data-reaction="disagree" onclick="feedback(this)">👎 Disagree</button>
          <button class="ignore" data-reaction="ignore" onclick="feedback(this)">✕ Ignore</button>
          <span class="reacted"></span>
        </div>
      </div>`;
    })
    .join("");
  return `<div class="card insights"><h2>Top insights — your call</h2>
    <div class="k" style="margin-bottom:8px">Ranked by signal strength. Disagree/ignore hides that insight for ~2 weeks and tells the coach to stop raising it.</div>
    ${rows}
  </div>`;
}

function zoneTable(title: string, z: ZoneSet | undefined): string {
  if (!z || z.bounds.length < 2) return "";
  const fmtVal = (v: number) => (z.metric === "pace" ? paceStr(v) : `${v}`);
  const rows = (z.labels ?? z.bounds.slice(1).map((_, i) => `Z${i + 1}`))
    .map((lab, i) => `<tr><td>${escapeHtml(lab)}</td><td class="num">${fmtVal(z.bounds[i])}–${fmtVal(z.bounds[i + 1])} ${z.unit}</td></tr>`)
    .join("");
  return `<div style="flex:1;min-width:200px"><div class="k">${title} <span class="muted">(${z.source})</span></div><table>${rows}</table></div>`;
}

/** "Last session" card: the most recent activity at a glance + a button for deep LLM feedback. */
function renderLastSession(today: AthleteState, insights: InsightReport | undefined): string {
  const d = assembleSession(today, insights);
  if (!d) return "";
  const efNorm = d.ef != null ? `EF ${d.ef.toFixed(3)}${d.comparable.efMean != null ? ` (norm ${d.comparable.efMean})` : ""}` : "";
  const bits = [
    d.durationMin != null ? `${d.durationMin}min` : "",
    d.avgPowerW != null ? `${d.avgPowerW}W` : "",
    d.avgHr != null ? `${d.avgHr}bpm` : "",
    efNorm,
    d.ess != null ? `ESS ${d.ess}` : "",
    d.durabilityPct != null ? `durability ${d.durabilityPct}%` : "",
  ].filter(Boolean).join(" · ");
  return `<div class="card"><h2>Last session — ${d.date} ${d.sport}</h2>
    <div style="font-size:14px;margin-bottom:10px">${escapeHtml(bits)}</div>
    <button class="actbtn" onclick="sessionFeedback()">🔍 Deep feedback on this session</button>
    <div id="sessionfb" style="margin-top:12px;font-size:14px;color:#333;white-space:pre-wrap"></div>
  </div>`;
}

/** Zones + FTP/threshold markers per discipline. */
function renderZones(today: AthleteState): string {
  const z = today.zones.value;
  const t = today.thresholds.value;
  if (!z && !t) return "";
  const markers = t
    ? [
        t.bikeFtpW != null ? `Bike FTP <b>${t.bikeFtpW} W</b>${t.bikeFtpWkg != null ? ` (${t.bikeFtpWkg} W/kg)` : ""}` : "",
        t.runThresholdPowerW != null ? `Run FTP <b>${t.runThresholdPowerW} W</b>` : "",
        t.runThresholdPaceSecPerKm != null ? `Run threshold <b>${paceStr(t.runThresholdPaceSecPerKm)}/km</b>` : "",
        t.runThresholdHr != null ? `Run LTHR <b>${t.runThresholdHr} bpm</b>` : "",
        t.swimCssSecPer100 != null ? `Swim CSS <b>${paceStr(t.swimCssSecPer100)}/100m</b>` : "",
      ].filter(Boolean).join(" · ")
    : "";
  const ftpNote = t?.bikeFtpNote ? `<div style="font-size:12px;color:#b45309;margin-bottom:12px">⚠ ${t.bikeFtpNote}</div>` : "";
  return `<div class="card"><h2>Zones & thresholds</h2>
    ${markers ? `<div style="font-size:14px;margin-bottom:${ftpNote ? "4px" : "12px"}">${markers}</div>` : ""}
    ${ftpNote}
    <div class="grid">
      ${zoneTable("Bike power", z?.bike?.power)}
      ${zoneTable("Run power", z?.run?.power)}
      ${zoneTable("Run pace", z?.run?.pace)}
      ${zoneTable("Run HR", z?.run?.hr)}
      ${zoneTable("Swim pace", z?.swim?.pace)}
    </div>
    <div class="k" style="margin-top:8px">Derived zones use standard models (Coggan power / %-LTHR / %-threshold pace). Threshold-pace MODEL estimates are trend-relative.</div>
  </div>`;
}

/** Garmin model scores: endurance score, hill score, and the power-duration curve (MMP). */
function renderScores(today: AthleteState): string {
  const e = today.enduranceScore.value;
  const h = today.hillScore.value;
  const p = today.powerCurve.value;
  if (!e && !h && !p) return "";
  const mmpRows = p?.bests?.length
    ? `<table style="margin-top:8px"><tr class="k"><td>Duration</td><td>Best</td></tr>${p.bests
        .map((b) => `<tr><td>${escapeHtml(b.duration)}</td><td class="num">${b.watts} W</td></tr>`)
        .join("")}</table>`
    : "";
  return `<div class="card"><h2>Garmin scores</h2>
    <div class="grid">
      ${e ? `<div><div class="k">Endurance score</div><div class="v">${e.current ?? "—"}</div><div class="k">${escapeHtml(e.classification ?? "")}${e.nextThresholdGap != null ? ` · ${e.nextThresholdGap} to ${escapeHtml((e.nextThresholdLabel ?? "").replace(/_/g, " "))}` : ""}</div></div>` : ""}
      ${h ? `<div><div class="k">Hill score</div><div class="v">${h.overall ?? "—"}</div><div class="k">str ${h.strength ?? "—"} / end ${h.endurance ?? "—"}</div></div>` : ""}
      ${p?.ftpEstimateW != null ? `<div><div class="k">FTP estimate</div><div class="v">${p.ftpEstimateW} W</div><div class="k">${p.activitiesAnalyzed ?? "?"} activities</div></div>` : ""}
    </div>
    ${mmpRows}
    <div class="k" style="margin-top:8px">Endurance/hill/MMP are Garmin MODEL estimates — read the trend. Power curve sharpens as fit-sync pulls power-equipped sessions.</div>
  </div>`;
}

/** Estimated race times across standard distances (Garmin race predictor). */
function renderRacePredictions(today: AthleteState): string {
  const rp = today.racePredictions.value;
  if (!rp || !rp.predictions.length) return "";
  const rows = rp.predictions
    .map((p) => `<tr><td>${escapeHtml(p.label)}</td><td class="num">${hms(p.timeSeconds)}</td></tr>`)
    .join("");
  return `<div class="card"><h2>Estimated race times</h2>
    <table><tr class="k"><td>Distance</td><td>Predicted</td></tr>${rows}</table>
    <div class="k" style="margin-top:8px">Garmin race predictor${rp.date ? ` (as of ${escapeHtml(rp.date)})` : ""} — MODEL estimate; watch the trend, and see "Estimated race splits" below for race-day pacing.</div>
  </div>`;
}

/** Estimated race splits dependent on training (durability-shaped pacing plan). */
function renderSplits(ins: InsightReport): string {
  if (!ins.splits.length) return "";
  const blocks = ins.splits
    .map((p) => {
      const rows = p.segments
        .map((s) => `<tr><td>${escapeHtml(s.label)}</td><td class="num">${paceStr(s.targetPaceSecPerKm)}/km</td><td class="num">${hms(s.cumulativeSec)}</td></tr>`)
        .join("");
      return `<div style="margin-bottom:14px">
        <div style="font-size:14px"><b>${escapeHtml(p.race)}</b> — target ${hms(p.predictedSec)} over ${p.distanceKm} km</div>
        <div class="ev" style="margin:4px 0">${escapeHtml(p.strategy)}</div>
        <table><tr class="k"><td>Segment</td><td>Target pace</td><td>Cumulative</td></tr>${rows}</table>
      </div>`;
    })
    .join("");
  return `<div class="card"><h2>Estimated race splits</h2>${blocks}
    <div class="k">Built from AI Endurance's predicted finish (MODEL — trend over absolute), shaped by your durability trend.</div>
  </div>`;
}

function hms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** A small status chip (label + value, tone-coloured). */
function chip(label: string, value: string, tone: Tone = "neutral"): string {
  return `<span style="display:inline-block;background:#f4f1ea;border-left:3px solid ${TONE_COLOR[tone]};border-radius:4px;padding:3px 8px;margin:0 6px 6px 0;font-size:12px"><span class="k">${escapeHtml(label)}</span> <b>${escapeHtml(value)}</b></span>`;
}

/**
 * The "Today" decision header (#1) — leads with one synthesised call + the single action, corroborating
 * drivers, an always-visible health strip (#8), the LLM readiness narrative, and the key metrics.
 */
function renderHeader(today: AthleteState, insights: InsightReport | undefined, decisions: DecisionRecord[], gar: DashboardInput["garminDays"]): string {
  const hl = insights ? coachHeadline(insights, today) : null;
  const lastReadiness = [...decisions].reverse().find((d) => d.kind === "readiness");
  const verdictWord = lastReadiness?.summary.split(":")[0]?.trim().toLowerCase();
  const sev = hl?.severity ?? (verdictWord === "green" || verdictWord === "amber" || verdictWord === "red" ? verdictWord : "green");
  const color = SEV_COLOR[sev] ?? "#777";
  const narrative = lastReadiness?.summary.split(":").slice(1).join(":").trim();
  const r = today.recovery.value;
  const ts = today.trainingStatus.value;
  const latestGar = gar && gar.length ? gar[gar.length - 1] : undefined;

  // Health strip — always visible so "quiet" is distinguishable from "not computed".
  const stress = latestGar?.avgStressLevel;
  const recharge = latestGar?.bodyBatteryChange;
  const chips = [
    today.sleep.value?.score != null ? chip("Sleep", `${today.sleep.value.score}`, today.sleep.value.score >= 70 ? "good" : today.sleep.value.score >= 50 ? "warn" : "bad") : "",
    today.hrvStatus.value?.status ? chip("HRV", today.hrvStatus.value.status, /balanced/i.test(today.hrvStatus.value.status) ? "good" : "warn") : "",
    ts?.acwrStatus ? chip("Acute:chronic", `${ts.loadRatio ?? "?"} ${ts.acwrStatus}`, ts.acwrStatus.toUpperCase() === "HIGH" ? "bad" : "good") : "",
    stress != null ? chip("Day stress", `${Math.round(stress)}`, stress >= 50 ? "warn" : "good") : "",
    recharge != null ? chip("Overnight recharge", `+${Math.round(recharge)}`, recharge >= 40 ? "good" : "warn") : "",
    r?.limiterToday ? chip("Limiter", String(r.limiterToday), "warn") : "",
  ].filter(Boolean).join("");

  return `<div class="card" style="border-top:4px solid ${color}">
    <h2>Today — ${today.date.slice(5)}</h2>
    <div class="verdict"><span class="dot" style="background:${color}"></span>
      <span class="big" style="color:${color}">${escapeHtml(sev)}</span></div>
    ${hl ? `<p style="font-size:16px;color:#222;margin:10px 0 6px;font-weight:500">${escapeHtml(hl.line)}</p>` : ""}
    ${hl?.action ? `<div style="background:${color};color:#fff;border-radius:8px;padding:10px 12px;font-size:14px;margin:6px 0 8px">➡️ ${escapeHtml(hl.action)}</div>
      <button class="actbtn" onclick="actPlan()">⚙ Turn this into a plan change</button><div id="proposals"></div>` : ""}
    ${hl && hl.drivers.length ? `<div class="k" style="margin-bottom:10px">${hl.drivers.map(escapeHtml).join(" · ")}</div>` : ""}
    <div style="margin:6px 0 12px">${chips}</div>
    ${narrative ? `<details><summary style="cursor:pointer;font-size:13px;color:#888">Readiness detail</summary><p style="font-size:14px;color:#444;margin:8px 0">${escapeHtml(narrative)}</p></details>` : ""}
    <div class="grid" style="margin-top:6px">
      <div><div class="k">HRV (ms)</div><div class="v">${fmt(today.hrvOvernight.value)}</div></div>
      <div><div class="k">Resting HR</div><div class="v">${fmt(today.restingHr.value)}</div></div>
      <div><div class="k">Sleep (h)</div><div class="v">${fmt(today.sleep.value?.hours, 1)}</div></div>
      <div><div class="k">Cardio rec.</div><div class="v">${fmt(r?.cardioRecovery)}</div></div>
    </div>
  </div>`;
}

export function renderDashboard({ window, decisions, insights, garminDays }: DashboardInput): string {
  const today = window[window.length - 1];

  // Week: load by sport.
  const load = activitiesLast7(today);
  const loadRows = [...load.entries()]
    .map(([s, e]) => `<tr><td>${s}</td><td>${e.n}</td><td>${Math.round(e.min)} min</td><td>${e.km.toFixed(1)} km</td></tr>`)
    .join("");

  // Trends from the backfilled Garmin daily series (the multi-week archive), not the 1-day state store.
  const gar = (garminDays ?? []).slice(-42);
  const garRow = (label: string, pick: (d: NonNullable<DashboardInput["garminDays"]>[number]) => number | null | undefined, dec = 0) => {
    const vals = gar.map(pick);
    if (vals.filter((v) => v != null).length < 2) return "";
    const last = [...vals].reverse().find((v) => v != null);
    return `<tr><td>${label}</td><td>${spark(vals)}</td><td class="num">${last == null ? "—" : last.toFixed(dec)}</td></tr>`;
  };
  const trendRows = [
    garRow("HRV (ms)", (d) => d.hrvMs),
    garRow("Resting HR", (d) => d.restingHr),
    garRow("Sleep (h)", (d) => d.sleepHours, 1),
    garRow("Sleep score", (d) => d.sleepScore),
    garRow("Day stress (avg)", (d) => d.avgStressLevel),
    garRow("Deep sleep (min)", (d) => (d.deepSleepSec != null ? d.deepSleepSec / 60 : null)),
  ].join("");

  // Race: next goals + countdown.
  const goals = (today.raw?.getRaceGoalEvent as { goals?: Array<{ event_name?: string; event_date?: string; priority?: unknown }> } | undefined)?.goals ?? [];
  const raceRows = goals
    .filter((g) => g.event_date)
    .map((g) => ({ ...g, dt: daysTo(today.date, g.event_date!) }))
    .sort((a, b) => a.dt - b.dt)
    .map(
      (g) =>
        `<tr><td>${escapeHtml(g.event_name ?? "—")}</td><td>${escapeHtml(String(g.event_date ?? ""))}</td><td class="num">${g.dt >= 0 ? `T-${g.dt}d` : `${-g.dt}d ago`}</td><td>${escapeHtml(String(g.priority ?? ""))}</td></tr>`,
    )
    .join("");

  // Humanised activity log — plain labels, status icon, dev ids stripped from the summary.
  const KIND_LABEL: Record<string, string> = { readiness: "Readiness", "plan-adjust": "Plan change", "insight-feedback": "Your feedback", note: "Note" };
  const STATUS_LABEL: Record<string, string> = { accepted: "✓ agreed", declined: "✕ dismissed", deferred: "○ ignored", proposed: "• proposed", executed: "✓ applied", note: "" };
  const recentDecisions = [...decisions]
    .reverse()
    .slice(0, 8)
    .map((d) => {
      const summary = (d.summary ?? "").replace(/\s*\(?id=\d+\)?/g, "").replace(/^[a-z]+:\s*/i, "").trim();
      return `<tr><td>${escapeHtml(KIND_LABEL[d.kind] ?? d.kind)}</td><td class="muted">${escapeHtml(STATUS_LABEL[d.status] ?? d.status)}</td><td>${escapeHtml(summary.slice(0, 90))}</td></tr>`;
    })
    .join("");

  return `<!doctype html><html><head><meta charset="utf-8"><title>Endurance Coach — ${today.date}</title>
<style>
:root{font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#222}
body{margin:0;background:#f4f1ea;padding:24px;max-width:760px;margin:auto}
h1{font-size:20px;margin:0 0 2px} .sub{color:#777;font-size:13px;margin-bottom:18px}
.card{background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
.card h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#999;margin:0 0 12px}
.verdict{display:flex;align-items:center;gap:12px}
.dot{width:16px;height:16px;border-radius:50%}
.big{font-size:22px;font-weight:600;text-transform:capitalize}
table{width:100%;border-collapse:collapse;font-size:14px} td{padding:5px 6px;border-bottom:1px solid #f0ede5}
.num{text-align:right;font-variant-numeric:tabular-nums} .muted{color:#bbb}
.spark polyline{stroke:#888}.spark.up polyline{stroke:#1a8a3a}.spark.down polyline{stroke:#c0392b}
.grid{display:flex;gap:14px;flex-wrap:wrap}.grid>div{flex:1;min-width:120px}
.k{color:#999;font-size:12px}.v{font-size:18px;font-weight:600}
.finding{padding:8px 0;border-bottom:1px solid #f0ede5}.finding:last-child{border:0}
.badge{color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:10px;margin-right:8px}
.fdetail{font-size:13px;color:#444;margin:3px 0}.ev{font-size:11px;color:#999}
.syncbtn{padding:8px 16px;border:0;border-radius:8px;background:#c8642d;color:#fff;font-size:14px;cursor:pointer}
.syncbtn:disabled{opacity:.55;cursor:default}
.syncstatus{margin-left:10px;font-size:13px;color:#888}
.insights{border:1px solid #e7d9c6}
.insight{padding:10px 12px;border-bottom:1px solid #f0ede5;border-left:3px solid transparent;margin-bottom:2px}.insight:last-child{border-bottom:0}
.insight.sev-flag{border-left-color:#c0392b;background:#fdf3f2}
.insight.sev-watch{border-left-color:#c98a00;background:#fdfaf2}
.insight.sev-info{border-left-color:#cfe7d6}
.acts{margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.acts button{font-size:12px;padding:4px 10px;border:1px solid #ddd;border-radius:14px;background:#fff;cursor:pointer}
.acts button:disabled{opacity:.4;cursor:default}
.acts .agree:hover{background:#e6f5ea;border-color:#1a8a3a}.acts .disagree:hover{background:#fdeaea;border-color:#c0392b}
.acts .ignore:hover{background:#f3f3f3}.reacted{font-size:11px;color:#1a8a3a;margin-left:4px}
.actbtn{font-size:13px;padding:7px 14px;border:1px solid #c8642d;border-radius:8px;background:#fff;color:#c8642d;cursor:pointer}.actbtn:hover{background:#c8642d;color:#fff}
.proposal{border:1px solid #e7d9c6;border-radius:8px;padding:10px 12px;margin-top:10px}
</style></head><body>
<h1>Endurance Coach</h1>
<div class="sub">as of ${today.assembledAt}</div>
<div class="card" style="display:flex;align-items:center">
  <button id="syncbtn" class="syncbtn" onclick="sync()">🔄 Sync latest data</button>
  <span id="syncstatus" class="syncstatus"></span>
</div>
<script>
async function sync(){
  var b=document.getElementById('syncbtn'), s=document.getElementById('syncstatus');
  b.disabled=true; b.textContent='Syncing…'; s.textContent='Pulling latest from AI Endurance + Garmin (~10s)…';
  try{ var r=await fetch('/refresh',{cache:'no-store'}); if(!r.ok) throw new Error('HTTP '+r.status);
    s.textContent='Done — reloading.'; location.reload(); }
  catch(e){ b.disabled=false; b.textContent='🔄 Sync latest data'; s.textContent='Sync failed: '+e+' (try again)'; }
}
</script>

${insights ? renderHeader(today, insights, decisions, garminDays) : ""}
${insights ? renderInsightsBox(insights) : ""}
${renderLastSession(today, insights)}

<div class="card"><h2>Ask your data</h2>
  <form id="askform" onsubmit="return ask(event)">
    <input id="q" placeholder="e.g. how were my long rides this month? am I overtraining?" autocomplete="off"
      style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box"/>
    <button style="margin-top:8px;padding:8px 16px;border:0;border-radius:8px;background:#c8642d;color:#fff;font-size:14px">Ask</button>
  </form>
  <div id="answer" style="margin-top:12px;font-size:14px;color:#333;white-space:pre-wrap"></div>
</div>
<script>
async function ask(e){e.preventDefault();var q=document.getElementById('q').value.trim();if(!q)return false;
  var a=document.getElementById('answer');a.textContent='Thinking…';
  try{var r=await fetch('/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:q})});
    var j=await r.json();a.textContent=j.answer||'(no answer)';}catch(err){a.textContent='Error: '+err;}
  return false;}
async function sessionFeedback(){
  var box=document.getElementById('sessionfb'); box.textContent='Analysing this session…';
  try{var r=await fetch('/session-feedback',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    var j=await r.json(); box.textContent=j.markdown||'(no feedback)';}catch(err){box.textContent='Error: '+err;}}
async function feedback(btn){
  var box=btn.closest('.insight');var reaction=btn.getAttribute('data-reaction');
  var key=box.getAttribute('data-key');var summary=box.getAttribute('data-summary');
  var span=box.querySelector('.reacted');span.textContent='…';
  try{await fetch('/insight-feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({key:key,reaction:reaction,summary:summary})});
    box.querySelectorAll('button').forEach(function(b){b.disabled=true;});
    span.textContent=reaction==='agree'?'✓ agreed':reaction==='disagree'?'✓ disagreed — hidden ~2wk':'✓ ignored — hidden ~2wk';
    if(reaction!=='agree'){box.style.opacity=0.5;}
  }catch(err){span.textContent='error';}
}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
async function actPlan(){
  var box=document.getElementById('proposals'); box.innerHTML='<div class="k">Drafting a plan change…</div>';
  try{var r=await fetch('/act',{method:'POST'}); var j=await r.json();
    if(!j.proposals||!j.proposals.length){box.innerHTML='<div class="k">'+esc(j.notes||'No change proposed.')+'</div>';return;}
    box.innerHTML=j.proposals.map(function(p){return '<div class="proposal" data-id="'+esc(p.id)+'"><b>'+esc(p.human||p.summary)+'</b>'
      +'<div class="fdetail">'+esc(p.summary)+'</div>'
      +'<div class="ev">trade-off: '+esc(p.tradeoff)+'</div>'
      +((p.basis&&p.basis.length)?'<div class="ev">because: '+esc(p.basis.join('; '))+'</div>':'')
      +'<div class="acts"><button class="agree" onclick="confirmProposal(this)">✓ Apply to AI Endurance</button>'
      +'<button class="ignore" onclick="declineProposal(this)">✕ Dismiss</button><span class="reacted"></span></div></div>';}).join('');
  }catch(e){box.innerHTML='<div class="k">Error: '+esc(''+e)+'</div>';}
}
async function confirmProposal(btn){var box=btn.closest('.proposal');var id=box.getAttribute('data-id');var s=box.querySelector('.reacted');s.textContent='Applying…';
  try{var r=await fetch('/confirm-proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})});var j=await r.json();
    box.querySelectorAll('button').forEach(function(b){b.disabled=true;});
    s.textContent=j.ok?'✓ applied to AI Endurance':'failed: '+esc(j.error||'');}catch(e){s.textContent='error';}}
async function declineProposal(btn){var box=btn.closest('.proposal');var id=box.getAttribute('data-id');var s=box.querySelector('.reacted');
  try{await fetch('/decline-proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})});
    box.querySelectorAll('button').forEach(function(b){b.disabled=true;});s.textContent='dismissed';box.style.opacity=0.5;}catch(e){s.textContent='error';}}
</script>

${insights ? renderSignals(insights) : ""}

<div class="card"><h2>This week — load by sport</h2>
  <table><tr class="k"><td>Sport</td><td>Sessions</td><td>Time</td><td>Distance</td></tr>${loadRows || '<tr><td colspan="4" class="muted">no activities</td></tr>'}</table>
</div>

<div class="card"><h2>Trends (last ${gar.length || 0} days)</h2>
  ${trendRows ? `<table>${trendRows}</table>` : '<div class="muted">Backfill the Garmin daily archive to populate trends (npm run backfill).</div>'}
  <div class="k" style="margin-top:8px">From the backfilled Garmin daily history.</div>
</div>

${renderZones(today)}

${renderScores(today)}

<div class="card"><h2>Race</h2>
  <table><tr class="k"><td>Event</td><td>Date</td><td>Countdown</td><td>Priority</td></tr>${raceRows || '<tr><td colspan="4" class="muted">no race goals</td></tr>'}</table>
</div>

${renderRacePredictions(today)}

${insights ? renderSplits(insights) : ""}

<div class="card"><h2>Recent decisions</h2>
  <table><tr class="k"><td>Kind</td><td>Status</td><td>Summary</td></tr>${recentDecisions || '<tr><td colspan="3" class="muted">none yet</td></tr>'}</table>
</div>
</body></html>`;
}

function fmt(n: number | null | undefined, d = 0): string {
  return n == null ? "—" : n.toFixed(d);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
