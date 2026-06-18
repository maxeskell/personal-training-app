import type { AthleteState, ActualActivity, PlannedSession, ZoneSet } from "../state/types.js";
import type { DecisionRecord, InsightReaction } from "../state/decisionLog.js";
import type { FitSummary } from "../archive/store.js";
import type { InsightReport } from "../insights/engine.js";
import { findingKey } from "../insights/metrics.js";
import { paceStr } from "../insights/zones.js";
import { coachHeadline, tsbBand, rampBand, type Tone } from "../insights/headline.js";
import { assembleSession } from "./session.js";
import { summarizeCost, type CostRecord } from "../llm/costLog.js";
import { weekday, type WeekWeather } from "../weather/assess.js";

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
  /** Saved like/dislike per finding key (latest wins) — renders the buttons in their persisted state. */
  reactions?: Map<string, InsightReaction>;
  /** First time each finding key was surfaced (insight-history log) — drives the age line + NEW badge. */
  firstSeen?: Map<string, string>;
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
  /** LLM cost-log records — drives the API-cost card. */
  costRecords?: CostRecord[];
  /** Archived .FIT thermal summaries — carry the Garmin activity id the stream auto-download needs. */
  fitSummaries?: FitSummary[];
  /** Whether the server can fetch a missing raw .FIT on demand (Garmin enabled). */
  canFetchFit?: boolean;
  /** Week-ahead weather joined to the upcoming plan (omitted when the forecast is unavailable). */
  weather?: WeekWeather;
  /**
   * Minutes since the snapshot was assembled, set ONLY when the server wants the page to kick a
   * background Sync on load (stale-while-revalidate). Leave unset for the one-off CLI HTML file,
   * which has no /refresh endpoint behind it.
   */
  autoSyncStaleMin?: number;
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

/** Age of an insight in whole days from its first-seen timestamp (or null if never logged before). */
function ageDays(firstSeenIso: string | undefined, now: number): number | null {
  if (!firstSeenIso) return null;
  return Math.floor((now - new Date(firstSeenIso).getTime()) / 86_400_000);
}

/** "first seen" line + a NEW badge for findings ≤1 day old (or first surfaced this very render). */
function ageLabel(firstSeenIso: string | undefined, now: number): { badge: string; line: string } {
  const days = ageDays(firstSeenIso, now);
  const isNew = days == null || days < 1;
  const badge = isNew ? `<span class="newbadge">NEW</span>` : "";
  // firstSeenIso is null only for a finding the log hasn't recorded yet (i.e. brand new this render).
  const line = !firstSeenIso
    ? `first seen just now`
    : `first seen ${escapeHtml(firstSeenIso.slice(0, 10))} · ${days === 0 ? "today" : `${days}d`}`;
  return { badge, line: `${line} · (age since logging began)` };
}

/**
 * Top-5 insights box. Each finding shows its SAVED like/dislike (👍/👎 toggle, click again to clear) plus a
 * Snooze that hides it for ~2 weeks; dislike stays visible (just down-ranked). A NEW badge + "first seen"
 * line flag freshness so a new signal isn't missed. Posts to /insight-feedback.
 */
function renderInsightsBox(ins: InsightReport, reactions?: Map<string, InsightReaction>, firstSeen?: Map<string, string>): string {
  const sevColor = (s: string) => (s === "flag" ? "#c0392b" : s === "watch" ? "#c98a00" : "#1a8a3a");
  const now = Date.now();
  const top = ins.topFindings.slice(0, 5);
  const newCount = top.filter((f) => (ageDays(firstSeen?.get(findingKey(f)), now) ?? 0) < 1).length;
  if (!top.length) return `<div class="card"><h2>Top insights</h2><div class="muted">No strong signals right now — nothing worth your attention today.</div></div>`;
  const rows = top
    .map((f) => {
      const key = findingKey(f);
      const conf = Math.round((f.confidence ?? 0.6) * 100);
      const saved = reactions?.get(key); // "agree" | "disagree" (snoozed items are suppressed, never here)
      const state = saved === "agree" ? "like" : saved === "disagree" ? "dislike" : "";
      const on = (which: string) => (state === which ? " on" : "");
      const { badge, line } = ageLabel(firstSeen?.get(key), now);
      return `<div class="insight sev-${f.severity}" data-key="${escapeHtml(key)}" data-summary="${escapeHtml(f.title)}" data-reaction-state="${state}">
        <div><span class="badge" style="background:${sevColor(f.severity)}">${f.severity}</span>${badge}
          <b style="${f.severity === "flag" ? "font-size:15px" : ""}">${escapeHtml(f.title)}</b> <span class="muted">· ${conf}% conf · ${escapeHtml(f.family)}</span></div>
        <div class="fdetail">${escapeHtml(f.detail)}</div>
        ${f.recommendation ? `<div class="ev">→ ${escapeHtml(f.recommendation)}</div>` : ""}
        <div class="ev">${escapeHtml(f.evidence)}</div>
        <div class="age">${line}</div>
        <div class="acts">
          <button class="agree${on("like")}" data-reaction="like" onclick="feedback(this)">👍 Like</button>
          <button class="disagree${on("dislike")}" data-reaction="dislike" onclick="feedback(this)">👎 Dislike</button>
          <button class="ignore" data-reaction="snooze" onclick="feedback(this)">💤 Snooze</button>
          <span class="reacted">${state === "like" ? "👍 liked" : state === "dislike" ? "👎 disliked (still shown)" : ""}</span>
        </div>
      </div>`;
    })
    .join("");
  const newNote = newCount ? ` · <b>${newCount} new</b>` : " · nothing new";
  return `<div class="card insights"><h2>Top insights — your call</h2>
    <div class="k" style="margin-bottom:8px">Ranked by signal strength${newNote}. Like/dislike is saved and reversible (dislike stays visible, just down-ranked); Snooze hides it for ~2 weeks.</div>
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

/** Find the planned session matching a date+sport anywhere in the trailing state window (newest first). */
function plannedFor(window: AthleteState[], date: string, sport: string): PlannedSession | undefined {
  for (let i = window.length - 1; i >= 0; i--) {
    const hit = (window[i].plannedSessions.value ?? []).find((p) => p.date.slice(0, 10) === date && p.sport === sport);
    if (hit) return hit;
  }
  return undefined;
}

/** "Last session" card: the most recent activity at a glance, what it was MEANT to be, + deep LLM feedback. */
function renderLastSession(window: AthleteState[], insights: InsightReport | undefined, fitSummaries?: FitSummary[], canFetchFit?: boolean): string {
  const today = window[window.length - 1];
  const d = assembleSession(today, insights, { decays: insights?.sessionDecays, fitSummaries });
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
  // What this session was meant to be (user ask) — the matching planned workout, with planned-vs-done time.
  const plan = plannedFor(window, d.date, d.sport);
  const planBits = plan
    ? [
        plan.title,
        plan.type && plan.type !== plan.title ? plan.type : "",
        plan.durationMin != null ? `${hMin(plan.durationMin)} planned${d.durationMin != null ? ` → ${hMin(d.durationMin)} done` : ""}` : "",
      ].filter(Boolean).join(" · ") || "planned session"
    : "";
  const planLine = plan
    ? `<div style="font-size:13px;color:#666;margin-bottom:10px">📋 Planned: <b>${escapeHtml(planBits)}</b></div>`
    : `<div class="k" style="margin-bottom:10px">📋 No planned workout matched this date/sport — unscheduled, or swapped from the plan.</div>`;
  // Deep feedback costs an LLM call and is only worth it with the raw .FIT joined in (user ask):
  // show the button when the stream is local OR the server can fetch it on demand (Garmin enabled +
  // the archive knows this activity's id); otherwise say exactly how to unlock it manually.
  const fetchable = !!canFetchFit && !!d.fit?.activityId;
  const deep = d.decay
    ? `<button class="actbtn" onclick="sessionFeedback()">🔍 Deep feedback on this session</button>`
    : fetchable
      ? `<button class="actbtn" onclick="sessionFeedback()">🔍 Deep feedback on this session</button> <span class="k">fetches this session's raw .FIT from Garmin first (~10s)</span>`
      : `<div class="k">🔍 Deep feedback unlocks when this session's raw .FIT is in data/fit-streams/ — it couldn't be fetched automatically (Garmin off, or no archived activity id yet — try Sync), so export it from Garmin Connect → activity → ⚙ → Export Original. Without the per-second stream there are no biomechanics to analyse and the LLM call is skipped.</div>`;
  return `<div class="card"><h2>Last session — ${d.date} ${d.sport}</h2>
    <div style="font-size:14px;margin-bottom:6px">${escapeHtml(bits)}</div>
    ${planLine}
    ${deep}
    <div id="sessionfb" style="margin-top:12px;font-size:14px;color:#333;white-space:pre-wrap"></div>
  </div>`;
}

const VERDICT_COLOR: Record<string, string> = { good: "#1a8a3a", marginal: "#c98a00", poor: "#c0392b", indoor: "#9a9a9a" };
const SPORT_EMOJI: Record<string, string> = { Swim: "🏊", Ride: "🚴", Run: "🏃", Strength: "🏋️" };

/** "Week ahead — plan vs weather": per-session verdicts + day outlook incl. estimated road dryness. */
function renderWeather(w: WeekWeather | undefined): string {
  if (!w) return "";
  const sessions = w.sessions.length
    ? w.sessions
        .map(
          (s) => `<div class="finding">
      <div><span class="badge" style="background:${VERDICT_COLOR[s.verdict] ?? "#777"}">${escapeHtml(s.verdict)}</span>
        <b>${escapeHtml(weekday(s.date))} · ${SPORT_EMOJI[s.sport] ?? ""} ${escapeHtml(s.sport)}</b>${s.title ? ` <span class="muted">· ${escapeHtml(s.title)}</span>` : ""}</div>
      <div class="fdetail">${escapeHtml(s.reason)}</div>
      ${s.suggestion ? `<div class="ev">→ ${escapeHtml(s.suggestion)}</div>` : ""}
    </div>`,
        )
        .join("")
    : `<div class="k" style="margin-bottom:6px">No outdoor sessions in the visible plan window — day outlook below.</div>`;
  const rows = w.days
    .map(
      (d) => `<tr>
      <td>${escapeHtml(weekday(d.date))}</td>
      <td>${escapeHtml(d.label)}</td>
      <td class="num">${Math.round(d.tempMinC)}–${Math.round(d.tempMaxC)}°</td>
      <td class="num">${d.precipSumMm ? d.precipSumMm.toFixed(1) + " mm" : "0"}${d.precipProbMaxPct != null ? ` · ${Math.round(d.precipProbMaxPct)}%` : ""}</td>
      <td class="num">${Math.round(d.gustMaxKmh)}</td>
      <td>${escapeHtml(d.roads)}</td>
      <td>${d.rideWindow ? `${d.rideWindow.from.slice(11, 16)}–${d.rideWindow.to.slice(11, 16)}` : '<span class="muted">—</span>'}</td>
    </tr>`,
    )
    .join("");
  const p2 = (n: number) => String(n).padStart(2, "0");
  const stamp = (iso: string) => {
    const d = new Date(iso);
    return `${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getDay()]} ${d.getDate()}, ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  };
  // Both timestamps are load-bearing: a deleted/edited workout keeps showing until the NEXT Sync,
  // so the card must say how fresh its plan snapshot is.
  const planNote = w.planAsOf ? `Plan as of ${stamp(w.planAsOf)} · ` : "";
  return `<div class="card"><h2>Week ahead — plan vs weather</h2>
    ${sessions}
    <table style="margin-top:8px"><tr class="k"><td>Day</td><td>Sky</td><td>°C</td><td>Rain</td><td>Gusts km/h</td><td>Roads</td><td>Ride window</td></tr>${rows}</table>
    <div class="k" style="margin-top:8px">${planNote}Open-Meteo forecast as of ${stamp(w.fetchedAt)} — Sync re-pulls both. "Roads" and ride windows are a MODEL drying estimate from rain, temperature, sun and wind — eyeball the tarmac before committing. Open-water temp has no public feed: set COACH_WATER_TEMP_C when the venue posts a reading.</div>
  </div>`;
}

/** API-cost card: windowed token spend + a monthly projection + the top flows. */
function renderCost(records: CostRecord[] | undefined): string {
  if (!records || !records.length) return "";
  const w7 = summarizeCost(records, 7).total;
  const w30 = summarizeCost(records, 30);
  const all = summarizeCost(records).total;
  const monthly = w7.calls ? (w7.costUsd / 7) * 30 : 0;
  const top = w30.byOperation.slice(0, 4).map((o) => `${o.operation} $${o.costUsd.toFixed(3)}`).join(" · ");
  return `<div class="card"><h2>API cost</h2>
    <div style="font-size:14px;margin-bottom:8px">7d <b>$${w7.costUsd.toFixed(3)}</b> · 30d <b>$${w30.total.costUsd.toFixed(3)}</b> · all <b>$${all.costUsd.toFixed(3)}</b> · ≈ <b>$${monthly.toFixed(2)}/mo</b> at the 7-day rate</div>
    ${top ? `<div class="k">last 30d by flow: ${escapeHtml(top)}</div>` : ""}
  </div>`;
}

/** Zones + FTP/threshold markers, grouped per discipline (swim / bike / run) for clear separation. */
function renderZones(today: AthleteState): string {
  const z = today.zones.value;
  const t = today.thresholds.value;
  if (!z && !t) return "";
  const markers = t
    ? [
        t.bikeFtpW != null ? `Bike FTP <b>${t.bikeFtpW} W</b>${t.bikeFtpWkg != null ? ` (${t.bikeFtpWkg} W/kg)` : ""}` : "",
        t.bikeThresholdHr != null ? `Bike LTHR <b>${t.bikeThresholdHr} bpm</b>` : "",
        t.runThresholdPowerW != null ? `Run FTP <b>${t.runThresholdPowerW} W</b>` : "",
        t.runThresholdPaceSecPerKm != null ? `Run threshold <b>${paceStr(t.runThresholdPaceSecPerKm)}/km</b>` : "",
        t.runThresholdHr != null ? `Run LTHR <b>${t.runThresholdHr} bpm</b>` : "",
        t.swimCssSecPer100 != null ? `Swim CSS <b>${paceStr(t.swimCssSecPer100)}/100m</b>` : "",
      ].filter(Boolean).join(" · ")
    : "";
  const ftpNote = t?.bikeFtpNote ? `<div style="font-size:12px;color:#b45309;margin-bottom:12px">⚠ ${t.bikeFtpNote}</div>` : "";
  const disc = (name: string, tables: string[]) => {
    const inner = tables.filter(Boolean).join("");
    return inner ? `<div class="disc"><div class="disch">${name}</div><div class="grid">${inner}</div></div>` : "";
  };
  const bikeHrNote =
    z?.bike?.hr && t?.bikeThresholdHr == null
      ? `<div class="k" style="margin-top:8px">Bike HR zones are derived from your run LTHR — bike LTHR typically sits a few bpm lower, so treat the zone tops conservatively.</div>`
      : "";
  return `<div class="card"><h2>Zones & thresholds</h2>
    ${markers ? `<div style="font-size:14px;margin-bottom:${ftpNote ? "4px" : "12px"}">${markers}</div>` : ""}
    ${ftpNote}
    ${disc("🏊 Swim", [zoneTable("Pace", z?.swim?.pace)])}
    ${disc("🚴 Bike", [zoneTable("Power", z?.bike?.power), zoneTable("HR", z?.bike?.hr)])}
    ${disc("🏃 Run", [zoneTable("Power", z?.run?.power), zoneTable("Pace", z?.run?.pace), zoneTable("HR", z?.run?.hr)])}
    ${bikeHrNote}
    <div class="k" style="margin-top:8px">Derived zones use standard models (Coggan power / %-LTHR / %-threshold pace). Threshold-pace MODEL estimates are trend-relative.</div>
  </div>`;
}

/**
 * Reconcile the power-duration-curve FTP estimate against the configured bike FTP so the dashboard's
 * two FTP figures don't read as an unexplained conflict. The MMP curve only sees power-equipped rides
 * and revises up only on hard, sustained power efforts, so with sparse power-meter riding the estimate
 * sits below the real/configured FTP — directional, not a downgrade (same root cause as the
 * `bikeFtpNote` Garmin-auto-detect gap). Returns null when there's nothing to explain: no configured
 * FTP, the estimate is at/above it, or the gap is within ~5% noise.
 */
export function ftpEstimateGapNote(configuredFtpW: number | undefined, estimateW: number | undefined): string | null {
  if (!configuredFtpW || configuredFtpW <= 0 || !estimateW || estimateW <= 0) return null;
  if (estimateW >= configuredFtpW) return null;
  const pct = Math.round((1 - estimateW / configuredFtpW) * 100);
  if (pct < 5) return null;
  return `${pct}% under your configured ${configuredFtpW} W FTP — the curve only sees power-equipped rides and revises up on hard sustained efforts, so read it as a floor, not a downgrade. Zones use the ${configuredFtpW} W figure.`;
}

/** Garmin model scores: endurance score, hill score, and the power-duration curve (MMP). */
function renderScores(today: AthleteState): string {
  const e = today.enduranceScore.value;
  const h = today.hillScore.value;
  const p = today.powerCurve.value;
  if (!e && !h && !p) return "";
  const ftpGap = ftpEstimateGapNote(today.thresholds.value?.bikeFtpW, p?.ftpEstimateW);
  const mmpRows = p?.bests?.length
    ? `<table style="margin-top:8px"><tr class="k"><td>Duration</td><td>Best</td><td>Set on</td></tr>${p.bests
        .map((b) => `<tr><td>${escapeHtml(b.duration)}</td><td class="num">${b.watts} W</td><td class="muted">${b.date ? escapeHtml(String(b.date).slice(0, 10)) : "—"}</td></tr>`)
        .join("")}</table>`
    : "";
  return `<div class="card"><h2>Garmin scores</h2>
    <div class="grid">
      ${e ? `<div><div class="k">Endurance score</div><div class="v">${e.current ?? "—"}</div><div class="k">${escapeHtml(e.classification ?? "")}${e.nextThresholdGap != null ? ` · ${e.nextThresholdGap} to ${escapeHtml((e.nextThresholdLabel ?? "").replace(/_/g, " "))}` : ""}</div></div>` : ""}
      ${h ? `<div><div class="k">Hill score</div><div class="v">${h.overall ?? "—"}</div><div class="k">str ${h.strength ?? "—"} / end ${h.endurance ?? "—"}</div></div>` : ""}
      ${p?.ftpEstimateW != null ? `<div><div class="k">FTP estimate</div><div class="v">${p.ftpEstimateW} W</div><div class="k">${p.activitiesAnalyzed ?? "?"} activities</div></div>` : ""}
    </div>
    ${mmpRows}
    ${ftpGap ? `<div style="font-size:12px;color:#b45309;margin-top:8px">⚠ FTP estimate is ${ftpGap}</div>` : ""}
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

/** Estimated race splits dependent on training: a finish-time RANGE + per-segment pacing. */
function renderSplits(ins: InsightReport): string {
  if (!ins.splits.length) return "";
  const blocks = ins.splits
    .map((p) => {
      const rows = p.segments
        .map((s) => `<tr><td>${escapeHtml(s.label)}</td><td class="num">${s.target ? escapeHtml(s.target) : `${paceStr(s.targetPaceSecPerKm)}/km`}</td><td class="num">${hms(s.cumulativeSec)}</td></tr>`)
        .join("");
      // Date + countdown at the top.
      const dTo = p.date ? daysTo(ins.date, p.date) : null;
      const when = p.date ? ` <span class="muted">· ${escapeHtml(p.date)}${dTo != null && dTo >= 0 ? ` · ${dTo}d to go` : ""}</span>` : "";
      // Finish RANGE: best (race day) → worst (race today), rounded to the minute.
      const worst = p.worstSec ?? p.predictedSec;
      const hasRange = p.bestSec != null && p.bestSec < worst;
      const finish = hasRange
        ? `<b style="font-size:16px">${clockMin(p.bestSec!)} – ${clockMin(worst)}</b> <span class="muted">over ${p.distanceKm} km — race-day best → race-it-today</span>`
        : `<b style="font-size:16px">~${clockMin(worst)}</b> <span class="muted">over ${p.distanceKm} km (current level)</span>`;
      const basis = p.rangeBasis ? `<div class="ev" style="margin:3px 0">${escapeHtml(p.rangeBasis)}</div>` : "";
      return `<div style="margin-bottom:16px">
        <div style="font-size:15px"><b>${escapeHtml(p.race)}</b>${when}</div>
        <div style="margin:5px 0">${finish}</div>
        ${basis}
        <div class="ev" style="margin:4px 0">Pacing for the current prediction — ${escapeHtml(p.strategy)}</div>
        <table><tr class="k"><td>Segment</td><td>Target</td><td>Cumulative</td></tr>${rows}</table>
      </div>`;
    })
    .join("");
  return `<div class="card"><h2>Estimated race splits</h2>${blocks}
    <div class="k">Run races build from AI Endurance's predicted finish shaped by your durability trend; triathlon legs are modelled from your current CSS / FTP / run predictions at standard race intensities. <b>A MODEL — a range and a pacing plan, not a guarantee.</b></div>
    ${raceGlossary()}
  </div>`;
}

function hms(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Race finish rounded to the nearest minute (a projection isn't second-accurate): "1:38" or "38 min". */
function clockMin(sec: number): string {
  const totalMin = Math.round(sec / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}` : `${m} min`;
}

/** A small, collapsible glossary of the jargon on the race cards (static text — no interpolation). */
function raceGlossary(): string {
  const terms: Array<[string, string]> = [
    ["Range", "best case = race day if the build goes well; worst = racing at today's fitness"],
    ["Negative split", "running the second half slightly faster than the first"],
    ["Durability", "how little your pace/power fades late in long efforts — fatigue resistance"],
    ["CSS", "Critical Swim Speed — the swim pace you can hold, per 100m"],
    ["FTP", "Functional Threshold Power — the cycling power you can hold for ~an hour"],
    ["TSB", "Training Stress Balance (“form”) — freshness vs fatigue"],
  ];
  return `<details style="margin-top:8px"><summary style="cursor:pointer;font-size:12px;color:#888">What these terms mean</summary>
    <div class="k" style="margin-top:6px;line-height:1.6">${terms.map(([t, d]) => `<div><b>${t}</b> — ${d}</div>`).join("")}</div></details>`;
}

/** Minutes → "1h 35m" / "45m" (user ask: weekly totals in hours+minutes, not raw minutes). */
function hMin(totalMin: number): string {
  const t = Math.round(totalMin);
  const h = Math.floor(t / 60);
  const m = t % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
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

export function renderDashboard({ window, decisions, insights, reactions, firstSeen, garminDays, costRecords, fitSummaries, canFetchFit, weather, autoSyncStaleMin }: DashboardInput): string {
  const today = window[window.length - 1];

  // Week: load by sport. Time in h:mm (user ask); a zero distance renders "—" not a misleading 0.0 km.
  const load = activitiesLast7(today);
  const loadRows = [...load.entries()]
    .map(([s, e]) => `<tr><td>${s}</td><td>${e.n}</td><td>${hMin(e.min)}</td><td>${e.km > 0 ? `${e.km.toFixed(1)} km` : '<span class="muted">—</span>'}</td></tr>`)
    .join("");

  // Trends from the backfilled Garmin daily series (the multi-week archive), not the 1-day state store.
  const gar = (garminDays ?? []).slice(-42);
  const garRow = (label: string, pick: (d: NonNullable<DashboardInput["garminDays"]>[number]) => number | null | undefined, dec = 0) => {
    const vals = gar.map(pick);
    if (vals.filter((v) => v != null).length < 2) return "";
    const last = [...vals].reverse().find((v) => v != null);
    return `<tr><td>${label}</td><td>${spark(vals)}</td><td class="num">${last == null ? "—" : last.toFixed(dec)}</td></tr>`;
  };
  // Sleep score only — the hours sparkline tracked it near-identically (user ask: drop the duplicate).
  const trendRows = [
    garRow("HRV (ms)", (d) => d.hrvMs),
    garRow("Resting HR", (d) => d.restingHr),
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
.disc{border-top:2px solid #f0ede5;margin-top:12px;padding-top:10px}.disc:first-of-type{border-top:0;margin-top:0;padding-top:0}
.disch{font-size:13px;font-weight:600;color:#555;margin-bottom:6px}
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
.acts .agree.on{background:#e6f5ea;border-color:#1a8a3a;font-weight:600}.acts .disagree.on{background:#fdeaea;border-color:#c0392b;font-weight:600}
.newbadge{background:#1558d6;color:#fff;font-size:9px;font-weight:700;letter-spacing:.04em;padding:1px 6px;border-radius:9px;margin-right:6px;vertical-align:middle}
.age{font-size:11px;color:#bbb;margin-top:4px}
.actbtn{font-size:13px;padding:7px 14px;border:1px solid #c8642d;border-radius:8px;background:#fff;color:#c8642d;cursor:pointer}.actbtn:hover{background:#c8642d;color:#fff}
code{background:#f4f1ea;border-radius:4px;padding:0 4px;font-size:13px}
.proposal{border:1px solid #e7d9c6;border-radius:8px;padding:10px 12px;margin-top:10px}
/* Print / Save-as-PDF: a clean one-document capture — hide interactive controls, keep cards intact, open the glossaries. */
@media print {
  body{background:#fff}
  .card{break-inside:avoid;box-shadow:none;border:1px solid #ddd}
  .acts, .syncbtn, .actbtn, button, #ask, #proposals{display:none !important}
  details{display:block}
  details > summary{display:none}
  a{color:inherit;text-decoration:none}
}
</style></head><body>
<h1>Endurance Coach</h1>
<div class="sub">as of ${today.assembledAt}</div>
<div class="card" style="display:flex;align-items:center">
  <button id="syncbtn" class="syncbtn" onclick="sync()">🔄 Sync latest data</button>
  <span id="syncstatus" class="syncstatus"></span>
</div>
<script>
async function sync(note){
  var b=document.getElementById('syncbtn'), s=document.getElementById('syncstatus');
  b.disabled=true; b.textContent='Syncing…'; s.textContent=(note?note+' ':'')+'Pulling latest from AI Endurance + Garmin (~10s)…';
  try{ var r=await fetch('/refresh',{cache:'no-store'}); if(!r.ok) throw new Error('HTTP '+r.status);
    s.textContent='Done — reloading.'; location.reload(); }
  catch(e){ b.disabled=false; b.textContent='🔄 Sync latest data'; s.textContent='Sync failed: '+e+' (try again)'; }
}
function autoSync(min){ sync('Data is '+min+' min old — auto-refreshing:'); }
</script>

${insights ? renderHeader(today, insights, decisions, garminDays) : ""}
${insights ? renderInsightsBox(insights, reactions, firstSeen) : ""}
${renderLastSession(window, insights, fitSummaries, canFetchFit)}

<div class="card"><h2>Ask your data</h2>
  <form id="askform" onsubmit="return ask(event)">
    <input id="q" placeholder="e.g. how were my long rides this month? am I overtraining?" autocomplete="off"
      style="width:100%;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:14px;box-sizing:border-box"/>
    <button style="margin-top:8px;padding:8px 16px;border:0;border-radius:8px;background:#c8642d;color:#fff;font-size:14px">Ask</button>
  </form>
  <div id="answer" style="margin-top:12px;font-size:14px;color:#333;white-space:pre-wrap"></div>
</div>
<script>
function mdToHtml(md){
  var h=esc(String(md));
  h=h.replace(/^#{1,3} (.*)$/gm,'<b style="font-size:15px">$1</b>');
  h=h.replace(/\\*\\*([^*\\n]+)\\*\\*/g,'<b>$1</b>');
  h=h.replace(/(^|[\\s(])\\*([^*\\n]+)\\*(?=[\\s).,;:!?]|$)/g,'$1<i>$2</i>');
  h=h.replace(/\`([^\`\\n]+)\`/g,'<code>$1</code>');
  h=h.replace(/^- /gm,'• ');
  return h;
}
async function ask(e){e.preventDefault();var q=document.getElementById('q').value.trim();if(!q)return false;
  var a=document.getElementById('answer');a.textContent='Thinking…';
  try{var r=await fetch('/ask',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({question:q})});
    var j=await r.json();a.innerHTML=mdToHtml(j.answer||'(no answer)');}catch(err){a.textContent='Error: '+err;}
  return false;}
async function sessionFeedback(){
  var box=document.getElementById('sessionfb'); box.textContent='Analysing this session… (fetching the .FIT first if needed)';
  try{var r=await fetch('/session-feedback',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
    var j=await r.json(); box.innerHTML=mdToHtml(j.markdown||'(no feedback)');}catch(err){box.textContent='Error: '+err;}}
function setReactionState(box,state){
  box.setAttribute('data-reaction-state',state);
  var like=box.querySelector('.agree');var dislike=box.querySelector('.disagree');
  like.classList.toggle('on',state==='like');dislike.classList.toggle('on',state==='dislike');
}
async function feedback(btn){
  var box=btn.closest('.insight');var want=btn.getAttribute('data-reaction'); // like|dislike|snooze
  var cur=box.getAttribute('data-reaction-state')||'';
  // Clicking the active like/dislike again clears it (back to neutral); snooze is always a hide action.
  var send=(want!=='snooze'&&cur===want)?'clear':want;
  var key=box.getAttribute('data-key');var summary=box.getAttribute('data-summary');
  var span=box.querySelector('.reacted');span.textContent='…';
  try{await fetch('/insight-feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({key:key,reaction:send,summary:summary})});
    if(send==='snooze'){box.querySelectorAll('button').forEach(function(b){b.disabled=true;});box.style.opacity=0.5;span.textContent='💤 snoozed — hidden ~2wk';return;}
    if(send==='clear'){setReactionState(box,'');span.textContent='cleared';return;}
    setReactionState(box,send);span.textContent=send==='like'?'👍 liked':'👎 disliked (still shown)';
  }catch(err){span.textContent='error';}
}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
async function actPlan(){
  var box=document.getElementById('proposals'); box.innerHTML='<div class="k">Drafting a plan change…</div>';
  try{var r=await fetch('/act',{method:'POST'}); var j=await r.json();
    if(!j.proposals||!j.proposals.length){box.innerHTML='<div class="k">'+esc(j.notes||'No change proposed.')+'</div>';return;}
    box.innerHTML=j.proposals.map(function(p){return '<div class="proposal" data-id="'+esc(p.id)+'"><b>'+esc(p.human||p.summary)+'</b>'
      +'<div class="k">✓ exact change, validated against your real plan — this is what gets written</div>'
      +'<div class="fdetail">'+esc(p.summary)+'</div>'
      +'<div class="ev">trade-off: '+esc(p.tradeoff)+'</div>'
      +((p.basis&&p.basis.length)?'<div class="ev">because: '+esc(p.basis.join('; '))+'</div>':'')
      +'<div class="ev" style="color:#bbb">the bold line is validated; the rationale above is AI-generated — read the bold line before applying</div>'
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

${renderWeather(weather)}

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

${renderCost(costRecords)}
${autoSyncStaleMin != null ? `<script>autoSync(${Math.round(autoSyncStaleMin)})</script>` : ""}
</body></html>`;
}

function fmt(n: number | null | undefined, d = 0): string {
  return n == null ? "—" : n.toFixed(d);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
