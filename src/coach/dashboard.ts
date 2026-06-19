import type { AthleteState, ActualActivity, PlannedSession, ZoneSet } from "../state/types.js";
import type { DecisionRecord, InsightReaction } from "../state/decisionLog.js";
import type { FitSummary } from "../archive/store.js";
import type { SessionFeedbackRecord } from "./sessionFeedbackStore.js";
import type { InsightReport } from "../insights/engine.js";
import { findingKey } from "../insights/metrics.js";
import { detectMetricChanges } from "./metricChanges.js";
import { selectMarginalGains } from "../insights/marginalGains.js";
import { paceStr } from "../insights/zones.js";
import { coachHeadline, tsbBand, rampBand, type Tone, type Headline } from "../insights/headline.js";
import { assembleSession } from "./session.js";
import type { Profile } from "../profile/schema.js";
import { PROFILE_QUESTIONS, WAYS_TO_ANSWER, type ProfileQuestion } from "../profile/questions.js";
import { summarizeCost, type CostRecord } from "../llm/costLog.js";
import { weekday, type WeekWeather } from "../weather/assess.js";
import { assessHealthRisk, type HealthRiskAssessment } from "../guardrails/wellbeing.js";

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
   * The athlete profile (loaded best-effort) — drives the "Set up & improve" card from its actionable
   * `ai_endurance_todo` gaps, `open_items`, and any unfilled profile questions. Omitted/absent → the
   * card is simply not shown. NOT persisted in snapshots, so the render paths load it explicitly rather
   * than read it off state.
   */
  profile?: Profile;
  /**
   * Share/redacted view (for screenshots): hides the identifying bits — real race names + dates and the
   * location-revealing weather card — while keeping the analysis/trends shape. The health metrics shown
   * (HRV/RHR/sleep/VO2max) aren't identifying; weight/body-comp aren't on the dashboard at all.
   */
  share?: boolean;
  /**
   * Minutes since the snapshot was assembled, set ONLY when the server wants the page to kick a
   * background Sync on load (stale-while-revalidate). Leave unset for the one-off CLI HTML file,
   * which has no /refresh endpoint behind it.
   */
  autoSyncStaleMin?: number;
  /**
   * Keys the athlete snoozed within the cool-off window (same set used to suppress insights). Lets the
   * "Set up & improve" card drop items dismissed via its ✕ control. Omitted → nothing is suppressed.
   */
  suppressed?: Set<string>;
  /**
   * Latest persisted weekly review (from `reports/`): its date + the action bullets parsed from the
   * "## Next week" section. Feeds the "This week" group with real, as-of-tagged actions (falling back to
   * a "revisit the review" pointer when there's no parseable section); drops when stale. Read-only — the
   * card never re-runs the (LLM) weekly flow.
   */
  weeklyReview?: { date: string; actions: string[] };
  /**
   * Latest persisted research digest (from `knowledge/pending/`): its date + the topic headlines parsed
   * from the markdown. Feeds the "Worth considering" group as-of-tagged items; drops when stale. Read
   * only — the card never re-runs the (LLM + web-search) research flow.
   */
  researchDigest?: { date: string; topics: string[] };
  /**
   * Tool/integration health (computed in the IO layer): drives operational "Finish setup" nudges — a
   * missing API key, a long-stale sync, an unset open-water temperature.
   */
  setupHealth?: { lastSyncAgeHours?: number; hasApiKey?: boolean; waterTempSet?: boolean };
  /** Clock for deterministic "as of N days ago" staleness (defaults to Date.now()); injectable in tests. */
  now?: number;
  /**
   * Persisted deep session-feedback records — the "Last session" card shows the one matching the latest
   * session inline (no LLM on render, no button). Auto-generated at sync; absent → a "generates next sync"
   * note. Read-only here.
   */
  sessionFeedbacks?: SessionFeedbackRecord[];
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
function renderInsightsBox(ins: InsightReport, reactions?: Map<string, InsightReaction>, firstSeen?: Map<string, string>, leadKey?: string): string {
  const sevColor = (s: string) => (s === "flag" ? "#c0392b" : s === "watch" ? "#c98a00" : "#1a8a3a");
  const now = Date.now();
  const top = ins.topFindings.slice(0, 5);
  const newCount = top.filter((f) => (ageDays(firstSeen?.get(findingKey(f)), now) ?? 0) < 1).length;
  if (!top.length) return `<div class="card"><h2>Top insights</h2><div class="muted">No strong signals right now — nothing worth your attention today.</div></div>`;
  // The lead finding is already the "Today" headline + action above, so here we keep it reactable but
  // drop its recommendation line (no verbatim repeat) and mark it as the call shown up top.
  const headlineInTop = leadKey != null && top.some((f) => findingKey(f) === leadKey);
  const rows = top
    .map((f) => {
      const key = findingKey(f);
      const isLead = key === leadKey;
      const conf = Math.round((f.confidence ?? 0.6) * 100);
      const saved = reactions?.get(key); // "agree" | "disagree" (snoozed items are suppressed, never here)
      const state = saved === "agree" ? "like" : saved === "disagree" ? "dislike" : "";
      const on = (which: string) => (state === which ? " on" : "");
      const { badge, line } = ageLabel(firstSeen?.get(key), now);
      return `<div class="insight sev-${f.severity}" data-key="${escapeHtml(key)}" data-summary="${escapeHtml(f.title)}" data-reaction-state="${state}">
        <div><span class="badge" style="background:${sevColor(f.severity)}">${f.severity}</span>${badge}
          <b style="${f.severity === "flag" ? "font-size:15px" : ""}">${escapeHtml(f.title)}</b> <span class="muted">· ${conf}% conf · ${escapeHtml(f.family)}${isLead ? ` · today's call ↑` : ""}</span></div>
        <div class="fdetail">${escapeHtml(f.detail)}</div>
        ${f.recommendation && !isLead ? `<div class="ev">→ ${escapeHtml(f.recommendation)}</div>` : ""}
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
    <div class="k" style="margin-bottom:8px">Ranked by signal strength${newNote}.${headlineInTop ? " Today's headline call is the one marked ↑." : ""} Like/dislike is saved and reversible (dislike stays visible, just down-ranked); Snooze hides it for ~2 weeks.</div>
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
/**
 * Minimal, escape-FIRST markdown → HTML for stored feedback rendered server-side (mirrors the client
 * `mdToHtml`): headers, bold, inline code, bullets. Everything is escaped before any formatting, so
 * injected markup can't break out (dashboard escaping convention). Pure.
 */
export function mdLite(md: string): string {
  let h = escapeHtml(md);
  h = h.replace(/^#{1,3} (.*)$/gm, '<b style="font-size:15px">$1</b>');
  h = h.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  h = h.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  h = h.replace(/^- /gm, "• ");
  return h;
}

/**
 * Which state the "Last session" feedback area renders, given what's locally available. Pure — the
 * testable core of the card's "show stored / fetch live / honest note" decision (see renderLastSession):
 *  - `stored`     a persisted deep dive exists → render it inline (no network, no LLM).
 *  - `auto`       it can be produced now → render a live placeholder that fetches on page load and swaps
 *                 the result in. `needsDownload` = the raw .FIT isn't local yet but is fetchable, so the
 *                 fetch downloads it first (the card says "Downloading…" vs "Generating…").
 *  - `manual`     no local .FIT and no automatic way to get one → tell the athlete to export it.
 *  - `no-api-key` generation is impossible without the key → say so rather than imply it's coming.
 */
export type SessionFeedbackCardState =
  | { kind: "stored" }
  | { kind: "auto"; needsDownload: boolean }
  | { kind: "manual" }
  | { kind: "no-api-key" };

export function sessionFeedbackCardState(opts: {
  hasStored: boolean;
  hasApiKey: boolean;
  hasLocalFit: boolean;
  canFetchFit: boolean;
  hasActivityId: boolean;
}): SessionFeedbackCardState {
  if (opts.hasStored) return { kind: "stored" };
  if (!opts.hasApiKey) return { kind: "no-api-key" };
  if (opts.hasLocalFit) return { kind: "auto", needsDownload: false };
  if (opts.canFetchFit && opts.hasActivityId) return { kind: "auto", needsDownload: true };
  return { kind: "manual" };
}

function renderLastSession(
  window: AthleteState[],
  insights: InsightReport | undefined,
  fitSummaries?: FitSummary[],
  canFetchFit?: boolean,
  sessionFeedbacks?: SessionFeedbackRecord[],
  hasApiKey?: boolean,
  share?: boolean,
): string {
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
  // Deep feedback is persisted (auto-generated at sync) and shown inline — no LLM on render. When it's
  // not stored yet, the card reflects the LIVE state instead of a static "on the next sync" line: if we
  // can produce it now it renders a placeholder + fetches it on load (downloading the raw .FIT first when
  // needed); otherwise it says exactly why it can't (no key, or no .FIT and no way to fetch one). The
  // stored markdown leads with its own H1 — strip it (the card heading already names the session).
  const stored = (sessionFeedbacks ?? [])
    .filter((f) => f.date === d.date)
    .sort((a, b) => b.generatedAt.localeCompare(a.generatedAt))[0];
  const cardState = sessionFeedbackCardState({
    hasStored: !!stored,
    hasApiKey: !!hasApiKey,
    hasLocalFit: !!d.decay,
    canFetchFit: !!canFetchFit,
    hasActivityId: !!d.fit?.activityId,
  });
  let feedback: string;
  switch (cardState.kind) {
    case "stored":
      feedback = `<div class="k" style="margin:8px 0 4px">🔍 Session feedback <span class="muted">(${stored.deep ? "deep analysis" : "summary"} · ${escapeHtml(fmtSince(Date.now() - new Date(stored.generatedAt).getTime()))})</span></div>
      <div style="font-size:14px;color:#333;white-space:pre-wrap">${mdLite(stored.markdown.replace(/^# .*\n+/, ""))}</div>`;
      break;
    case "auto":
      // A screenshot can't run the fetch (and would freeze on "Downloading…"), so share view degrades to
      // a static line; the live page renders the placeholder the on-load loadSessionFeedback() swaps out.
      feedback = share
        ? `<div class="k">🔍 Deep feedback generates automatically on sync.</div>`
        : `<div id="sessfb" data-date="${escapeHtml(d.date)}"><div class="k">🔍 ${escapeHtml(
            cardState.needsDownload
              ? "Downloading this session's .FIT and generating deep feedback…"
              : "Generating deep feedback for this session…",
          )} <span class="muted">this runs once, then it's saved.</span></div></div>`;
      break;
    case "no-api-key":
      feedback = `<div class="k">🔍 Deep feedback needs ANTHROPIC_API_KEY set on the server — once it is, it generates automatically.</div>`;
      break;
    default: // "manual"
      feedback = `<div class="k">🔍 No raw .FIT for this session and no automatic way to fetch it (Garmin off, an old garmin_mcp build, or no archived activity id). Export it from Garmin Connect → activity → ⚙ → Export Original into data/fit-streams/ and it'll be analysed on the next sync.</div>`;
      break;
  }
  return `<div class="card"><h2>Last session — ${d.date} ${d.sport}</h2>
    <div style="font-size:14px;margin-bottom:6px">${escapeHtml(bits)}</div>
    ${planLine}
    ${feedback}
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

/** Heading for the Garmin trends card. A single snapshot (or none) can't trend, so below 2 days we drop
 *  the "(last N days)" suffix rather than print a nonsensical "(last 0 days)" / ungrammatical "1 days". */
export function trendsHeading(days: number): string {
  return days >= 2 ? `Trends (last ${days} days)` : "Trends";
}

// Friendly copy for the recognised `ai_endurance_todo` keys; unknown keys fall back to a title-cased
// label and (for status tokens) a generic note, so a new key still renders sensibly.
const AIE_TODO_LABELS: Record<string, string> = {
  swim_css: "Set your swim CSS",
  ftp_w: "Resolve your cycling FTP",
};
const AIE_TODO_WHY: Record<string, string> = {
  swim_css: "without it there's no swim model for your races — the highest-value fix for a triathlete",
  ftp_w: "your power sources disagree, so bike zones and race predictions stay uncertain until reconciled",
};
const AIE_TODO_STATUS = new Set(["not_set", "unresolved", "todo", "missing", "none", "pending", "unset"]);

// Self-serve "how to do it" for the recognised AIE gaps (shown in the item's dropdown); unknown keys
// fall back to the generic line.
const AIE_TODO_ACTION: Record<string, string> = {
  swim_css:
    "In AI Endurance: Profile → Thresholds → set your swim CSS (critical swim speed — pace per 100m from a recent CSS test, or estimate it from a 400m + 200m time-trial). It syncs back on the next ↻ Sync and unlocks the swim model + race splits.",
  ftp_w:
    "In AI Endurance: reconcile your cycling FTP (Settings → Thresholds) so the auto-detected and test-based figures agree — the coach uses that one number for bike zones and race predictions. ↻ Sync afterwards.",
};
const AIE_TODO_ACTION_FALLBACK = "Set this directly in AI Endurance, then hit ↻ Sync so the coach reads the new value.";

// Self-serve action copy for the non-AIE sources (shown in each item's dropdown).
const OPEN_ITEM_ACTION =
  "A free-text note you (or the coach) logged. Do it, then clear it — remove the line from `open_items` in profile.local.yaml, or ask Claude to update your profile.";
const WEEKLY_ITEM_ACTION =
  "From your latest weekly review (saved under reports/, …-weekly-review.md). Open that report for the full reasoning, or ask the coach to expand on it.";
const RESEARCH_ITEM_ACTION =
  "From your latest research digest (knowledge/pending/). Review it; to adopt it into the coach's priors run `npm run knowledge -- approve <file>`, or ask the coach what it means for you. A prompt to weigh — your own data outranks the textbook.";
/** Proposed action for an unfilled profile question: the field + the canonical three ways to answer. */
function questionAction(q: ProfileQuestion): string {
  return `Fills \`${q.field}\` in your profile. Three ways:\n• ${WAYS_TO_ANSWER.join("\n• ")}`;
}

/**
 * `ai_endurance_todo` keys that aren't actionable ANYWHERE, so they must never reach the card (issue
 * #112: only surface items you can actually do something about). AI Endurance has no field for per-race
 * target times — they live in `profile.races[].target_time`, which the coach already reads — so a
 * `race_targets` nag would point at a setting that can't be set.
 */
const NON_ACTIONABLE_AIE = new Set(["race_targets"]);

/** Map one `ai_endurance_todo` entry to a display label + a why-it-matters note. A status token
 *  ("not_set"/"unresolved"/…) uses the curated note; any other value is itself the descriptive note. */
export function aieTodoCopy(key: string, value: string): { label: string; why: string } {
  const label = AIE_TODO_LABELS[key] ?? key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const isStatus = AIE_TODO_STATUS.has(value.trim().toLowerCase());
  const why = isStatus ? (AIE_TODO_WHY[key] ?? "needs setting in AI Endurance") : value.trim();
  return { label, why };
}

/** Where an item is actioned — shown as a tag so the source can be trusted/weighted at a glance. */
export type SetupRoute = "in AI Endurance" | "edit profile" | "discuss with coach" | "in your setup";

/** The three sections of the card (issue #112). Finish setup first, then time-bound advice. */
export type SetupGroup = "finish_setup" | "this_week" | "worth_considering";

/** Which producer an item came from (used for tagging, dedupe ordering and the dismissal key). */
export type SetupSource = "ai_endurance" | "open_item" | "profile_question" | "tune" | "weekly" | "research" | "health" | "race";

/** One actionable item on the "Set up & improve" card, tagged by its source and where to act on it. */
export interface SetupItem {
  /**
   * Stable per-item key (`setup:<tag>:<id>`) used to persist a dismissal in the SAME decision-log
   * machinery as insight feedback. Derived from the item's IDENTITY (todo key / field / finding key /
   * normalised text), not its display copy, so rewording a `why` doesn't lose a dismissal. The `setup:`
   * namespace keeps these distinct from insight finding keys in the shared log.
   */
  key: string;
  /** Short title / the action. */
  label: string;
  /** One line: why it's worth doing (or, for a free-text open item, empty). */
  why: string;
  /** Which producer surfaced it — used for tagging + dedupe ordering. */
  source: SetupSource;
  /** Which section of the card it belongs to. */
  group: SetupGroup;
  /** Where the athlete actions it. */
  route: SetupRoute;
  /** Self-serve "how to do it" — the concrete proposed action shown in the item's expandable dropdown. */
  action: string;
  /** Ranking weight (higher = surfaces first); the per-group cap keeps the highest-value items. */
  priority: number;
}

/** Stable dismissal key for a setup item — namespaced (by source tag) so it never collides with an insight key. */
const SOURCE_TAG: Record<SetupSource, string> = {
  ai_endurance: "aie",
  open_item: "open",
  profile_question: "q",
  tune: "tune",
  weekly: "weekly",
  research: "research",
  health: "health",
  race: "race",
};
function setupKey(source: SetupSource, id: string): string {
  return `setup:${SOURCE_TAG[source]}:${id}`;
}

/** Per-group caps keep the hub calm: a handful of setup gaps, a couple of timely nudges. */
const GROUP_CAP: Record<SetupGroup, number> = { finish_setup: 5, this_week: 3, worth_considering: 2 };

/** Persisted-report freshness windows: an item drops once its source report is older than this. */
const WEEKLY_FRESH_DAYS = 10; // weekly review / tune cadence
const RESEARCH_FRESH_DAYS = 45; // monthly research digest

/** Whole days from a YYYY-MM-DD report date to `now` (negative clamped to 0 for a future-dated file). */
function ageDaysFrom(date: string, now: number): number | null {
  const t = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / 86_400_000));
}

/** "as of today" / "as of 3d ago" — the freshness tag the issue asks every time-bound item to carry. */
function asOf(ageDays: number): string {
  return ageDays <= 0 ? "as of today" : `as of ${ageDays}d ago`;
}

const SOURCE_LABEL: Record<string, string> = { "ai-endurance": "AI Endurance", garmin: "Garmin", intervals: "intervals.icu", derived: "derived", manual: "you" };

/**
 * "Data changes — your call": when AI Endurance / Garmin have changed an auto-detected number (FTP,
 * threshold HR/pace, swim CSS, VO₂max), surface it with 👍 agree / 👎 disagree / 💤 snooze — reusing the
 * insight-feedback machinery (same keys, same `feedback()` handler, same snooze cool-off). Detected by
 * diffing the snapshot window; no LLM. Snoozed changes are hidden; a saved agree/disagree is shown.
 * Omitted when nothing changed recently.
 */
function renderDataChanges(window: AthleteState[], reactions?: Map<string, InsightReaction>, suppressed?: Set<string>, now?: number): string {
  const changes = detectMetricChanges(window, { now }).filter((c) => !suppressed?.has(c.key)).slice(0, 5);
  if (!changes.length) return "";
  const rows = changes
    .map((c) => {
      const saved = reactions?.get(c.key); // "agree" | "disagree" (snoozed are filtered out above)
      const state = saved === "agree" ? "like" : saved === "disagree" ? "dislike" : "";
      const on = (which: string) => (state === which ? " on" : "");
      const summary = `${c.label}: ${c.from} → ${c.to}`;
      return `<div class="insight" data-key="${escapeHtml(c.key)}" data-summary="${escapeHtml(summary)}" data-reaction-state="${state}">
        <div><b>${escapeHtml(c.label)}</b>: ${escapeHtml(c.from)} → <b>${escapeHtml(c.to)}</b> <span class="muted">· ${escapeHtml(SOURCE_LABEL[c.source] ?? c.source)} · ${asOf(c.ageDays)}</span></div>
        <div class="acts">
          <button class="agree${on("like")}" data-reaction="like" onclick="feedback(this)">👍 Agree</button>
          <button class="disagree${on("dislike")}" data-reaction="dislike" onclick="feedback(this)">👎 Disagree</button>
          <button class="ignore" data-reaction="snooze" onclick="feedback(this)">💤 Snooze</button>
          <span class="reacted">${state === "like" ? "👍 agreed" : state === "dislike" ? "👎 disagreed" : ""}</span>
        </div>
      </div>`;
    })
    .join("");
  return `<div class="card insights"><h2>Data changes — your call</h2>
    <div class="k" style="margin-bottom:8px">AI Endurance / Garmin updated these auto-detected numbers (the coach now uses the new value). 👍 to acknowledge, 👎 if it looks wrong, 💤 to hide it. Zones follow from these thresholds.</div>
    ${rows}
  </div>`;
}

/**
 * Bold leads that are FIELD LABELS in a research digest, not topic names — the digest lists each item as
 * `**Topic**: … / **Proposed prior**: … / **Source**: …`, so the labels must be skipped (and a
 * `**Topic**: X` line yields X, not "Topic"). Without this the card showed "Proposed prior" / "Source".
 */
const RESEARCH_LABELS = /^(topic|source|sources|proposed prior|prior|reviewer notes?|confidence|apply|link|evidence|change|new|confirms?)$/i;

/**
 * Parse the topic HEADLINES from a research-digest markdown. Handles both the flat form
 * (`- **Wider tyres** (CHANGE): …` → "Wider tyres") and the labelled form (`- **Topic**: Wider tyres` →
 * "Wider tyres"), skipping pure field-label bullets (Source / Proposed prior / …) and `### Heading`
 * topics. Pure + tolerant: format drift just yields fewer (or no) topics, and the caller falls back to a
 * "review the digest" pointer. Deduped, capped.
 */
export function parseResearchTopics(markdown: string, limit = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    // Drop a trailing "(NEW)" / "(CHANGE)" qualifier and any trailing punctuation.
    const topic = raw.replace(/\s*\((?:new|change|confirms?)\)\s*$/i, "").replace(/[:.\s]+$/, "").trim();
    const k = topic.toLowerCase();
    if (!topic || topic.length > 80 || seen.has(k) || out.length >= limit) return;
    seen.add(k);
    out.push(topic);
  };
  for (const line of markdown.split("\n")) {
    if (out.length >= limit) break;
    const heading = line.match(/^#{2,4}\s+(.*\S)/); // a "### Topic" heading (skip the digest's own H1)
    if (heading && !RESEARCH_LABELS.test(heading[1].trim())) {
      add(heading[1]);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s*\*\*(.+?)\*\*\s*(.*)$/); // "- **Lead** rest"
    if (!bullet) continue;
    const lead = bullet[1].replace(/[:.\s]+$/, "").trim();
    if (RESEARCH_LABELS.test(lead)) {
      // A labelled bullet: "**Topic**: value" gives the value; "**Source**: …" etc. is skipped.
      if (/^topic$/i.test(lead)) add(bullet[2].replace(/^[:\-\s]+/, ""));
      continue;
    }
    add(lead); // the flat form — the bold lead IS the topic
  }
  return out;
}

/**
 * Extract the bullet actions under the first heading matching `headingRe` (e.g. the weekly review's
 * "## Next week" section), stripping markdown emphasis. Pure + tolerant: a missing/renamed section just
 * yields fewer (or no) items, so the caller falls back to a "revisit the review" pointer. Deduped, capped.
 */
export function parseActionBullets(markdown: string, headingRe: RegExp, limit = 4): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let inSection = false;
  for (const line of markdown.split("\n")) {
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    if (heading) {
      inSection = headingRe.test(heading[1]); // entering the matched section ends at the next heading
      continue;
    }
    if (!inSection) continue;
    const m = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!m) continue;
    const text = m[1].replace(/\*\*/g, "").replace(/`/g, "").replace(/[:.]+$/, "").trim();
    const k = text.toLowerCase();
    if (!text || seen.has(k)) continue;
    seen.add(k);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Per-source ranking weights (higher = surfaces first) so the ~5 cap keeps the highest-VALUE items, not
 * just the first ones in catalogue order. AI-Endurance gaps block a whole discipline model / zones, and
 * open items are actions the athlete explicitly flagged, so both outrank profile questions; among
 * questions, a field the coach actually READS beats a reference-only one (so "what's your height?" never
 * crowds out a real gap).
 */
const SETUP_PRIORITY = { health: 90, race: 80, ai_endurance: 100, open_item: 70, question_coach: 50, question_reference: 20, health_low: 60, tune: 60, weekly: 40, research: 30 } as const;

/**
 * A profile question is "reference-only" (lower priority) when its `why` follows the questions.ts honesty
 * convention for fields no flow reads yet — "for your reference", "for future use", "not yet read…". This
 * only nudges ORDERING, so a reworded `why` at worst mis-ranks an item; it never breaks the card.
 */
const REFERENCE_ONLY_WHY = /for (your )?reference|for future use|not (yet )?read|not (yet )?pulled into/i;

function questionPriority(q: ProfileQuestion): number {
  return REFERENCE_ONLY_WHY.test(q.why) ? SETUP_PRIORITY.question_reference : SETUP_PRIORITY.question_coach;
}

/** Treat null / blank string / empty collection as "not filled in" when scanning for open questions. */
function isBlank(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as Record<string, unknown>).length === 0;
  return false;
}

/** Resolve a dot-path (e.g. "health.medication.dose_day") against the profile; undefined if absent. */
function valueAtPath(obj: unknown, dotPath: string): unknown {
  let cur: unknown = obj;
  for (const part of dotPath.split(".")) {
    if (cur && typeof cur === "object" && !Array.isArray(cur)) cur = (cur as Record<string, unknown>)[part];
    else return undefined;
  }
  return cur;
}

/** Normalised key for dedup — collapses case/punctuation so a restated item doesn't show twice. */
function dedupeKey(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * The unmissable training-setup topics that get restated under different wording (an `ai_endurance_todo`
 * gap AND a hand-written `open_item` describing the same gap). Verbatim dedupe misses them because the
 * copy differs ("Set your swim CSS" vs "Swim CSS not set in AI Endurance: …"), so within Finish-setup we
 * also fold by topic: CSS and FTP are unambiguous in this domain, so any two items naming the same one
 * collapse to the highest-value phrasing (AIE gap sorts first → it wins). Scoped to these two on purpose.
 */
const SETUP_TOPIC_PATTERNS: Array<[RegExp, string]> = [
  [/\bswim\s*css\b|\bcss\b/i, "swim-css"],
  [/\bftp\b/i, "ftp"],
];
function setupTopic(label: string): string | null {
  for (const [re, topic] of SETUP_TOPIC_PATTERNS) if (re.test(label)) return topic;
  return null;
}

/** Options for {@link buildSetupItems} / {@link renderSetupImprove}. */
export interface SetupOptions {
  /** Profile-question catalogue (defaults to the real one; injectable for tests). */
  questions?: ProfileQuestion[];
  /** Item keys the athlete dismissed (snoozed) within the cool-off window — dropped before the cap. */
  suppressed?: Set<string>;
  /** Already-built insight report — its deterministic marginal-gains feed the "This week" group (no LLM). */
  insights?: InsightReport;
  /** Finding keys already shown in the Top-insights box — excluded from "This week" so a recommendation
   *  the athlete has already seen (and can react to) above isn't restated here. */
  surfacedInsightKeys?: Set<string>;
  /** Latest persisted weekly review (date + the parsed "## Next week" action bullets); drops when stale. */
  weeklyReview?: { date: string; actions: string[] };
  /** Latest research digest (date + parsed topics) for the "Worth considering" group (drops when stale). */
  researchDigest?: { date: string; topics: string[] };
  /** Tool/integration health signals (computed in the IO layer) → operational "Finish setup" nudges. */
  setupHealth?: { lastSyncAgeHours?: number; hasApiKey?: boolean; waterTempSet?: boolean };
  /** Clock for staleness (defaults to Date.now()). */
  now?: number;
}

/** Display order + dedupe precedence for the three groups (finish setup wins a cross-group duplicate). */
const GROUP_ORDER: Record<SetupGroup, number> = { finish_setup: 0, this_week: 1, worth_considering: 2 };

/**
 * Build the grouped, deduped, capped list of "Set up & improve" items — NO LLM, all from data the
 * dashboard already loads or has persisted (issue #112). Sources, each tagged + routed:
 *   • Finish setup      ← `ai_endurance_todo` gaps · `open_items` · unfilled profile questions.
 *   • This week         ← the deterministic marginal-gains selection (the `tune` flow's LLM-free core,
 *                          computed live so it's always current) + a pointer to a recent weekly review.
 *   • Worth considering ← the last persisted research digest's topics (read-only; never re-run live).
 * Time-bound items (weekly/research) carry an "as of …" tag and drop once their report goes stale.
 * Dismissed items (snoozed via the shared insight-feedback machinery) are dropped first; the rest are
 * ranked, deduped across sources (finish-setup wins), and capped per group so the card stays calm. Pure.
 */
export function buildSetupItems(profile: Profile | undefined, opts: SetupOptions = {}): SetupItem[] {
  if (!profile) return [];
  const questions = opts.questions ?? PROFILE_QUESTIONS;
  const suppressed = opts.suppressed ?? new Set<string>();
  const now = opts.now ?? Date.now();
  const items: SetupItem[] = [];

  // --- Finish setup ---------------------------------------------------------------------------------
  // 1) Actionable AI-Endurance gaps (skip resolved/blank values and the non-actionable keys).
  for (const [key, value] of Object.entries(profile.ai_endurance_todo ?? {})) {
    if (NON_ACTIONABLE_AIE.has(key)) continue;
    const v = value == null ? "" : String(value).trim();
    if (v === "" || v.toLowerCase() === "resolved") continue;
    const { label, why } = aieTodoCopy(key, v);
    items.push({ key: setupKey("ai_endurance", key), label, why, source: "ai_endurance", group: "finish_setup", route: "in AI Endurance", action: AIE_TODO_ACTION[key] ?? AIE_TODO_ACTION_FALLBACK, priority: SETUP_PRIORITY.ai_endurance });
  }
  // 2) Free-text open items (a running list of unresolved actions) → raise them with the coach.
  for (const raw of profile.open_items ?? []) {
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) continue;
    items.push({ key: setupKey("open_item", dedupeKey(text)), label: text, why: "", source: "open_item", group: "finish_setup", route: "discuss with coach", action: OPEN_ITEM_ACTION, priority: SETUP_PRIORITY.open_item });
  }
  // 3) Unfilled optional profile questions → fill them in (or tell Claude via update_profile).
  for (const q of questions) {
    if (!isBlank(valueAtPath(profile, q.field))) continue;
    items.push({ key: setupKey("profile_question", q.field), label: `Answer: ${q.question}`, why: q.why, source: "profile_question", group: "finish_setup", route: "edit profile", action: questionAction(q), priority: questionPriority(q) });
  }
  // 4) Tool/integration health (operational nudges) — things that block the app doing its best work.
  const h = opts.setupHealth;
  if (h?.hasApiKey === false) {
    items.push({ key: setupKey("health", "apikey"), label: "Add your ANTHROPIC_API_KEY", why: "unlocks the AI write-ups — readiness, weekly, ask and session feedback", source: "health", group: "finish_setup", route: "in your setup", action: "Add `ANTHROPIC_API_KEY=sk-ant-…` to your .env, then redeploy with `npm run update`. The dashboard, zones and health checks already work without it; this turns on the AI write-ups (readiness, weekly, ask, session feedback).", priority: SETUP_PRIORITY.health });
  }
  if (h?.lastSyncAgeHours != null && h.lastSyncAgeHours >= 72) {
    items.push({ key: setupKey("health", "sync"), label: "Sync your training data", why: `last synced ${Math.round(h.lastSyncAgeHours / 24)}d ago — the cards are reading stale data`, source: "health", group: "finish_setup", route: "in your setup", action: "Hit ↻ Sync at the top of the dashboard (it also auto-syncs when the snapshot goes stale). If it keeps failing, refresh your AI Endurance / Garmin auth with `npm run auth:aie`.", priority: SETUP_PRIORITY.health });
  }
  if (h?.waterTempSet === false) {
    items.push({ key: setupKey("health", "watertemp"), label: "Set your open-water temperature", why: "COACH_WATER_TEMP_C has no public feed — set it when the venue posts a reading", source: "health", group: "finish_setup", route: "in your setup", action: "Set `COACH_WATER_TEMP_C=<°C>` in .env and redeploy (`npm run update`). There's no public feed for open-water temperature, so update it whenever your venue posts a reading — it gates open-water-swim advice.", priority: SETUP_PRIORITY.health_low });
  }
  // 5) Incomplete race entries — a named race with no date can't drive the countdown/taper/race-day plan.
  for (const r of (profile.races ?? []).slice(0, 4)) {
    const name = typeof r?.name === "string" ? r.name.trim() : "";
    if (!name || r?.date) continue;
    items.push({ key: setupKey("race", dedupeKey(name)), label: `Add the date for ${name}`, why: "so the countdown, periodisation and race-day plan line up", source: "race", group: "finish_setup", route: "edit profile", action: `Add a \`date: YYYY-MM-DD\` (and ideally \`distance\` + \`priority\`) to "${name}" under \`races:\` in profile.local.yaml — or ask Claude. It drives the countdown, the periodisation/taper shape and the race-day split plan.`, priority: SETUP_PRIORITY.race });
  }

  // --- This week (Phase 2: marginal gains + last weekly review's actions, read-only/LLM-free) --------
  // Skip any gain already surfaced in the Top-insights box above — it's shown (and reactable) there, so
  // restating its recommendation here is the dedupe the dashboard most needs. Select a few extra (the
  // per-group cap trims later) so a filtered-out one frees its slot for the next-best gain.
  if (opts.insights) {
    const surfaced = opts.surfacedInsightKeys ?? new Set<string>();
    for (const f of selectMarginalGains(opts.insights)) {
      if (surfaced.has(findingKey(f))) continue;
      const action = `${f.detail}\n\nDo: ${f.recommendation ?? f.title}${f.evidence ? `\nEvidence: ${f.evidence}` : ""}`;
      items.push({ key: setupKey("tune", findingKey(f)), label: f.recommendation ?? f.title, why: f.title, source: "tune", group: "this_week", route: "discuss with coach", action, priority: SETUP_PRIORITY.tune });
    }
  }
  if (opts.weeklyReview) {
    const age = ageDaysFrom(opts.weeklyReview.date, now);
    if (age != null && age <= WEEKLY_FRESH_DAYS) {
      const acts = opts.weeklyReview.actions.slice(0, GROUP_CAP.this_week);
      if (acts.length) {
        // The weekly review's own "Next week" action items.
        for (const a of acts) {
          items.push({ key: setupKey("weekly", dedupeKey(a)), label: a, why: `from this week's review — ${asOf(age)}`, source: "weekly", group: "this_week", route: "discuss with coach", action: WEEKLY_ITEM_ACTION, priority: SETUP_PRIORITY.weekly });
        }
      } else {
        // The report had no parseable action section → fall back to a pointer.
        items.push({ key: setupKey("weekly", "review"), label: "Revisit this week's training review", why: `weekly review saved — ${asOf(age)}`, source: "weekly", group: "this_week", route: "discuss with coach", action: WEEKLY_ITEM_ACTION, priority: SETUP_PRIORITY.weekly });
      }
    }
  }

  // --- Worth considering (Phase 3: last research digest, read-only/LLM-free) ------------------------
  if (opts.researchDigest) {
    const age = ageDaysFrom(opts.researchDigest.date, now);
    if (age != null && age <= RESEARCH_FRESH_DAYS) {
      const topics = opts.researchDigest.topics.slice(0, GROUP_CAP.worth_considering);
      if (topics.length) {
        for (const t of topics) {
          items.push({ key: setupKey("research", dedupeKey(t)), label: t, why: `from the research digest — ${asOf(age)}`, source: "research", group: "worth_considering", route: "discuss with coach", action: RESEARCH_ITEM_ACTION, priority: SETUP_PRIORITY.research });
        }
      } else {
        items.push({ key: setupKey("research", "digest"), label: "Review the latest research digest", why: asOf(age), source: "research", group: "worth_considering", route: "discuss with coach", action: RESEARCH_ITEM_ACTION, priority: SETUP_PRIORITY.research });
      }
    }
  }

  // Drop dismissed items, then order by group → priority → insertion (stable). Dedupe across sources
  // (finish-setup sorts first, so it wins a cross-group restatement), and cap PER GROUP — filtering
  // before the cap means a dismissal lets the next-best item in that group take the freed slot.
  const ranked = items
    .filter((item) => !suppressed.has(item.key))
    .map((item, i) => ({ item, i }))
    .sort((a, b) => GROUP_ORDER[a.item.group] - GROUP_ORDER[b.item.group] || b.item.priority - a.item.priority || a.i - b.i)
    .map((d) => d.item);
  const seen = new Set<string>();
  const seenTopics = new Set<string>(); // CSS/FTP folding, Finish-setup only (see SETUP_TOPIC_PATTERNS)
  const perGroup: Record<SetupGroup, number> = { finish_setup: 0, this_week: 0, worth_considering: 0 };
  const out: SetupItem[] = [];
  for (const item of ranked) {
    const k = dedupeKey(item.label);
    if (seen.has(k)) continue;
    const topic = item.group === "finish_setup" ? setupTopic(item.label) : null;
    if (topic && seenTopics.has(topic)) continue; // a restatement of an already-listed setup gap
    seen.add(k);
    if (topic) seenTopics.add(topic);
    if (perGroup[item.group] >= GROUP_CAP[item.group]) continue;
    perGroup[item.group] += 1;
    out.push(item);
  }
  return out;
}

/** Human heading per group (only shown when more than one group is present). */
const GROUP_HEADING: Record<SetupGroup, string> = {
  finish_setup: "Finish setup",
  this_week: "This week",
  worth_considering: "Worth considering",
};

/**
 * One expandable `<details>` for a setup item: the summary line (label · why · route tag · dismiss ✕),
 * and — on expand — the **proposed action** (self-serve "how to do it" so you never leave the page). The
 * ✕ carries the stable key and stops propagation so a dismiss click doesn't toggle the dropdown.
 */
function setupItemHtml(it: SetupItem): string {
  const note = it.why ? ` — <span class="muted">${escapeHtml(it.why)}</span>` : "";
  const body = it.action ? `<div class="setup-action">${escapeHtml(it.action)}</div>` : "";
  return `<details class="setup-item" data-key="${escapeHtml(it.key)}" data-summary="${escapeHtml(it.label)}"><summary><strong>${escapeHtml(it.label)}</strong>${note} <span class="route">${escapeHtml(it.route)}</span> <button class="dismiss" title="Dismiss — hide this for ~2 weeks" onclick="event.stopPropagation();dismissSetup(this)">✕</button></summary>${body}</details>`;
}

const setupListHtml = (its: SetupItem[]): string => `<div class="setup">${its.map(setupItemHtml).join("")}</div>`;

/**
 * "Set up & improve" — the dashboard's deterministic, LLM-free action hub (issue #112). Three sections:
 * **Finish setup** (AI-Endurance gaps · open items · unfilled profile questions), **This week** (the
 * marginal-gains selection + a recent weekly-review pointer) and **Worth considering** (the last research
 * digest's topics). The time-bound groups READ persisted reports (never re-run the LLM flows) and carry
 * an "as of …" tag. Each item is dismissable (the ✕ snoozes it via the same insight-feedback machinery,
 * so it stays gone ~2wk — a calm hub, not a nag). The group headings only appear when more than one
 * section is present. Omitted in share/screenshot mode and whenever there's nothing outstanding.
 */
export function renderSetupImprove(profile: Profile | undefined, share = false, opts: SetupOptions = {}): string {
  if (share) return "";
  const items = buildSetupItems(profile, opts);
  if (!items.length) return "";
  const groups: SetupGroup[] = ["finish_setup", "this_week", "worth_considering"];
  const present = groups.filter((g) => items.some((it) => it.group === g));
  const body =
    present.length <= 1
      ? setupListHtml(items)
      : present.map((g) => `<h3 class="setup-group">${GROUP_HEADING[g]}</h3>${setupListHtml(items.filter((it) => it.group === g))}`).join("");
  return `<div class="card"><h2>Set up &amp; improve</h2>
  <div class="k" style="margin-bottom:6px">What to do next — from your profile and your last saved coach reports (no AI call here). <b>Click any item</b> for exactly how to do it; the tag says where; dismiss (✕) hides one for ~2 weeks.</div>
  ${body}</div>`;
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
/** Split a caveat string into sentences, keeping terminators. Splits on a period followed by
 *  whitespace, so a decimal like "1.9%" (no following space) stays one token. */
function splitSentences(s: string): string[] {
  return s.split(/(?<=\.)\s+/).map((x) => x.trim()).filter(Boolean);
}

/**
 * Longest run of identical TRAILING sentences shared by every (non-empty) string — the boilerplate the
 * race-splits blocks repeat verbatim (the "…stay healthy, adapt well and taper. Worst case is racing at
 * today's fitness." / "Transitions are fixed estimates. …No estimate for swim…" tails). Returns "" when
 * fewer than two strings share anything, so a single race (or all-different bases) hoists nothing.
 */
export function commonTrailingSentences(strings: string[]): string {
  const split = strings.filter(Boolean).map(splitSentences);
  if (split.length < 2) return "";
  const minLen = Math.min(...split.map((a) => a.length));
  const shared: string[] = [];
  for (let k = 1; k <= minLen; k++) {
    const candidate = split[0][split[0].length - k];
    if (split.every((a) => a[a.length - k] === candidate)) shared.unshift(candidate);
    else break;
  }
  return shared.join(" ");
}

/** Drop a known trailing-sentence run from a caveat string (leaving the race-specific lead). */
function stripTrailingSentences(s: string | undefined, trailing: string): string {
  if (!s) return "";
  if (!trailing) return s;
  const t = s.trimEnd();
  return (t.endsWith(trailing) ? t.slice(0, t.length - trailing.length) : t).trim();
}

function renderSplits(ins: InsightReport, share = false): string {
  if (!ins.splits.length) return "";
  // Hoist the caveats every race repeats verbatim into one shared note below, stripped from each block.
  const sharedBasis = commonTrailingSentences(ins.splits.map((p) => p.rangeBasis ?? ""));
  const sharedStrategy = commonTrailingSentences(ins.splits.map((p) => p.strategy));
  const blocks = ins.splits
    .map((p, idx) => {
      const rows = p.segments
        .map((s) => `<tr><td>${escapeHtml(s.label)}</td><td class="num">${s.target ? escapeHtml(s.target) : `${paceStr(s.targetPaceSecPerKm)}/km`}</td><td class="num">${hms(s.splitSec)}</td><td class="num">${hms(s.cumulativeSec)}</td></tr>`)
        .join("");
      // Date + countdown at the top — in share view, drop the exact date but keep the countdown.
      const dTo = p.date ? daysTo(ins.date, p.date) : null;
      const countdown = dTo != null && dTo >= 0 ? `${dTo}d to go` : "";
      const raceLabel = share ? `Race ${idx + 1}` : escapeHtml(p.race);
      const when = share
        ? countdown ? ` <span class="muted">· ${countdown}</span>` : ""
        : p.date ? ` <span class="muted">· ${escapeHtml(p.date)}${countdown ? ` · ${countdown}` : ""}</span>` : "";
      // Always show BOTH estimates: race-day best (projected) → race-it-today (current level), rounded to
      // the minute. When there's no build/trend to project they read the same — the basis line says why.
      const worst = p.worstSec ?? p.predictedSec;
      const best = p.bestSec ?? worst;
      const finish = `<b style="font-size:16px">${clockMin(best)}</b> <span class="muted">race-day best (projected)</span> → <b style="font-size:16px">${clockMin(worst)}</b> <span class="muted">race it today (current level)</span> <span class="muted">· over ${p.distanceKm} km</span>`;
      const basisText = stripTrailingSentences(p.rangeBasis, sharedBasis);
      const basis = basisText ? `<div class="ev" style="margin:3px 0">${escapeHtml(basisText)}</div>` : "";
      const strategyText = stripTrailingSentences(p.strategy, sharedStrategy);
      const strategy = strategyText ? `<div class="ev" style="margin:4px 0">Pacing for the current prediction — ${escapeHtml(strategyText)}</div>` : "";
      return `<div style="margin-bottom:16px">
        <div style="font-size:15px"><b>${raceLabel}</b>${when}</div>
        <div style="margin:5px 0">${finish}</div>
        ${basis}
        ${strategy}
        <table><tr class="k"><td>Segment</td><td>Target</td><td>Split</td><td>Cumulative</td></tr>${rows}</table>
      </div>`;
    })
    .join("");
  const shared = [sharedBasis, sharedStrategy].filter(Boolean).join(" ");
  const sharedNote = shared ? `<div class="ev" style="margin:0 0 8px"><b>Applies to all races:</b> ${escapeHtml(shared)}</div>` : "";
  return `<div class="card"><h2>Estimated race splits</h2>${blocks}
    ${sharedNote}<div class="k">Run races build from AI Endurance's predicted finish shaped by your durability trend; triathlon legs are modelled from your current CSS / FTP / run predictions at standard race intensities. <b>A MODEL — a range and a pacing plan, not a guarantee.</b></div>
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
    ["Split", "the target time for that one segment/leg on its own"],
    ["Cumulative", "the running total elapsed by the end of that segment"],
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
 * Wellbeing escalation banner (#P1-3): the deterministic assessHealthRisk() verdict surfaced on the
 * dashboard — the daily surface — not just in the CLI/MCP readiness output. Shown when ≥2 risk signals
 * co-occur (or a standalone rapid weight drop). Suppressed in Share mode (it carries personal health
 * detail). Renders nothing when level === "none".
 */
function renderHealthBanner(risk: HealthRiskAssessment | null): string {
  if (!risk || risk.level === "none" || !risk.message) return "";
  const tone = risk.level === "raise" ? "bad" : "warn";
  const title = risk.level === "raise" ? "Health check — worth easing off" : "Health signals worth watching";
  return `<div class="card" style="border-left:5px solid ${TONE_COLOR[tone]};background:#fbf6f0">
    <h2 style="margin-top:0">⚠️ ${escapeHtml(title)}</h2>
    <p style="font-size:14px;color:#333;margin:6px 0">${escapeHtml(risk.message)}</p>
    <p class="k" style="font-size:12px;margin:4px 0 0">Not a diagnosis — a deterministic check on your own recent data. For anything persistent or worrying, see a doctor or sports physician.</p>
  </div>`;
}

/**
 * The "Today" decision header (#1) — leads with one synthesised call + the single action, corroborating
 * drivers, an always-visible health strip (#8), the LLM readiness narrative, and the key metrics.
 */
function renderHeader(today: AthleteState, hl: Headline | null, decisions: DecisionRecord[], gar: DashboardInput["garminDays"]): string {
  const lastReadiness = [...decisions].reverse().find((d) => d.kind === "readiness");
  const verdictWord = lastReadiness?.summary.split(":")[0]?.trim().toLowerCase();
  const sev = hl?.severity ?? (verdictWord === "green" || verdictWord === "amber" || verdictWord === "red" ? verdictWord : "green");
  const color = SEV_COLOR[sev] ?? "#777";
  const narrative = lastReadiness?.summary.split(":").slice(1).join(":").trim();
  const r = today.recovery.value;
  const ts = today.trainingStatus.value;
  const latestGar = gar && gar.length ? gar[gar.length - 1] : undefined;

  // Health strip — always visible so "quiet" is distinguishable from "not computed". Signals the drivers
  // line already states (Acute:chronic, recovery limiter, an off-baseline HRV status) are dropped here so
  // the same fact isn't shown twice in one card; the drivers line keeps them with their interpretive band.
  const showDrivers = !!hl && hl.drivers.length > 0;
  const limiter = r?.limiterToday ?? null;
  const hrvStatus = today.hrvStatus.value?.status;
  const acwrInDrivers = showDrivers && ts?.loadRatio != null;
  const limiterInDrivers = showDrivers && !!limiter;
  const hrvInDrivers = showDrivers && !!hrvStatus && hrvStatus.toUpperCase() !== "BALANCED";
  const stress = latestGar?.avgStressLevel;
  const recharge = latestGar?.bodyBatteryChange;
  const chips = [
    today.sleep.value?.score != null ? chip("Sleep", `${today.sleep.value.score}`, today.sleep.value.score >= 70 ? "good" : today.sleep.value.score >= 50 ? "warn" : "bad") : "",
    hrvStatus && !hrvInDrivers ? chip("HRV", hrvStatus, /balanced/i.test(hrvStatus) ? "good" : "warn") : "",
    ts?.acwrStatus && !acwrInDrivers ? chip("Acute:chronic", `${ts.loadRatio ?? "?"} ${ts.acwrStatus}`, ts.acwrStatus.toUpperCase() === "HIGH" ? "bad" : "good") : "",
    stress != null ? chip("Day stress", `${Math.round(stress)}`, stress >= 50 ? "warn" : "good") : "",
    recharge != null ? chip("Overnight recharge", `+${Math.round(recharge)}`, recharge >= 40 ? "good" : "warn") : "",
    limiter && !limiterInDrivers ? chip("Limiter", String(limiter), "warn") : "",
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

/** Weekday/month labels for the readable "last updated" line. */
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MO = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Wed 18 Jun 2026, 14:03" (withTime) or "Wed 18 Jun 2026" (date only). Echoes the input if unparseable. */
function fmtWhen(iso: string, withTime: boolean): string {
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p2 = (n: number) => String(n).padStart(2, "0");
  const date = `${WD[d.getDay()]} ${d.getDate()} ${MO[d.getMonth()]} ${d.getFullYear()}`;
  return withTime ? `${date}, ${p2(d.getHours())}:${p2(d.getMinutes())}` : date;
}

/** Human "time since": "2d 3h ago" / "3h 41m ago" / "4m ago" / "just now". `suffix` lets callers reword. */
function fmtSince(ms: number, suffix = " ago"): string {
  if (ms < 0) return "in the future";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return `just now`;
  const h = Math.floor(min / 60);
  const d = Math.floor(h / 24);
  if (d >= 1) return `${d}d ${h % 24}h${suffix}`;
  if (h >= 1) return `${h}h ${min % 60}m${suffix}`;
  return `${min}m${suffix}`;
}

/**
 * The most recent fully-ingested workout: prefer a raw activity timestamp (may carry a start time),
 * else fall back to the typed actualActivities date. Returns the datetime/date string + whether it
 * carried a time (AI Endurance exposes date only; Garmin/.FIT can carry a time).
 */
function latestWorkout(today: AthleteState): { iso: string; hasTime: boolean } | null {
  const raw = today.raw ?? {};
  const candidates: string[] = [];
  for (const key of ["getRunningActivity", "getCyclingActivity", "getSwimmingActivity"]) {
    const arr = (raw[key] as { activities?: Record<string, unknown>[] } | undefined)?.activities ?? [];
    for (const a of arr) {
      const s = String(a.activity_date_local ?? a.activity_date ?? a.start_date_local ?? "").trim();
      if (s) candidates.push(s);
    }
  }
  for (const a of today.actualActivities.value ?? []) if (a.date) candidates.push(a.date);
  if (!candidates.length) return null;
  const maxDay = candidates.reduce((m, s) => (s.slice(0, 10) > m ? s.slice(0, 10) : m), "0000-00-00");
  const withTime = candidates.find((s) => s.slice(0, 10) === maxDay && /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(s));
  return withTime ? { iso: withTime, hasTime: true } : { iso: maxDay, hasTime: false };
}

/** The readable freshness line shown under the title (replaces the raw ISO "as of …"). */
function freshnessLine(today: AthleteState): string {
  const updated = new Date(today.assembledAt);
  if (Number.isNaN(updated.getTime())) return `as of ${escapeHtml(today.assembledAt)}`;
  const now = Date.now();
  let line = `Data last updated <b>${escapeHtml(fmtWhen(today.assembledAt, true))}</b> · ${escapeHtml(fmtSince(now - updated.getTime()))}`;
  const lw = latestWorkout(today);
  if (lw) {
    const wMs = new Date(lw.iso.length <= 10 ? `${lw.iso}T12:00:00` : lw.iso).getTime();
    const gap = updated.getTime() - wMs;
    const gapNote = gap > 30 * 60_000 ? ` (${escapeHtml(fmtSince(gap, " before this update"))})` : "";
    line += `<br>Latest ingested workout <b>${escapeHtml(fmtWhen(lw.iso, lw.hasTime))}</b> · ${escapeHtml(fmtSince(now - wMs))}${gapNote}`;
  }
  return line;
}

export function renderDashboard({ window, decisions, insights, reactions, firstSeen, garminDays, costRecords, fitSummaries, canFetchFit, weather, profile, autoSyncStaleMin, suppressed, weeklyReview, researchDigest, setupHealth, sessionFeedbacks, share }: DashboardInput): string {
  const today = window[window.length - 1];

  // One synthesised "Today" call, computed once and shared: the header leads on it, the Top-insights box
  // marks the same finding (without repeating its recommendation), and "Set up & improve → This week"
  // excludes every finding already shown in the box — so a recommendation appears in exactly one place.
  const hl = insights ? coachHeadline(insights, today) : null;
  const leadFinding = insights ? insights.topFindings.find((f) => f.severity === "flag") ?? insights.topFindings.find((f) => f.severity === "watch") : undefined;
  const leadKey = leadFinding ? findingKey(leadFinding) : undefined;
  const surfacedInsightKeys = new Set<string>(insights ? insights.topFindings.slice(0, 5).map((f) => findingKey(f)) : []);
  if (leadKey) surfacedInsightKeys.add(leadKey);

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
    .map((g, i) => {
      // Share view: redact the real name + exact date (the identifying bits); keep the countdown + priority.
      const name = share ? `Race ${i + 1}` : escapeHtml(g.event_name ?? "—");
      const date = share ? '<span class="muted">—</span>' : escapeHtml(String(g.event_date ?? ""));
      return `<tr><td>${name}</td><td>${date}</td><td class="num">${g.dt >= 0 ? `T-${g.dt}d` : `${-g.dt}d ago`}</td><td>${escapeHtml(String(g.priority ?? ""))}</td></tr>`;
    })
    .join("");

  // Humanised activity log — plain labels, status icon, dev ids stripped from the summary.
  const KIND_LABEL: Record<string, string> = { readiness: "Readiness", "plan-adjust": "Plan change", "insight-feedback": "Your feedback", note: "Note" };
  const STATUS_LABEL: Record<string, string> = { accepted: "✓ agreed", declined: "✕ dismissed", deferred: "○ ignored", proposed: "• proposed", executed: "✓ applied", note: "" };
  // Dedupe by kind+summary keeping the most recent — re-reacting to the same insight (👍 then 👍 again,
  // or flip-flopping) logs a fresh row each time, which otherwise listed the same signal 2–3× here.
  const seenDecision = new Set<string>();
  const recentDecisions = [...decisions]
    .reverse()
    .filter((d) => {
      const dk = `${d.kind}|${(d.summary ?? "").toLowerCase().replace(/\s+/g, " ").trim()}`;
      if (seenDecision.has(dk)) return false;
      seenDecision.add(dk);
      return true;
    })
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
.route{display:inline-block;font-size:10px;font-weight:600;letter-spacing:.02em;color:#6b5b45;background:#f4f1ea;border:1px solid #e7d9c6;border-radius:9px;padding:1px 7px;margin-left:4px;white-space:nowrap}
details.setup-item{border-bottom:1px solid #f0ede5;padding:5px 0}details.setup-item:last-child{border-bottom:0}
details.setup-item>summary{cursor:pointer;line-height:1.5;list-style:none}
details.setup-item>summary::-webkit-details-marker{display:none}
details.setup-item>summary::before{content:"▸";color:#b9aa93;display:inline-block;width:14px}
details.setup-item[open]>summary::before{content:"▾"}
.setup-action{margin:6px 0 8px 14px;padding:8px 11px;background:#faf8f3;border-left:2px solid #e7d9c6;border-radius:4px;font-size:13px;line-height:1.55;color:#444;white-space:pre-wrap}
.setup-item .dismiss{font-size:11px;line-height:1;color:#b9aa93;background:none;border:0;cursor:pointer;padding:0 3px;margin-left:2px}.setup-item .dismiss:hover{color:#c0392b}
.setup-group{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#9a8a72;margin:10px 0 3px}
.actbtn{font-size:13px;padding:7px 14px;border:1px solid #c8642d;border-radius:8px;background:#fff;color:#c8642d;cursor:pointer}.actbtn:hover{background:#c8642d;color:#fff}
code{background:#f4f1ea;border-radius:4px;padding:0 4px;font-size:13px}
.proposal{border:1px solid #e7d9c6;border-radius:8px;padding:10px 12px;margin-top:10px}
/* Print / Save-as-PDF: a clean one-document capture — hide interactive controls, keep cards intact, open the glossaries. */
@media print {
  body{background:#fff}
  .card{break-inside:avoid;box-shadow:none;border:1px solid #ddd}
  .acts, .syncbtn, .actbtn, button, #ask, #askcard, #proposals, .sharelink, .sharebanner a, .syncbar{display:none !important}
  details{display:block}
  details > summary{display:none}
  a{color:inherit;text-decoration:none}
}
</style></head><body>
<h1>Endurance Coach</h1>
<div class="sub">${freshnessLine(today)}</div>
${
  share
    ? `<div class="card sharebanner" style="background:#eef4ff;border:1px solid #cfe0ff;color:#244">🔒 <b>Share view</b> — real race names, exact dates and your location/weather are hidden, the analysis is intact. <a href="?">Exit share view</a></div>`
    : `<div class="sharelink" style="text-align:right;margin:-8px 0 8px"><a href="?share=1" style="font-size:12px;color:#888">🔒 Share view (hide race names + location for screenshots)</a></div>`
}
${
  // The Sync control is an interactive button with a live server behind it — useless (and an empty
  // card once the button is print-hidden) in the share/screenshot view, so drop the card AND its
  // script there entirely. autoSync() is only ever invoked on a live server page, never a share view.
  share
    ? ""
    : `<div class="card syncbar" style="display:flex;align-items:center">
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
</script>`
}

${renderHealthBanner(share ? null : assessHealthRisk(window))}
${insights ? renderHeader(today, hl, decisions, garminDays) : ""}

${renderLastSession(window, insights, fitSummaries, canFetchFit, sessionFeedbacks, setupHealth?.hasApiKey, share)}

<div class="card"><h2>This week — load by sport</h2>
  <table><tr class="k"><td>Sport</td><td>Sessions</td><td>Time</td><td>Distance</td></tr>${loadRows || '<tr><td colspan="4" class="muted">no activities</td></tr>'}</table>
</div>

${share ? "" : renderWeather(weather)}

${insights ? renderInsightsBox(insights, reactions, firstSeen, leadKey) : ""}
${renderDataChanges(window, reactions, suppressed)}

<div class="card" id="askcard"><h2>Ask your data</h2>
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
// Last-session deep feedback, fetched on load when it isn't stored yet: the server downloads this
// session's raw .FIT if needed, generates the readout, persists it (so the next open is inline), and
// returns it. The H1 is stripped (the card heading already names the session).
async function loadSessionFeedback(){
  var box=document.getElementById('sessfb'); if(!box) return;
  var date=box.getAttribute('data-date');
  try{
    var r=await fetch('/session-feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({date:date})});
    if(!r.ok) throw new Error('HTTP '+r.status);
    var j=await r.json(); var md=String(j.markdown||'').replace(/^# .*\\n+/,'');
    if(j.status==='ready'){
      box.innerHTML='<div class="k" style="margin:8px 0 4px">🔍 Session feedback <span class="muted">('+(j.deep?'deep analysis':'summary')+' · just now)</span></div>'
        +'<div style="font-size:14px;color:#333;white-space:pre-wrap">'+mdToHtml(md)+'</div>';
    } else { box.innerHTML='<div class="k">'+mdToHtml(md||'No feedback available.')+'</div>'; }
  }catch(e){ box.innerHTML='<div class="k">Could not fetch feedback for this session ('+esc(''+e)+'). Hit 🔄 Sync to retry.</div>'; }
}
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
async function dismissSetup(btn){
  var li=btn.closest('.setup-item');btn.disabled=true;
  try{await fetch('/insight-feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({key:li.getAttribute('data-key'),reaction:'snooze',summary:li.getAttribute('data-summary')})});
    li.style.opacity=0.4;li.style.textDecoration='line-through';
  }catch(err){btn.disabled=false;}
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

${renderSetupImprove(profile, share, { suppressed, insights, surfacedInsightKeys, weeklyReview, researchDigest, setupHealth })}

${insights ? renderSignals(insights) : ""}

<div class="card"><h2>${trendsHeading(gar.length)}</h2>
  ${trendRows ? `<table>${trendRows}</table>` : '<div class="muted">Backfill the Garmin daily archive to populate trends (npm run backfill).</div>'}
  <div class="k" style="margin-top:8px">From the backfilled Garmin daily history.</div>
</div>

${renderZones(today)}

${renderScores(today)}

<div class="card"><h2>Race</h2>
  <table><tr class="k"><td>Event</td><td>Date</td><td>Countdown</td><td>Priority</td></tr>${raceRows || '<tr><td colspan="4" class="muted">no race goals</td></tr>'}</table>
</div>

${renderRacePredictions(today)}

${insights ? renderSplits(insights, share) : ""}

<div class="card"><h2>Recent decisions</h2>
  <table><tr class="k"><td>Kind</td><td>Status</td><td>Summary</td></tr>${recentDecisions || '<tr><td colspan="3" class="muted">none yet</td></tr>'}</table>
</div>

${renderCost(costRecords)}
<footer style="max-width:880px;margin:24px auto 8px;padding:0 16px;color:#aaa;font-size:12px;line-height:1.5">
  Not medical advice. This is a personal training tool, not a medical professional — estimates are labelled MODEL.
  For pain, injury, illness or any acute symptom, stop and consult a doctor or sports physician.
</footer>
${
  // Stale → a full background Sync (which downloads .FITs + backfills feedback, then reloads). Fresh →
  // just fetch the latest session's feedback if it's missing (no-op when there's no #sessfb placeholder),
  // so opening the page doesn't wait on a full sync. Never in share view (a screenshot runs nothing).
  share
    ? ""
    : autoSyncStaleMin != null
      ? `<script>autoSync(${Math.round(autoSyncStaleMin)})</script>`
      : `<script>if(document.getElementById('sessfb'))loadSessionFeedback();</script>`
}
</body></html>`;
}

function fmt(n: number | null | undefined, d = 0): string {
  return n == null ? "—" : n.toFixed(d);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
