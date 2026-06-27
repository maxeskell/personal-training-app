import type { AthleteState, ActualActivity, PlannedSession, ZoneSet, DisciplineThresholds } from "../state/types.js";
import type { DecisionRecord, InsightReaction } from "../state/decisionLog.js";
import { executedSourceKeys } from "../state/decisionLog.js";
import type { FitSummary } from "../archive/store.js";
import { findSessionFeedback, type SessionFeedbackRecord } from "./sessionFeedbackStore.js";
import type { InsightReport } from "../insights/engine.js";
import type { SurfacedFinding } from "../state/insightLog.js";
import { renderCoachRecs } from "./adviceRecs.js";
import { findingKey } from "../insights/metrics.js";
import { detectMetricChanges, detectSourceConflicts, formatMetricValue, metricLabel } from "./metricChanges.js";
import { buildBriefSnapshot, diffBriefSnapshots, type BriefSnapshot, type BriefChange } from "./dailyBrief.js";
import { nextSessionNote, type SessionNote } from "./sessionNote.js";
import type { MetricOverrides } from "../state/metricOverrides.js";
import { paceStr } from "../insights/zones.js";
import { coachHeadline, tsbBand, rampBand, type Tone, type Headline } from "../insights/headline.js";
import { assembleSession, listRecentSessions, type SessionRef, type SessionDetail } from "./session.js";
import { sessionPlanSignal } from "./reviewBridge.js";
import { config } from "../config.js";
import type { Profile } from "../profile/schema.js";
import { weekday, upcomingPlanned, asOfLabel, type WeekWeather } from "../weather/assess.js";
import type { WaterTempCard } from "../weather/waterTemp.js";
import { assessHealthRisk, type HealthRiskAssessment } from "../guardrails/wellbeing.js";
import { renderFuelCard, fuelSessionInner, renderFuelExtras, fuelScript } from "./fuelCard.js";
import { buildWeekFuelPlans, loadFuelPrefs, type FuelPlan } from "./fuelPlan.js";
import { loadInventory, type FuelProduct } from "./fuelInventory.js";
import { latestFuelByDateSport, fuelLogKey, type FuelLogRecord } from "./fuelLogStore.js";
import {
  escapeHtml,
  TONE_COLOR,
  daysTo,
  spark,
  mdLite,
  redactRaceNames,
  linkifyEscaped,
  ageDaysFrom,
  asOf,
  isDecideItemNew,
  newBadge,
  SOURCE_LABEL,
  hms,
  clockMin,
  hMin,
  chip,
  fmtWhen,
  fmtSince,
  fmt,
} from "./dashboardHelpers.js";
import { renderResearchDigestPage } from "./researchPage.js";
import { pageHead, renderNav, type NavId } from "./shell.js";
import { renderSeasonInner, renderWeeklyProse, type SeasonProse } from "./seasonPage.js";
import type { SeasonArcReport } from "./seasonArc.js";
import { renderCareerInner } from "./careerPage.js";
import type { CareerHistory } from "./careerHistory.js";
import {
  renderSetupImprove,
  buildSetupItems,
  aieTodoCopy,
  parseResearchItems,
  parseActionBullets,
  type ResearchTopic,
} from "./setupCard.js";

// Re-exported so the public API of this module (imported from ./coach/dashboard.js by test/server/cli/
// setupSources) is preserved after the split — the bodies now live in the focused modules above.
export { mdLite, linkifyEscaped } from "./dashboardHelpers.js";
export { renderResearchDigestPage } from "./researchPage.js";
export { renderSetupImprove, buildSetupItems, aieTodoCopy, aieGapKeyFromSetupKey, parseResearchItems, parseActionBullets } from "./setupCard.js";
export type { ResearchTopic } from "./setupCard.js";

/**
 * Glanceable local dashboard (Path-B need #2): a single self-contained HTML file with
 * Today / Week / Trends / Race. No server, no build — generated on demand and opened in the
 * browser. Coaching PROSE still comes from the flows; this is the at-a-glance state view.
 */

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
   * Latest persisted research digest (from `knowledge/pending/`): its date, file name, and the structured
   * items parsed from the markdown (topic + what-it-says + source + link). Feeds the "Worth considering"
   * group as-of-tagged items; drops when stale. Read-only — the card never re-runs the (LLM + web-search)
   * research flow. The `file` name makes the `approve` command concrete (no `<file>` placeholder).
   */
  researchDigest?: { date: string; file: string; items: ResearchTopic[] };
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
  /** Your pins on auto-detected metrics (the Data-changes card's 👎): surfaced with an un-pin control. */
  metricOverrides?: MetricOverrides;
  /** Reactable recommendations distilled from your latest readiness + deep-dive write-ups (item 4-iii). */
  coachRecs?: SurfacedFinding[];
  /** repKey → recommendations it absorbed when cross-source clustering is on; drives the "shown once" note. */
  coachRecsMerged?: ReadonlyMap<string, SurfacedFinding[]>;
  /**
   * One-tap fuelling feedback log (data/fuel-log.jsonl) — renders the "Fuelling — week ahead" card's
   * per-session 👍/👎 in its logged state and powers the learning review. Omitted → buttons render fresh.
   */
  fuelLog?: FuelLogRecord[];
  /**
   * Deterministic season-arc review (built by the server from the profile's `season_plan`, the CTL series
   * and the career trajectory) — folded into the Plan tab. Omitted → the Plan tab just shows the week-ahead
   * view (degrade-don't-crash). The standalone /season page renders the same content via {@link renderSeasonInner}.
   */
  seasonReport?: SeasonArcReport;
  /** The two latest persisted coach-prose reports (season narrative + weekly review) shown on the Plan tab. */
  seasonProse?: SeasonProse;
  /**
   * Career history (race results, lifetime bests, power curve) — folded into the Performance tab. Omitted →
   * the tab shows current form only. The standalone /career page renders the same content via {@link renderCareerInner}.
   */
  career?: CareerHistory | null;
  /**
   * Yesterday's (most recent prior-day) brief snapshot — drives the daily brief's "since yesterday" diff.
   * Loaded + persisted in the IO layer (server/CLI); omitted on the one-off file render, where the brief
   * degrades to today-at-a-glance with no diff.
   */
  priorBrief?: BriefSnapshot | null;
}

const SEV_COLOR: Record<string, string> = { red: "#c0392b", amber: "#c98a00", green: "#1a8a3a", flag: "#c0392b", watch: "#c98a00", info: "#1a8a3a" };

/**
 * Collapse a rendered card behind a disclosure so the page stays glanceable: the card's `<div class="card">`
 * becomes a `<details class="card">` and its `<h2>` title becomes the `<summary>` (so it reads identically
 * when closed). Pure string surgery — each render function returns exactly one `<div class="card">…</div>`,
 * so the first `<h2>` is the title and the trailing `</div>` is the card's own closer. An empty card (a
 * renderer that returned "") passes straight through, so nothing is shown for it.
 */
function collapse(card: string): string {
  const s = card.trim();
  if (!s) return s;
  return s
    .replace(/^<div class="[^"]*">/, '<details class="card">')
    .replace(/<h2>([\s\S]*?)<\/h2>/, "<summary>$1</summary>")
    .replace(/<\/div>\s*$/, "</details>");
}

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
  // Both sports get a row (run + ride), so a headline like "Bike durability slipping" has its numbers on a table.
  const durabilityRow = (label: string, t: { recent: number | null; prior: number | null; n: number }) =>
    t.recent == null
      ? ""
      : `<tr><td>${label} durability</td><td class="num">${t.recent}</td><td class="muted" colspan="2">${t.prior != null ? `was ${t.prior} · ` : ""}closer to 0 = more durable</td></tr>`;

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
      ${durabilityRow("Run", ins.durability.run)}
      ${durabilityRow("Ride", ins.durability.ride)}
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
  const brick = ins.brick.decouplingPct != null ? `${ins.brick.decouplingPct}% same-day run/ride EF drop <span class="muted">(${ins.brick.brickDays} same-day run+ride days)</span>` : `<span class="muted">need power-equipped runs</span>`;
  const taper = ins.taper.recommendedTsbLow != null ? `race-day TSB ~${ins.taper.recommendedTsbLow} to ${ins.taper.recommendedTsbHigh}` : `<span class="muted">no past race-day TSB yet</span>`;
  return `<table style="margin-top:12px"><tr class="k"><td>n=1 analytics</td><td></td></tr>
    <tr><td>Monitoring rule (backtested)</td><td>${rule}</td></tr>
    <tr><td>Same-day run/ride decoupling (Q4)</td><td>${brick}</td></tr>
    <tr><td>Taper target (Q6)</td><td>${taper}</td></tr>
  </table>`;
}

/** Age of an insight in whole days from its first-seen timestamp (or null if never logged before). */
function ageDays(firstSeenIso: string | undefined, now: number): number | null {
  if (!firstSeenIso) return null;
  return Math.floor((now - new Date(firstSeenIso).getTime()) / 86_400_000);
}

/** The informational "first seen …" age line for an insight (the NEW pill is now reaction-based, not age). */
function ageLabel(firstSeenIso: string | undefined, now: number): string {
  const days = ageDays(firstSeenIso, now);
  // firstSeenIso is null only for a finding the log hasn't recorded yet (i.e. brand new this render).
  const line = !firstSeenIso
    ? `first seen just now`
    : `first seen ${escapeHtml(firstSeenIso.slice(0, 10))} · ${days === 0 ? "today" : `${days}d`}`;
  return `${line} · (age since logging began)`;
}

/**
 * Top-5 insights box. Each finding shows its SAVED like/dislike (👍/👎 toggle, click again to clear) plus a
 * Snooze that hides it for ~2 weeks; dislike stays visible (just down-ranked). A NEW badge + left bar flag
 * the ones you haven't actioned yet (cleared the moment you react); a "first seen" line keeps the age as
 * context. Posts to /insight-feedback.
 */
function renderInsightsBox(ins: InsightReport, reactions?: Map<string, InsightReaction>, firstSeen?: Map<string, string>, leadKey?: string, redact: (s: string) => string = (s) => s): string {
  const sevColor = (s: string) => (s === "flag" ? "#c0392b" : s === "watch" ? "#c98a00" : "#1a8a3a");
  const now = Date.now();
  const top = ins.topFindings.slice(0, 5);
  const newCount = top.filter((f) => isDecideItemNew(findingKey(f), reactions)).length;
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
      const isNew = isDecideItemNew(key, reactions);
      const line = ageLabel(firstSeen?.get(key), now);
      // Share view: scrub real race names from the title (shown AND in the data-summary reaction payload),
      // detail, recommendation and evidence — findings like "Birmingham: behind target" carry the name.
      const title = redact(f.title);
      // The lead card carries a stable id so the "see the data →" link under the Today headline can scroll to it.
      return `<div${isLead ? ` id="lead-insight"` : ""} class="insight sev-${f.severity}${isNew ? " is-new" : ""}" data-key="${escapeHtml(key)}" data-summary="${escapeHtml(title)}" data-reaction-state="${state}">
        <div><span class="badge" style="background:${sevColor(f.severity)}">${f.severity}</span>${newBadge(key, reactions)}
          <b style="${f.severity === "flag" ? "font-size:15px" : ""}">${escapeHtml(title)}</b> <span class="muted">· ${conf}% conf · ${escapeHtml(f.family)}${isLead ? ` · today's call ↑` : ""}</span></div>
        <div class="fdetail">${escapeHtml(redact(f.detail))}</div>
        ${f.recommendation && !isLead ? `<div class="ev">→ ${escapeHtml(redact(f.recommendation))}</div>` : ""}
        <div class="ev">${escapeHtml(redact(f.evidence))}</div>
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
  const newNote = newCount ? ` · <b>${newCount} not yet actioned</b>` : " · all actioned";
  return `<div class="card insights"><h2>Top insights — your call</h2>
    <div class="k" style="margin-bottom:8px">Ranked by signal strength${newNote}.${headlineInTop ? " Today's headline call is the one marked ↑." : ""} A dislike stays visible, just down-ranked.</div>
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

/**
 * Format a UTC-seconds session start as a local "HH:MM" clock in the given IANA timezone. The .FIT
 * stores UTC timestamps; the athlete reads their own wall clock, so we convert (default Europe/London).
 * Returns "" for a missing/invalid time — the caller then shows the date alone (degrade, don't guess).
 */
export function clockHM(unixSec: number | null | undefined, tz: string = config.athlete.timezone): string {
  if (unixSec == null || !Number.isFinite(unixSec)) return "";
  try {
    return new Date(unixSec * 1000).toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });
  } catch {
    return "";
  }
}

function renderLastSession(
  window: AthleteState[],
  insights: InsightReport | undefined,
  fitSummaries?: FitSummary[],
  canFetchFit?: boolean,
  sessionFeedbacks?: SessionFeedbackRecord[],
  hasApiKey?: boolean,
  share?: boolean,
  redact: (s: string) => string = (s) => s,
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
  const stored = findSessionFeedback(sessionFeedbacks ?? [], d.date, d.sport, d.durationMin);
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
      // Share view: the deep feedback is generated prose that names the athlete's real races (e.g. "with
      // Birmingham 22 days out") — redact those before rendering so a shared screenshot/PDF stays anonymous.
      feedback = `<div class="k" style="margin:8px 0 4px">🔍 Session feedback <span class="muted">(${stored!.deep ? "deep analysis" : "summary"} · ${escapeHtml(fmtSince(Date.now() - new Date(stored!.generatedAt).getTime()))})</span></div>
      <div style="font-size:14px;color:#333;white-space:pre-wrap">${mdLite(redact(stored!.markdown.replace(/^# .*\n+/, "")))}</div>`;
      break;
    case "auto":
      // A screenshot can't run the fetch (and would freeze on "Downloading…"), so share view degrades to
      // a static line; the live page renders the placeholder the on-load loadSessionFeedback() swaps out.
      feedback = share
        ? `<div class="k">🔍 Deep feedback generates automatically on sync.</div>`
        : `<div id="sessfb" data-date="${escapeHtml(d.date)}" data-sport="${escapeHtml(d.sport)}"><div class="k">🔍 ${escapeHtml(
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
  // Review → plan bridge: a DETERMINISTIC read of how this session landed (computed here, not by the LLM)
  // that, when it crosses a conservative threshold, flags a change to the days ahead and offers a one-click
  // gated draft. The flag itself is free (no LLM); the draft is on-demand (/session-adjust re-computes the
  // signal server-side, then runs the same propose→confirm proposer as "This week"). Hidden in share view
  // and when there's no key to draft with — the flag without an actionable button would just nag.
  const signal = !share && hasApiKey ? sessionPlanSignal(d) : null;
  const bridge = signal
    ? `<div class="sessadjust" data-date="${escapeHtml(d.date)}" data-sport="${escapeHtml(d.sport)}"${d.durationMin != null ? ` data-dur="${d.durationMin}"` : ""} style="margin-top:12px;padding:10px;border:1px solid #eee;border-radius:8px;background:#fafafa">
        <div style="font-size:13px;color:#444;margin-bottom:8px">🧭 <b>${escapeHtml(signal.headline)}</b> <span class="muted">${escapeHtml(signal.reasons.join("; "))}</span></div>
        <button class="actbtn" onclick="sessionAdjust(this)">⚙ Adjust the days ahead</button>
        <div class="item-proposals"></div>
      </div>`
    : "";
  // Multi-session days (a brick, or a triathlete's swim/ride/run) silently collapsed to the longest
  // activity before — say which session this card is about, and offer the others to dive into.
  const multiNote =
    d.sessionsOnDate > 1
      ? `<div class="k" style="margin-top:10px">📅 ${d.sessionsOnDate} sessions on ${escapeHtml(d.date)}${d.sameSportOnDate > 1 ? ` (${d.sameSportOnDate} ${escapeHtml(d.sport.toLowerCase())}s — showing the longest)` : ""} — this card is your <b>${escapeHtml(d.sport)}</b>.</div>`
      : "";
  const switcher = share ? "" : renderSessionSwitcher(listRecentSessions(today, insights?.sessionDecays ?? []), d);
  const startClock = clockHM(d.startTimeS);
  const when = `${d.date}${startClock ? ` ${startClock}` : ""}`;
  return `<div class="card"><h2>Last session — ${escapeHtml(when)} ${escapeHtml(d.sport)}</h2>
    <div style="font-size:14px;margin-bottom:6px">${escapeHtml(bits)}</div>
    ${planLine}
    ${multiNote}
    ${feedback}
    ${bridge}
    ${switcher}
  </div>`;
}

/**
 * The session switcher: recent sessions as tap-to-dive chips + an empty panel the selection fills. Lets
 * the athlete see every session (not just the auto-shown latest) and pull any one's deep dive on demand
 * (the existing /session-feedback route, now sport-aware). Hidden when there's only one session to show.
 */
function renderSessionSwitcher(recent: SessionRef[], d: SessionDetail): string {
  if (recent.length < 2) return "";
  const chips = recent
    .map((r) => {
      const active = r.date === d.date && r.sport === d.sport;
      const clock = clockHM(r.startTimeS);
      const dur = r.durationMin != null ? ` ${r.durationMin}min` : "";
      const label = `${weekday(r.date)}${clock ? ` ${clock}` : ""} ${SPORT_EMOJI[r.sport] ?? ""}${escapeHtml(r.sport)}${dur}${r.isMostRecent ? " ·latest" : ""}`;
      return `<button class="sess-chip${active ? " on" : ""}" data-date="${escapeHtml(r.date)}" data-sport="${escapeHtml(r.sport)}" data-dur="${r.durationMin ?? ""}" onclick="selectSession(this)" title="${escapeHtml(`${r.date}${clock ? ` ${clock}` : ""} ${r.sport}`)}" style="padding:5px 10px;border:1px solid ${active ? "#c8642d" : "#ddd"};border-radius:14px;background:${active ? "#fdeee4" : "#fff"};font-size:12px;color:#333;cursor:pointer">${label}</button>`;
    })
    .join("");
  return `<div class="k" style="margin-top:14px">🗂️ Dive into another session:</div>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${chips}</div>
    <div id="dive" style="margin-top:10px"><div class="k muted">Tap a session above to load its deep feedback here (the one shown up top is highlighted).</div></div>`;
}

const VERDICT_COLOR: Record<string, string> = { good: "#1a8a3a", marginal: "#c98a00", poor: "#c0392b", indoor: "#9a9a9a" };
const SPORT_EMOJI: Record<string, string> = { Swim: "🏊", Ride: "🚴", Run: "🏃", Strength: "🏋️" };

/** Per-session fuelling folded into the Week-ahead card: a dropdown per row that needs fuel, + the shared
 *  extras/script emitted once. Absent → the standalone fallback card carries it instead. */
interface WeatherFuelCtx {
  byKey: Map<string, FuelPlan>;
  logged: Map<string, FuelLogRecord>;
  inventory: FuelProduct[];
  hasApiKey?: boolean;
}

/** "Week ahead — plan vs weather": per-session verdicts + day outlook incl. estimated road dryness. */
/**
 * The open-water temp control at the bottom of the weather card. Four states: nothing set (type a
 * reading), a fresh confirmed reading (shown + updatable), a stale reading drifted into a MODEL estimate
 * (Confirm / Correct), or a stale reading with no air anchor (re-confirm). Static summary in share view.
 */
function renderWaterTemp(water: WaterTempCard | undefined, share: boolean): string {
  const inputRow = (val?: number) =>
    `<input type="number" step="0.5" min="-2" max="40" class="wt-input" value="${val != null ? escapeHtml(String(val)) : ""}" placeholder="°C" style="width:72px">` +
    `<button onclick="setWaterTemp(this)">Save</button>` +
    (water ? `<button class="ignore" onclick="clearWaterTemp(this)">Clear</button>` : "");
  const wrap = (inner: string) => `<div class="watertemp" style="margin-top:8px">${inner}</div>`;

  if (share) {
    const txt = !water ? "not set" : water.estimated ? `estimated ~${water.tempC}°C (MODEL)` : `~${water.tempC}°C${asOfLabel(water.asOf)}`;
    return `<div class="k" style="margin-top:8px">Open-water temp: ${escapeHtml(txt)}</div>`;
  }
  if (!water) {
    return wrap(
      `<span class="k">Open-water temp (no public feed — type the venue's latest reading; saves live, no restart):</span><br>` +
        inputRow() +
        `<span class="reacted wt-status">not set — open-water swim verdicts say “check the venue”</span>`,
    );
  }
  if (water.stale) {
    const head = water.estimated
      ? `Estimated ~${water.tempC}°C — ${water.basis ?? "MODEL"}${asOfLabel(water.asOf)}`
      : `Last reading ~${water.tempC}°C${asOfLabel(water.asOf)} — ${Math.round(water.ageDays)}d old`;
    const lead = water.estimated
      ? `<button data-est="${escapeHtml(String(water.tempC))}" onclick="confirmWaterTemp(this)">✓ Confirm ${escapeHtml(String(water.tempC))}°C</button> or correct it: `
      : `Update it: `;
    return wrap(
      `<span class="k">Open-water temp — please confirm (no public feed):</span><br>` +
        `<span class="fdetail">${escapeHtml(head)}</span><br>` +
        lead +
        inputRow() +
        `<span class="reacted wt-status"></span>`,
    );
  }
  return wrap(
    `<span class="k">Open-water temp (no public feed — update from the venue's latest reading; saves live):</span><br>` +
      inputRow(water.tempC) +
      `<span class="reacted wt-status">${escapeHtml(`current: ~${water.tempC}°C${asOfLabel(water.asOf)}`)}</span>`,
  );
}

function renderWeather(w: WeekWeather | undefined, fuel?: WeatherFuelCtx, share = false, coachNote?: SessionNote, coachNoteIdx = -1): string {
  if (!w) return "";
  let anyFuel = false;
  const sessions = w.sessions.length
    ? w.sessions
        .map((s, i) => {
          const plan = fuel?.byKey.get(fuelLogKey(s.date.slice(0, 10), s.sport));
          const fuelDrop =
            plan?.needed
              ? ((anyFuel = true),
                `<details class="fueldrop" style="margin-top:5px"><summary style="cursor:pointer;font-size:12px;color:#c8642d;font-weight:600">⛽ Fuelling</summary><div style="margin-top:5px">${fuelSessionInner(plan, fuel!.logged.get(fuelLogKey(s.date.slice(0, 10), s.sport)), false, false)}</div></details>`)
              : "";
          // Coach's note — on the next COACHABLE session (its index resolved by the caller, so a leading
          // gym/indoor day doesn't blank it), the coach-voice "how to execute it" line (a MODEL, intensity
          // inferred from the title), with the basis behind a "why" disclosure.
          const note =
            i === coachNoteIdx && coachNote
              ? `<div class="ev" style="color:#2563eb;margin-top:5px">📋 <b>Coach:</b> ${escapeHtml(coachNote.note)} <span class="muted">— MODEL</span>${coachNote.basis.length ? `<details style="margin-top:2px"><summary style="cursor:pointer;font-size:11px;color:#888">why</summary><div class="k" style="margin-top:2px">${escapeHtml(coachNote.basis.join(" · "))}</div></details>` : ""}</div>`
              : "";
          return `<div class="finding${s.done ? " done" : ""}">
      <div><span class="badge" style="background:${VERDICT_COLOR[s.verdict] ?? "#777"}">${escapeHtml(s.verdict)}</span>
        <b>${escapeHtml(weekday(s.date))} · ${SPORT_EMOJI[s.sport] ?? ""} ${escapeHtml(s.sport)}</b>${s.title ? ` <span class="muted">· ${escapeHtml(s.title)}</span>` : ""}${s.done ? ` <span class="donetag">✓ done</span>` : ""}</div>
      <div class="fdetail">${escapeHtml(s.reason)}</div>
      ${s.suggestion ? `<div class="ev">→ ${escapeHtml(s.suggestion)}</div>` : ""}
      ${fuelDrop}${note}
    </div>`;
        })
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
  // Fuelling folded in: the per-row dropdowns above + the shared extras (daily stack + review) and the
  // handler script, emitted once, only when at least one session actually surfaced a plan.
  const fuelExtras = fuel && anyFuel ? renderFuelExtras(fuel.inventory, fuel.hasApiKey, false) : "";
  const fuelJs = fuel && anyFuel ? fuelScript(false) : "";
  // Open-water temp: confirm/correct loop driven by the forecaster (a stale reading is drifted on air temp
  // and shown as a MODEL estimate to confirm). Saving writes data/venue.json (read live → no restart).
  const water = w.water ?? (w.waterTempC != null ? { tempC: w.waterTempC, asOf: w.waterTempAsOf, estimated: false, stale: false, ageDays: 0 } : undefined);
  const waterTemp = renderWaterTemp(water, share);
  return `<div class="card"><h2>Week ahead — plan vs weather</h2>
    ${sessions}
    ${fuelExtras}
    <table style="margin-top:8px"><tr class="k"><td>Day</td><td>Sky</td><td>°C</td><td>Rain</td><td>Gusts km/h</td><td>Roads</td><td>Ride window</td></tr>${rows}</table>
    <div class="k" style="margin-top:8px">${planNote}Open-Meteo forecast as of ${stamp(w.fetchedAt)} — Sync re-pulls both. "Roads" and ride windows are a MODEL drying estimate from rain, temperature, sun and wind — eyeball the tarmac before committing.</div>
    ${waterTemp}
  </div>${fuelJs}`;
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

/**
 * "Data changes — your call": when AI Endurance / Garmin change an auto-detected number (FTP, threshold
 * HR/pace, swim CSS, max HR, VO₂max), surface it (diffed from snapshots, no LLM) with 👍 agree
 * (acknowledge, via the insight-feedback machinery), 👎 disagree (PIN your prior value as an override the
 * next sync honours) and 💤 snooze. It ALSO surfaces metrics where the two platforms currently DISAGREE
 * ("AI Endurance 250 W vs Garmin 235 W") with which one is in force and a one-tap "use the other" pin.
 * Active pins are listed separately with an un-pin (accept the auto value). A pinned metric's change is
 * hidden (your value is in force) until you un-pin or the platform detects something new. Omitted when
 * there's nothing to show.
 */
function renderDataChanges(window: AthleteState[], reactions?: Map<string, InsightReaction>, suppressed?: Set<string>, overrides?: MetricOverrides, now?: number): string {
  const pinned = overrides ?? {};
  const changes = detectMetricChanges(window, { now })
    .filter((c) => !suppressed?.has(c.key) && !(c.metric in pinned)) // a pinned metric shows as an override, not a change
    .slice(0, 5);
  const changedMetrics = new Set(changes.map((c) => c.metric));
  // Cross-source disagreements TODAY — but never duplicate a metric already shown as a change or pinned.
  const latest = window.length ? window[window.length - 1] : undefined;
  const conflicts = (latest ? detectSourceConflicts(latest) : [])
    .filter((c) => !suppressed?.has(c.key) && !(c.metric in pinned) && !changedMetrics.has(c.metric))
    .slice(0, 5);
  const changeRows = changes
    .map((c) => {
      const saved = reactions?.get(c.key);
      const state = saved === "agree" ? "like" : saved === "disagree" ? "dislike" : "";
      const on = (which: string) => (state === which ? " on" : "");
      const isNew = isDecideItemNew(c.key, reactions); // pinned metrics are already filtered out above
      return `<div class="insight${isNew ? " is-new" : ""}" data-key="${escapeHtml(c.key)}" data-summary="${escapeHtml(`${c.label}: ${c.from} → ${c.to}`)}" data-reaction-state="${state}" data-metric="${escapeHtml(c.metric)}" data-when="${c.toValue}" data-use="${c.fromValue}">
        <div>${newBadge(c.key, reactions)}<b>${escapeHtml(c.label)}</b>: ${escapeHtml(c.from)} → <b>${escapeHtml(c.to)}</b> <span class="muted">· ${escapeHtml(SOURCE_LABEL[c.source] ?? c.source)} · ${asOf(c.ageDays)}</span></div>
        <div class="acts">
          <button class="agree${on("like")}" data-reaction="like" onclick="feedback(this)">👍 Agree</button>
          <button class="disagree${on("dislike")}" onclick="pinOverride(this)">👎 Disagree — keep ${escapeHtml(c.from)}</button>
          <button class="ignore" data-reaction="snooze" onclick="feedback(this)">💤 Snooze</button>
          <span class="reacted">${state === "like" ? "👍 agreed" : ""}</span>
        </div>
      </div>`;
    })
    .join("");
  const conflictRows = conflicts
    .map((c) => {
      const sideBySide = c.readings
        .map((r) => `${escapeHtml(SOURCE_LABEL[r.source] ?? r.source)} <b>${escapeHtml(r.formatted)}</b>`)
        .join(" vs ");
      return `<div class="insight" data-key="${escapeHtml(c.key)}" data-summary="${escapeHtml(`${c.label}: sources disagree (${c.readings.map((r) => r.formatted).join(" vs ")})`)}" data-metric="${escapeHtml(c.metric)}" data-when="${c.inUse.value}" data-use="${c.alt.value}">
        <div>⚖️ <b>${escapeHtml(c.label)}</b>: ${sideBySide} <span class="muted">· using ${escapeHtml(SOURCE_LABEL[c.inUse.source] ?? c.inUse.source)} ${escapeHtml(c.inUse.formatted)}</span></div>
        <div class="acts">
          <button class="disagree" onclick="pinOverride(this)">📌 Use ${escapeHtml(SOURCE_LABEL[c.alt.source] ?? c.alt.source)} ${escapeHtml(c.alt.formatted)}</button>
          <button class="ignore" data-reaction="snooze" onclick="feedback(this)">💤 Snooze</button>
          <span class="reacted"></span>
        </div>
      </div>`;
    })
    .join("");
  const overrideRows = Object.entries(pinned)
    .map(([metric, ov]) => {
      return `<div class="insight" data-metric="${escapeHtml(metric)}">
        <div>📌 <b>${escapeHtml(metricLabel(metric))}</b>: using <b>${escapeHtml(formatMetricValue(metric, ov.use))}</b> <span class="muted">· you overrode the auto-detected ${escapeHtml(formatMetricValue(metric, ov.when))}</span></div>
        <div class="acts"><button class="ignore" onclick="unpinOverride(this)">↩ Un-pin — accept ${escapeHtml(formatMetricValue(metric, ov.when))}</button><span class="reacted"></span></div>
      </div>`;
    })
    .join("");
  if (!changeRows && !conflictRows && !overrideRows) return "";
  return `<div class="card insights"><h2>Data changes — your call</h2>
    <div class="k" style="margin-bottom:8px">AI Endurance / Garmin auto-update these numbers (and sometimes disagree). Pins hold until you un-pin or a new value appears; zones follow from these thresholds.</div>
    ${changeRows}${conflictRows}${overrideRows}
  </div>`;
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

const BRIEF_DOT: Record<BriefChange["tone"], string> = { up: "#1a8a3a", down: "#c98a00", neutral: "#777" };

/** The first meaningful sentence of a stored session readout — the bold "Verdict" line, else the first prose line. */
function sessionFeedbackOneLine(rec: SessionFeedbackRecord): string | null {
  const lines = rec.markdown.split("\n").map((l) => l.trim());
  const bold = lines.find((l) => /^\*\*.+\*\*/.test(l));
  const pick = bold ?? lines.find((l) => l && !l.startsWith("#") && !l.startsWith("-"));
  if (!pick) return null;
  return pick.replace(/\*\*/g, "").replace(/^[-*]\s*/, "").trim() || null;
}

/**
 * The unified "Today" card (#1) — the single coaching card at the top of the Today tab. It OWNS the
 * readiness call (verdict + the single action + drivers + health strip + the LLM narrative + key-metric
 * tiles) AND the daily-brief layer (since-yesterday diff, today's session(s) at a glance, yesterday in one
 * line). The readiness header and the brief used to be two stacked cards saying overlapping things; they
 * are merged here so Today reads as one coach, not a dashboard.
 *
 * Deterministic (no LLM): every part is a VIEW over pieces the engine already computed — the verdict from
 * the readiness write-up, the diff from the daily snapshots, the session glance from the plan/weather/fuel
 * — so it never disagrees with the cards below it. The readiness sub-blocks render only when `insights`/`hl`
 * exist (no baseless green verdict); the brief sections only when `briefEnabled`; each sub-part is
 * independently conditional, so a missing piece drops out (degrade-don't-crash). Stays short when nothing
 * moved. With no insights AND the brief off, it renders nothing rather than an empty shell.
 */
function renderTodayCard(args: {
  today: AthleteState;
  window: AthleteState[];
  insights?: InsightReport;
  hl: Headline | null;
  leadKey?: string;
  decisions: DecisionRecord[];
  garminDays: DashboardInput["garminDays"];
  priorBrief: BriefSnapshot | null;
  weather?: WeekWeather;
  fuelByKey: Map<string, FuelPlan>;
  sessionFeedbacks?: SessionFeedbackRecord[];
  redact: (s: string) => string;
  now: number;
  briefEnabled: boolean;
}): string {
  const { today, window, insights, hl, leadKey, decisions, garminDays: gar, priorBrief, weather, fuelByKey, sessionFeedbacks, redact, now, briefEnabled } = args;

  // ── Readiness core (the former standalone header) — rendered only when there are insights to back it ──
  const lastReadiness = [...decisions].reverse().find((d) => d.kind === "readiness");
  const verdictWord = lastReadiness?.summary.split(":")[0]?.trim().toLowerCase();
  const sev = hl?.severity ?? (verdictWord === "green" || verdictWord === "amber" || verdictWord === "red" ? verdictWord : "green");
  const color = SEV_COLOR[sev] ?? "#777";
  const narrative = lastReadiness?.summary.split(":").slice(1).join(":").trim();
  const r = today.recovery.value;
  const ts = today.trainingStatus.value;
  const latestGar = gar && gar.length ? gar[gar.length - 1] : undefined;
  // Drivers-vs-chip/tile de-dup: a signal stated in the drivers line is dropped from its chip/tile so the
  // same fact isn't shown twice in one card.
  const showDrivers = !!hl && hl.drivers.length > 0;
  const limiter = r?.limiterToday ?? null;
  const hrvStatus = today.hrvStatus.value?.status;
  const acwrInDrivers = showDrivers && ts?.loadRatio != null;
  const limiterInDrivers = showDrivers && !!limiter;
  const hrvInDrivers = showDrivers && !!hrvStatus && hrvStatus.toUpperCase() !== "BALANCED";
  const stress = latestGar?.avgStressLevel;
  const recharge = latestGar?.bodyBatteryChange;
  // Sleep/HRV appear ONCE — their number in the tile, coloured by status; chips are reserved for flags
  // with no tile of their own.
  const sleepScore = today.sleep.value?.score ?? null;
  const sleepHours = today.sleep.value?.hours ?? null;
  const sleepColor = sleepScore == null ? "" : TONE_COLOR[sleepScore >= 70 ? "good" : sleepScore >= 50 ? "warn" : "bad"];
  const hrvColor = hrvStatus ? TONE_COLOR[/balanced/i.test(hrvStatus) ? "good" : "warn"] : "";
  const chips = [
    ts?.acwrStatus && !acwrInDrivers ? chip("Acute:chronic", `${ts.loadRatio ?? "?"} ${ts.acwrStatus}`, ts.acwrStatus.toUpperCase() === "HIGH" ? "bad" : "good") : "",
    stress != null ? chip("Day stress", `${Math.round(stress)}`, stress >= 50 ? "warn" : "good") : "",
    recharge != null ? chip("Overnight recharge", `+${Math.round(recharge)}`, recharge >= 40 ? "good" : "warn") : "",
    limiter && !limiterInDrivers ? chip("Limiter", String(limiter), "warn") : "",
  ].filter(Boolean).join("");

  const verdictBlock = insights
    ? `<div class="verdict"><span class="dot" style="background:${color}"></span>
      <span class="big" style="color:${color}">${escapeHtml(sev)}</span></div>
    ${hl ? `<p style="font-size:16px;color:#222;margin:10px 0 6px;font-weight:500">${escapeHtml(redact(hl.line))}</p>` : ""}
    ${hl && leadKey ? `<a href="#decide" onclick="seeData()" style="display:inline-block;font-size:13px;color:#1558d6;text-decoration:none;margin:0 0 8px">see the data →</a>` : ""}
    ${hl?.action ? `<div style="background:${color};color:#fff;border-radius:8px;padding:10px 12px;font-size:14px;margin:6px 0 8px">➡️ ${escapeHtml(redact(hl.action))}</div>
      <button class="actbtn" onclick="actPlan()">⚙ Turn this into a plan change</button><div id="proposals"></div>` : ""}`
    : "";
  const driversChips = insights
    ? `${hl && hl.drivers.length ? `<div class="k" style="margin-bottom:10px">${hl.drivers.map((d) => escapeHtml(redact(d))).join(" · ")}</div>` : ""}
    ${chips ? `<div style="margin:6px 0 12px">${chips}</div>` : ""}`
    : "";
  const tilesBlock = insights
    ? `<div class="grid" style="margin-top:6px">
      <div><div class="k">HRV (ms)</div><div class="v"${hrvColor ? ` style="color:${hrvColor}"` : ""}>${fmt(today.hrvOvernight.value)}</div>${hrvStatus && !hrvInDrivers ? `<div class="k">${escapeHtml(hrvStatus)}</div>` : ""}</div>
      <div><div class="k">Resting HR</div><div class="v">${fmt(today.restingHr.value)}</div></div>
      <div><div class="k">Sleep</div><div class="v"${sleepColor ? ` style="color:${sleepColor}"` : ""}>${sleepScore ?? "—"}</div>${sleepHours != null ? `<div class="k">${sleepHours.toFixed(1)}h</div>` : ""}</div>
      <div><div class="k">Cardio rec.</div><div class="v">${fmt(r?.cardioRecovery)}</div></div>
    </div>`
    : "";
  const narrativeBlock = insights && narrative
    ? `<details><summary style="cursor:pointer;font-size:13px;color:#888">Readiness detail</summary><p style="font-size:14px;color:#444;margin:8px 0">${escapeHtml(redact(narrative))}</p></details>`
    : "";

  // ── Brief layer (since yesterday · today at a glance · yesterday in a line) — gated by briefEnabled ──
  let sinceBlock = "";
  let todayBlock = "";
  let yesterdayBlock = "";
  if (briefEnabled) {
    // Since-yesterday diff — pure, built from the same pieces the cards below use.
    const curr = buildBriefSnapshot({ window, insights, decisions, now });
    const metricChanges = detectMetricChanges(window, { now });
    const insightTitle = (key: string) => insights?.topFindings.find((f) => findingKey(f) === key)?.title;
    const changes = diffBriefSnapshots(priorBrief, curr, { metricChanges, insightTitle }).slice(0, 6);
    const sinceLabel = priorBrief
      ? daysTo(priorBrief.date, today.date) === 1
        ? "Since yesterday"
        : `Since ${escapeHtml(priorBrief.date)}`
      : null;
    sinceBlock = !sinceLabel
      ? "" // first day — nothing to diff against
      : changes.length
        ? `<div class="k" style="margin-bottom:4px">${sinceLabel}</div>
        <ul style="list-style:none;padding:0;margin:0 0 12px">${changes
            .map(
              (c) =>
                `<li style="font-size:14px;margin:4px 0"><span class="dot" style="background:${BRIEF_DOT[c.tone]};display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:7px"></span>${escapeHtml(redact(c.text))} <a href="#${c.target}" data-tab="${c.target}" style="color:#1558d6;text-decoration:none;font-size:12px">→</a></li>`,
            )
            .join("")}</ul>`
        : `<div class="k" style="margin-bottom:12px">${sinceLabel} — nothing's changed.</div>`;

    // Today's session(s) at a glance: sport · duration · weather verdict · fuelling indicator.
    const WX: Record<string, string> = { good: "🟢", marginal: "🟡", poor: "🔴", indoor: "🏠" };
    const todays = (today.plannedSessions.value ?? []).filter((p) => p.date.slice(0, 10) === today.date);
    const todayRows = todays.map((p) => {
      const sport = p.sport ?? "Session";
      const dur = p.durationMin ? ` · ${Math.round(p.durationMin)} min` : "";
      const wx = weather?.sessions.find((s) => s.date.slice(0, 10) === today.date && s.sport === sport);
      const wxBit = wx ? ` · ${WX[wx.verdict] ?? ""} ${escapeHtml(wx.verdict)}` : "";
      // A tight indicator, not the standalone card's full summary (which would just repeat the session line).
      const fuel = fuelByKey.get(fuelLogKey(today.date, sport));
      const fuelBit = fuel ? (fuel.needed ? ` · ⛽ fuel plan` : ` · 💧 water's fine`) : "";
      return `<li style="font-size:14px;margin:4px 0"><b>${escapeHtml(redact(p.title ?? sport))}</b>${escapeHtml(dur)}${wxBit}${fuelBit}</li>`;
    });
    todayBlock = todays.length
      ? `<div class="k" style="margin-bottom:4px">Today <a href="#plan" data-tab="plan" style="color:#1558d6;text-decoration:none;font-size:12px">see Plan →</a></div>
      <ul style="list-style:none;padding:0;margin:0 0 12px">${todayRows.join("")}</ul>`
      : `<div class="k" style="margin-bottom:12px">Today — nothing planned (rest day).</div>`;

    // Yesterday in one line — the verdict from the latest stored session readout; the full card is below.
    const latestFeedback = [...(sessionFeedbacks ?? [])].sort((a, b) => a.date.localeCompare(b.date)).pop();
    const ydLine = latestFeedback ? sessionFeedbackOneLine(latestFeedback) : null;
    yesterdayBlock = ydLine
      ? `<div class="k" style="margin-bottom:4px">Last session — ${escapeHtml(latestFeedback!.date.slice(5))} ${escapeHtml(latestFeedback!.sport)}</div>
      <div style="font-size:14px;color:#444;margin-bottom:2px">${escapeHtml(redact(ydLine))}</div>`
      : "";
  }

  // No insights AND the brief off → nothing to show; render no card rather than an empty shell.
  if (!insights && !briefEnabled) return "";

  // Order: the call → what to do → what changed → today's session → supporting signals → detail → yesterday.
  return `<div class="card" style="border-top:4px solid ${insights ? color : "#c8642d"}">
    <h2>Today — ${escapeHtml(today.date.slice(5))}</h2>
    ${verdictBlock}
    ${sinceBlock}
    ${todayBlock}
    ${driversChips}
    ${tilesBlock}
    ${narrativeBlock}
    ${yesterdayBlock}
  </div>`;
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

type UpcomingGoal = { event_name?: string; event_date?: string; priority?: unknown; dt: number };

/** Upcoming race goals in the dashboard's canonical order (date-sorted) — index i is "Race i+1" everywhere. */
function sortedUpcomingGoals(today: AthleteState): UpcomingGoal[] {
  const goals = (today.raw?.getRaceGoalEvent as { goals?: Array<{ event_name?: string; event_date?: string; priority?: unknown }> } | undefined)?.goals ?? [];
  return goals
    .filter((g) => g.event_date)
    .map((g) => ({ ...g, dt: daysTo(today.date, g.event_date!) }))
    .sort((a, b) => a.dt - b.dt);
}

/**
 * The real race names to scrub from free text in share view, in the same order the cards label them
 * "Race N": the date-sorted goal names first, then any profile race names not already covered (the LLM
 * can name a race from the profile too). Empty unless sharing — see {@link redactRaceNames}.
 */
function shareRaceNames(today: AthleteState, profile?: Profile): string[] {
  const names = sortedUpcomingGoals(today).map((g) => String(g.event_name ?? "").trim());
  const seen = new Set(names.map((n) => n.toLowerCase()));
  for (const r of profile?.races ?? []) {
    const n = String(r.name ?? "").trim();
    if (n && !seen.has(n.toLowerCase())) {
      names.push(n);
      seen.add(n.toLowerCase());
    }
  }
  return names.filter(Boolean);
}

export function renderDashboard({ window, decisions, insights, reactions, firstSeen, garminDays, fitSummaries, canFetchFit, weather, profile, autoSyncStaleMin, suppressed, weeklyReview, researchDigest, setupHealth, sessionFeedbacks, metricOverrides, coachRecs, coachRecsMerged, fuelLog, seasonReport, seasonProse, career, priorBrief, now, share }: DashboardInput): string {
  const today = window[window.length - 1];

  // Fuelling — week ahead (deterministic, no LLM on render): per-session pre/during/after from the
  // athlete's own inventory, only where a threshold is crossed. Heat comes from the week's forecast highs.
  const fuelInventory = loadInventory(profile);
  const tempByDate: Record<string, number | undefined> = {};
  for (const d of weather?.days ?? []) tempByDate[d.date.slice(0, 10)] = d.tempMaxC;
  const fuelKeyDates = new Set<string>(sortedUpcomingGoals(today).filter((g) => String(g.priority ?? "").toUpperCase() === "A" && g.event_date).map((g) => String(g.event_date).slice(0, 10)));
  const fuelPlans = buildWeekFuelPlans(upcomingPlanned(window, today.date, 7).sessions, {
    weightKg: today.weightKg.value,
    inventory: fuelInventory,
    prefs: loadFuelPrefs(profile?.fuelling),
    tempByDate,
    keyDates: fuelKeyDates,
  });
  const fuelByKey = new Map<string, FuelPlan>(fuelPlans.map((p) => [fuelLogKey(p.date ?? "", p.sport), p]));
  const loggedFuel = latestFuelByDateSport(fuelLog ?? []);
  // Fold per-session fuelling into the Week-ahead card when it's shown; otherwise the standalone
  // "next session" card is the fallback (so fuelling never disappears when the forecast is unavailable).
  const showWeather = !share && !!weather;
  const weatherCarriesFuel = showWeather && fuelInventory.length > 0 && fuelPlans.some((p) => p.needed);
  // Coach's note on the next COACHABLE session — deterministic "how to execute it" line (intensity
  // inferred from the title, modulated by today's readiness/form). We scan the not-done sessions in order
  // and attach to the FIRST that yields a note, so a leading gym/indoor day (Strength/Other → no note)
  // doesn't blank it for the week. The resolved index is threaded into renderWeather as the single source
  // of truth for which row the note lands on. Absent when there's no forecast/coachable session.
  let nextCoachNote: SessionNote | undefined;
  let coachNoteIdx = -1;
  if (showWeather && weather) {
    const plannedAhead = upcomingPlanned(window, today.date, 7).sessions;
    for (let i = 0; i < weather.sessions.length; i++) {
      const sv = weather.sessions[i];
      if (sv.done) continue;
      const planned = plannedAhead.find((p) => p.date.slice(0, 10) === sv.date.slice(0, 10) && p.sport === sv.sport);
      const note = planned ? nextSessionNote(planned, insights, today) : null;
      if (note) {
        nextCoachNote = note;
        coachNoteIdx = i;
        break;
      }
    }
  }
  const weatherHtml = showWeather
    ? renderWeather(weather, weatherCarriesFuel ? { byKey: fuelByKey, logged: loggedFuel, inventory: fuelInventory, hasApiKey: setupHealth?.hasApiKey } : undefined, share, nextCoachNote, coachNoteIdx)
    : "";
  const fuelCard = weatherCarriesFuel ? "" : renderFuelCard({ plans: fuelPlans, inventory: fuelInventory, fuelLog, share, hasApiKey: setupHealth?.hasApiKey });

  // Share view scrubs real race names out of every free-text card — not just the structured race cards.
  // The deep session feedback, an insight title ("Birmingham: behind target"), the headline and the
  // decisions log are generated prose that can name a race, so redact them all against the same ordered
  // "Race N" list the cards use. `redact` is the identity on the normal page (raceNames empty).
  const raceNames = share ? shareRaceNames(today, profile) : [];
  const redact = (s: string) => redactRaceNames(s, raceNames);

  // One synthesised "Today" call, computed once and shared: the header leads on it, the Top-insights box
  // marks the same finding (without repeating its recommendation), and "Set up & improve → This week"
  // excludes every finding already shown in the box — so a recommendation appears in exactly one place.
  const hl = insights ? coachHeadline(insights, today) : null;
  const leadFinding = insights ? insights.topFindings.find((f) => f.severity === "flag") ?? insights.topFindings.find((f) => f.severity === "watch") : undefined;
  const leadKey = leadFinding ? findingKey(leadFinding) : undefined;
  const surfacedInsightKeys = new Set<string>(insights ? insights.topFindings.slice(0, 5).map((f) => findingKey(f)) : []);
  if (leadKey) surfacedInsightKeys.add(leadKey);

  // Load by sport over a trailing 7 days (cutoff today-7 inclusive — the same window weekly.ts calls
  // "last 7 days", NOT the calendar week). Time in h:mm (user ask); a zero distance renders "—" not a
  // misleading 0.0 km. A bottom Total row sums sessions/time/distance across every sport. This is a
  // backward-looking recap, so it lives on the Performance tab (next to Trends), keeping the Plan tab
  // purely forward-looking.
  const load = activitiesLast7(today);
  const loadRows = [...load.entries()]
    .map(([s, e]) => `<tr><td>${s}</td><td>${e.n}</td><td>${hMin(e.min)}</td><td>${e.km > 0 ? `${e.km.toFixed(1)} km` : '<span class="muted">—</span>'}</td></tr>`)
    .join("");
  const loadTotal = [...load.values()].reduce((t, e) => ({ n: t.n + e.n, min: t.min + e.min, km: t.km + e.km }), { n: 0, min: 0, km: 0 });
  const loadTotalRow = load.size
    ? `<tr class="total"><td>Total</td><td>${loadTotal.n}</td><td>${hMin(loadTotal.min)}</td><td>${loadTotal.km > 0 ? `${loadTotal.km.toFixed(1)} km` : '<span class="muted">—</span>'}</td></tr>`
    : "";
  const loadCard = `<div class="card"><h2>Last 7 days — load by sport</h2>
  <table><tr class="k"><td>Sport</td><td>Sessions</td><td>Time</td><td>Distance</td></tr>${loadRows ? loadRows + loadTotalRow : '<tr><td colspan="4" class="muted">no activities</td></tr>'}</table>
</div>`;

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
  const raceRows = sortedUpcomingGoals(today)
    .map((g, i) => {
      // Share view: redact the real name + exact date (the identifying bits); keep the countdown + priority.
      const name = share ? `Race ${i + 1}` : escapeHtml(g.event_name ?? "—");
      const date = share ? '<span class="muted">—</span>' : escapeHtml(String(g.event_date ?? ""));
      return `<tr><td>${name}</td><td>${date}</td><td class="num">${g.dt >= 0 ? `T-${g.dt}d` : `${-g.dt}d ago`}</td><td>${escapeHtml(String(g.priority ?? ""))}</td></tr>`;
    })
    .join("");


  // The "Set up & improve" options, built once so the Decide-tab card and the nav/teaser count agree.
  const setupOpts = { suppressed, reactions, appliedKeys: executedSourceKeys(decisions), insights, surfacedInsightKeys, weeklyReview, researchDigest, setupHealth, liveThresholds: today.thresholds.value ?? undefined };
  // Decide-inbox count for the nav badge + the Today teaser: top insights shown (≤5) + coach recs +
  // data changes + setup items — the same sources the Decide tab renders, summed. Zero in share view,
  // where those interactive surfaces are hidden.
  const decideCount = share
    ? 0
    : (insights ? Math.min(insights.topFindings.length, 5) : 0) +
      (coachRecs?.length ?? 0) +
      detectMetricChanges(window, {}).filter((c) => !suppressed?.has(c.key) && !(c.metric in (metricOverrides ?? {}))).slice(0, 5).length +
      buildSetupItems(profile, setupOpts).length;
  // Of those, how many you HAVEN'T actioned yet — the same five sources, each filtered to its un-reacted
  // items (and, for an applyable training card, not already applied). Drives the "▲ N not yet actioned"
  // roll-up + the teaser suffix, so newness is visible at a glance and shrinks as you triage.
  const decideNewCount = share
    ? 0
    : (insights ? insights.topFindings.slice(0, 5).filter((f) => isDecideItemNew(findingKey(f), reactions)).length : 0) +
      (coachRecs ?? []).filter((r) => isDecideItemNew(r.key, reactions)).length +
      detectMetricChanges(window, {}).filter((c) => !suppressed?.has(c.key) && !(c.metric in (metricOverrides ?? {}))).slice(0, 5).filter((c) => isDecideItemNew(c.key, reactions)).length +
      buildSetupItems(profile, setupOpts).filter((it) => isDecideItemNew(it.key, reactions) && !setupOpts.appliedKeys.has(it.key)).length;

  // Decide tab as two halves so it reads "act on advice → housekeeping". The shared 👍/👎/💤/🚫 legend is
  // hoisted to the tab intro (below), so each card keeps only its own specific twist. The "This week"
  // coaching cues are lifted out of the setup hub to sit with the advice; "Finish setup" + "Worth
  // considering" stay in the housekeeping half alongside the (collapsed) data-change confirmations.
  const insightsBox = insights ? renderInsightsBox(insights, reactions, firstSeen, leadKey, redact) : "";
  const coachRecsHtml = renderCoachRecs(coachRecs ?? [], reactions, share, coachRecsMerged);
  const thisWeekHtml = renderSetupImprove(profile, share, setupOpts, {
    only: ["this_week"],
    heading: "This week",
    intro: `This week's coaching cues — your call. A training change offers a gated <b>Make this change</b> (it applies in AI Endurance after you confirm the exact edit, then shows <b>✓ applied</b> and stops asking); the rest take 👍/👎/💤.`,
  });
  // Expanded (not behind a disclosure): an auto-detected FTP/threshold change is a real decision, not
  // housekeeping to hide — surface it open so it isn't missed.
  const dataChangesHtml = renderDataChanges(window, reactions, suppressed, metricOverrides);
  const setupHousekeepingHtml = renderSetupImprove(profile, share, setupOpts, {
    only: ["finish_setup", "worth_considering"],
    heading: "Set up & improve",
    intro: `Loose ends and ideas. <b>Finish setup</b> tasks open for exactly how to do them and carry ✓ Done / 💤 Snooze / 🚫 Ignore — a gap you fill in AI Endurance clears itself on the next sync. <b>Worth considering</b> is read-only research.`,
  });
  const decisionsHalf = [insightsBox, coachRecsHtml, thisWeekHtml].filter((s) => s.trim()).join("\n");
  const housekeepingHalf = [dataChangesHtml, setupHousekeepingHtml].filter((s) => s.trim()).join("\n");

  // Performance tab, grouped into labelled sections so its nine cards read as clusters, not a flat
  // accordion wall: form & load → zones & capacity → race readiness → career. Each label only renders
  // when its group has content (an empty group shows nothing, not a bare heading).
  const trendsCard = collapse(`<div class="card"><h2>${trendsHeading(gar.length)}</h2>
  ${trendRows ? `<table>${trendRows}</table>` : '<div class="muted">Backfill the Garmin daily archive to populate trends (npm run backfill).</div>'}
  <div class="k" style="margin-top:8px">From the backfilled Garmin daily history.</div>
</div>`);
  // One "Races" card: your race calendar first, with the standard-distance Garmin predictions folded in
  // as a sub-section (the old standalone "Estimated race times" card). Per-race day pacing stays in the
  // "Estimated race splits" card below — it's race-specific and large enough to keep separate.
  const rp = today.racePredictions.value;
  const racePredInner = rp && rp.predictions.length
    ? `<div class="disch" style="margin-top:16px">Estimated race times</div>
    <table><tr class="k"><td>Distance</td><td>Predicted</td></tr>${rp.predictions.map((p) => `<tr><td>${escapeHtml(p.label)}</td><td class="num">${hms(p.timeSeconds)}</td></tr>`).join("")}</table>
    <div class="k" style="margin-top:8px">Garmin race predictor${rp.date ? ` (as of ${escapeHtml(rp.date)})` : ""} — MODEL estimate; watch the trend, and see "Estimated race splits" below for race-day pacing.</div>`
    : "";
  const racesCard = `<div class="card"><h2>Races</h2>
  ${racePredInner ? `<div class="disch">Your calendar</div>` : ""}<table><tr class="k"><td>Event</td><td>Date</td><td>Countdown</td><td>Priority</td></tr>${raceRows || '<tr><td colspan="4" class="muted">no race goals</td></tr>'}</table>
  ${racePredInner}
</div>`;
  const perfFormLoad = [insights ? collapse(renderSignals(insights)) : "", trendsCard, collapse(loadCard)].filter((s) => s.trim()).join("\n");
  const perfZones = [collapse(renderZones(today)), collapse(renderScores(today))].filter((s) => s.trim()).join("\n");
  const perfRace = [racesCard, insights ? collapse(renderSplits(insights, share)) : ""].filter((s) => s.trim()).join("\n");

  // Plan tab body. Every piece is best-effort (weather can fail to fetch, the season fold degrades to
  // nothing without a plan), so when ALL of them are absent — e.g. a render right after a restart, before
  // the weather/season data has loaded — fall back to a friendly note instead of a blank tab. (Moving the
  // always-present load recap to Performance is what made an empty Plan possible; this keeps it honest.)
  const seasonFold = seasonReport ? `<hr class="section-rule"><div class="section-rule-label">Season arc</div>${renderSeasonInner(seasonReport, share, seasonProse, true)}` : "";
  const planBody = [weatherHtml, fuelCard, renderWeeklyProse(seasonProse), seasonFold].filter((s) => s.trim()).join("\n");

  return `${pageHead(`Endurance Coach — ${today.date}`)}<body>
<header class="site-head"><div class="wrap">
  <div class="brand"><h1>Endurance Coach</h1>
    <div class="headmeta">${freshnessLine(today)}${share ? "" : ` · <a href="?share=1" style="color:#9a8a72;text-decoration:none">🔒 Share view</a>`}</div>
  </div>
  ${renderNav("today", { home: "", share, counts: { decide: decideCount } })}
  ${
    // The Sync button is interactive (live server behind it) — useless in the share/screenshot view, so
    // it's dropped there. sync()/autoSync() are defined in the page script bundle at the end of the body.
    // (Free-form Q&A lives in Claude Code via the MCP `ask` tool now, not a dashboard box.)
    share
      ? ""
      : `<div class="syncbar" style="display:flex;align-items:center;margin:10px 0 6px">
  <button id="syncbtn" class="syncbtn" onclick="sync()">🔄 Sync latest data</button>
  <span id="syncstatus" class="syncstatus"></span>
</div>
<script>
async function sync(note){
  var b=document.getElementById('syncbtn'), s=document.getElementById('syncstatus');
  if(!b||!s)return;
  b.disabled=true; b.textContent='Syncing…'; s.textContent=(note?note+' ':'')+'Pulling latest from AI Endurance + Garmin (~10s)…';
  try{ var r=await fetch('/refresh',{cache:'no-store'}); if(!r.ok) throw new Error('HTTP '+r.status);
    s.textContent='Done — reloading.'; location.reload(); }
  catch(e){ b.disabled=false; b.textContent='🔄 Sync latest data'; s.textContent='Sync failed: '+e+' (try again)'; }
}
function autoSync(min){ sync('Data is '+min+' min old — auto-refreshing:'); }
</script>`
  }
</div></header>
<main class="wrap">
${share ? `<div class="card sharebanner" style="background:#eef4ff;border:1px solid #cfe0ff;color:#244">🔒 <b>Share view</b> — real race names, exact dates and your location/weather are hidden, the analysis is intact. <a href="?">Exit share view</a></div>` : ""}
<section id="tab-today" class="tab on">

${renderHealthBanner(share ? null : assessHealthRisk(window))}
${renderTodayCard({ today, window, insights, hl, leadKey, decisions, garminDays, priorBrief: priorBrief ?? null, weather, fuelByKey, sessionFeedbacks, redact, now: now ?? Date.now(), briefEnabled: config.dailyBrief.enabled })}

${renderLastSession(window, insights, fitSummaries, canFetchFit, sessionFeedbacks, setupHealth?.hasApiKey, share, redact)}
${decideCount > 0 ? `<a class="card nav-link" data-tab="decide" href="#decide" style="display:block;text-decoration:none;color:#c8642d;font-weight:600">📥 ${decideCount} ${decideCount === 1 ? "item" : "items"} waiting on your call${decideNewCount > 0 ? ` · <span style="color:#1558d6">${decideNewCount} new</span>` : ""} →</a>` : ""}
</section>

<section id="tab-plan" class="tab">
<p class="tab-intro">Looking forward — this week's sessions, weather and fuelling, then the season ahead.</p>
${planBody || `<div class="card"><div class="muted">This week's sessions, weather and the season arc appear here once your training data has synced.${share ? "" : " Pull the latest with <b>🔄 Sync latest data</b> at the top, or give it a moment if the dashboard just restarted."}</div></div>`}
</section>

<section id="tab-decide" class="tab">
<p class="tab-intro">Everything waiting on your call — <b>one inbox</b>, in two halves: <b>decisions</b> to act on, then <b>housekeeping</b> (numbers to confirm, setup to finish). React on any card: 👍 Agree · 👎 Disagree · 💤 Snooze (~2 weeks) · 🚫 Ignore. A training change offers a gated <b>Make this change / Apply</b> instead of a plain agree; when AI Endurance and Garmin disagree on a number, ⚖️ picks which to use. Items you haven't actioned yet carry a <span class="newbadge">NEW</span> until you react.</p>
${decideNewCount > 0 ? `<div class="decide-new-rollup">▲ ${decideNewCount} not yet actioned</div>` : ""}
${decisionsHalf ? `<div class="section-rule-label">Decisions</div>${decisionsHalf}` : ""}
${housekeepingHalf ? `<hr class="section-rule"><div class="section-rule-label">Housekeeping</div>${housekeepingHalf}` : ""}
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
// Session switcher: load the picked session's deep dive into the #dive panel (the same /session-feedback
// route, now with a sport so a multi-sport day resolves to the right session). Stored → inline; otherwise
// it generates once and persists, exactly like the latest-session card.
async function selectSession(el){
  var dive=document.getElementById('dive'); if(!dive) return;
  var date=el.getAttribute('data-date'), sport=el.getAttribute('data-sport'), dur=el.getAttribute('data-dur');
  var chips=el.parentNode.querySelectorAll('.sess-chip');
  for(var i=0;i<chips.length;i++){chips[i].classList.remove('on');chips[i].style.border='1px solid #ddd';chips[i].style.background='#fff';}
  el.classList.add('on');el.style.border='1px solid #c8642d';el.style.background='#fdeee4';
  dive.innerHTML='<div class="k">🔍 Loading deep dive for '+esc(date)+' '+esc(sport)+'…</div>';
  try{
    var body={date:date,sport:sport}; if(dur) body.durationMin=Number(dur);
    var r=await fetch('/session-feedback',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    if(!r.ok) throw new Error('HTTP '+r.status);
    var j=await r.json(); var md=String(j.markdown||'').replace(/^# .*\\n+/,'');
    var tag=j.status==='ready'?' <span class="muted">('+(j.deep?'deep analysis':'summary')+')</span>':'';
    dive.innerHTML='<div class="k" style="margin:8px 0 4px">🔍 Deep dive — '+esc(date)+' '+esc(sport)+tag+'</div>'
      +'<div style="font-size:14px;color:#333;white-space:pre-wrap">'+mdToHtml(md||'No feedback available.')+'</div>';
  }catch(e){ dive.innerHTML='<div class="k">Could not load that session ('+esc(''+e)+'). Hit 🔄 Sync to retry.</div>'; }
}
function setReactionState(box,state){
  box.setAttribute('data-reaction-state',state);
  var like=box.querySelector('.agree');var dislike=box.querySelector('.disagree');
  like.classList.toggle('on',state==='like');dislike.classList.toggle('on',state==='dislike');
  // "New until you action it": reacting clears the NEW flag at once; clearing the reaction restores it.
  var actioned=state==='like'||state==='dislike';
  box.classList.toggle('is-new',!actioned);
  var nb=box.querySelector('.newbadge');if(nb)nb.style.display=actioned?'none':'';
}
// "see the data →" under the Today headline: the href switches to the Decide tab (hashchange handler), then
// we scroll its backing insight card into view. Best-effort — if there's no lead card, it just opens the tab.
function seeData(){setTimeout(function(){var el=document.getElementById('lead-insight');if(el)el.scrollIntoView({block:'center'});},80);}
async function feedback(btn){
  var box=btn.closest('.insight');var want=btn.getAttribute('data-reaction'); // like|dislike|snooze
  var cur=box.getAttribute('data-reaction-state')||'';
  // Clicking the active like/dislike again clears it (back to neutral); snooze is always a hide action.
  var send=(want!=='snooze'&&cur===want)?'clear':want;
  var key=box.getAttribute('data-key');var summary=box.getAttribute('data-summary');var family=box.getAttribute('data-family')||'';
  var span=box.querySelector('.reacted');span.textContent='…';
  try{await fetch('/insight-feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({key:key,reaction:send,summary:summary,family:family})});
    if(send==='snooze'){box.querySelectorAll('button').forEach(function(b){b.disabled=true;});box.style.opacity=0.5;span.textContent='💤 snoozed — hidden ~2wk';return;}
    if(send==='clear'){setReactionState(box,'');span.textContent='cleared';return;}
    setReactionState(box,send);span.textContent=send==='like'?'👍 liked':'👎 disliked (still shown)';
  }catch(err){span.textContent='error';}
}
// 🚫 Ignore on a "This week" card — a permanent hide (never resurfaces), carrying its family so the
// listening model attributes the dismissal. Distinct from 💤 Snooze (which lapses after ~2 weeks).
async function ignoreCard(btn){
  var box=btn.closest('.insight');box.querySelectorAll('button').forEach(function(b){b.disabled=true;});
  var span=box.querySelector('.reacted');if(span)span.textContent='…';
  try{await fetch('/insight-feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({key:box.getAttribute('data-key'),reaction:'dismiss',summary:box.getAttribute('data-summary'),family:box.getAttribute('data-family')||''})});
    box.style.opacity=0.4;if(span)span.textContent="🚫 ignored — won't show again";
  }catch(err){box.querySelectorAll('button').forEach(function(b){b.disabled=false;});if(span)span.textContent='error';}
}
// The three Finish-setup actions share one POST; only the reaction differs. done/dismiss hide forever,
// snooze hides ~2wk (server-side). done on an AI-Endurance gap ALSO writes it resolved into the profile.
async function setupAction(btn,reaction){
  var li=btn.closest('.setup-item');li.querySelectorAll('button').forEach(function(b){b.disabled=true;});
  try{await fetch('/insight-feedback',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({key:li.getAttribute('data-key'),reaction:reaction,summary:li.getAttribute('data-summary')})});
    li.style.opacity=0.4;li.style.textDecoration='line-through';
  }catch(err){li.querySelectorAll('button').forEach(function(b){b.disabled=false;});}
}
function completeSetup(btn){return setupAction(btn,'done');}   // ✓ Done — remembered forever
function dismissSetup(btn){return setupAction(btn,'snooze');}  // 💤 Snooze — hidden ~2 weeks
function ignoreSetup(btn){return setupAction(btn,'dismiss');}  // 🚫 Ignore — don't show again
async function pinOverride(btn){
  var box=btn.closest('.insight');var s=box.querySelector('.reacted');s.textContent='Pinning…';
  try{await fetch('/metric-override',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({metric:box.getAttribute('data-metric'),when:Number(box.getAttribute('data-when')),use:Number(box.getAttribute('data-use'))})});
    box.querySelectorAll('button').forEach(function(b){b.disabled=true;});box.style.opacity=0.6;
    s.textContent='📌 pinned — your value is used from the next sync';
  }catch(err){s.textContent='error';}
}
async function unpinOverride(btn){
  var box=btn.closest('.insight');var s=box.querySelector('.reacted');s.textContent='…';
  try{await fetch('/metric-override',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify({metric:box.getAttribute('data-metric'),clear:true})});
    btn.disabled=true;box.style.opacity=0.6;s.textContent='↩ un-pinned — accepting the auto value from the next sync';
  }catch(err){s.textContent='error';}
}
function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function proposalHtml(p){return '<div class="proposal" data-id="'+esc(p.id)+'"><b>'+esc(p.human||p.summary)+'</b>'
  +'<div class="k">✓ exact change, validated against your real plan — this is what gets written</div>'
  +'<div class="fdetail">'+esc(p.summary)+'</div>'
  +'<div class="ev">trade-off: '+esc(p.tradeoff)+'</div>'
  +((p.basis&&p.basis.length)?'<div class="ev">because: '+esc(p.basis.join('; '))+'</div>':'')
  +'<div class="ev" style="color:#bbb">the bold line is validated; the rationale above is AI-generated — read the bold line before applying</div>'
  +'<div class="acts"><button class="agree" onclick="confirmProposal(this)">✓ Apply to AI Endurance</button>'
  +'<button class="ignore" onclick="declineProposal(this)">✕ Dismiss</button><span class="reacted"></span></div></div>';}
async function actPlan(){
  var box=document.getElementById('proposals'); box.innerHTML='<div class="k">Drafting a plan change…</div>';
  try{var r=await fetch('/act',{method:'POST'}); var j=await r.json();
    if(!j.proposals||!j.proposals.length){box.innerHTML='<div class="k">'+esc(j.notes||'No change proposed.')+'</div>';return;}
    box.innerHTML=j.proposals.map(proposalHtml).join('');
  }catch(e){box.innerHTML='<div class="k">Error: '+esc(''+e)+'</div>';}
}
// "Make this change" on a training card: draft THIS specific recommendation into a concrete, validated plan
// edit (gated propose→confirm — confirming writes to AI Endurance). No match → the precise manual steps.
async function actItem(btn){
  var card=btn.closest('.insight');var box=card.querySelector('.item-proposals');var rec=card.getAttribute('data-rec');var cardKey=card.getAttribute('data-key');
  btn.disabled=true;box.innerHTML='<div class="k">Drafting the change…</div>';
  try{var r=await fetch('/act-item',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({recommendation:rec,cardKey:cardKey})});
    var j=await r.json();
    if(!j.proposals||!j.proposals.length){box.innerHTML='<div class="setup-action">'+esc(j.notes||'No automatic edit fits this — make the change in AI Endurance, then ↻ Sync.')+'</div>';btn.disabled=false;return;}
    box.innerHTML=j.proposals.map(proposalHtml).join('');
  }catch(e){box.innerHTML='<div class="k">Error: '+esc(''+e)+'</div>';btn.disabled=false;}
}
// Review → plan bridge: draft a gated plan change from how the LAST session landed. The server re-computes
// the deterministic signal from the session (the client sends only which session, never the trigger text),
// then runs the same propose→confirm proposer as "This week" — so the proposals render with the same
// Apply / Dismiss buttons.
async function sessionAdjust(btn){
  var box=btn.closest('.sessadjust');var pbox=box.querySelector('.item-proposals');
  var body={date:box.getAttribute('data-date'),sport:box.getAttribute('data-sport'),durationMin:Number(box.getAttribute('data-dur'))||void 0};
  btn.disabled=true;pbox.innerHTML='<div class="k">Drafting a plan change from this session…</div>';
  try{var r=await fetch('/session-adjust',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    var j=await r.json();
    if(!j.proposals||!j.proposals.length){pbox.innerHTML='<div class="k">'+esc(j.notes||'No automatic edit fits — make the change in AI Endurance, then ↻ Sync.')+'</div>';btn.disabled=false;return;}
    pbox.innerHTML=j.proposals.map(proposalHtml).join('');
  }catch(e){pbox.innerHTML='<div class="k">Error: '+esc(''+e)+'</div>';btn.disabled=false;}
}
async function confirmProposal(btn){var box=btn.closest('.proposal');var id=box.getAttribute('data-id');var s=box.querySelector('.reacted');
  var card=btn.closest('.insight');var cardKey=card?card.getAttribute('data-key'):null;s.textContent='Applying…';
  try{var r=await fetch('/confirm-proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id,cardKey:cardKey})});var j=await r.json();
    if(!j.ok){box.querySelectorAll('button').forEach(function(b){b.disabled=true;});s.textContent='failed: '+esc(j.error||'');return;}
    // Mark the source 'This week' card applied in place, so it doesn't re-offer the change before a reload.
    if(card){card.setAttribute('data-reaction-state','applied');var p=card.querySelector('.item-proposals');if(p)p.innerHTML='';var a=card.querySelector('.acts');if(a)a.innerHTML='<span class="reacted">✓ applied to AI Endurance</span>';}
    else{box.querySelectorAll('button').forEach(function(b){b.disabled=true;});s.textContent='✓ applied to AI Endurance';}
  }catch(e){s.textContent='error';}}
async function declineProposal(btn){var box=btn.closest('.proposal');var id=box.getAttribute('data-id');var s=box.querySelector('.reacted');
  try{await fetch('/decline-proposal',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:id})});
    box.querySelectorAll('button').forEach(function(b){b.disabled=true;});s.textContent='dismissed';box.style.opacity=0.5;}catch(e){s.textContent='error';}}
// Open-water temp: save the venue's latest reading live (no .env edit, no restart). The swim verdict
// uses it on the next page load, so we tell the user to reload rather than faking the new verdict here.
async function setWaterTemp(btn){var box=btn.closest('.watertemp');var inp=box.querySelector('.wt-input');var s=box.querySelector('.wt-status');
  var v=parseFloat(inp.value);if(!isFinite(v)){s.textContent='enter a number (°C)';return;}s.textContent='Saving…';
  try{var r=await fetch('/set-water-temp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tempC:v})});var j=await r.json();
    s.textContent=j.ok?('✓ saved ~'+j.waterTempC+'°C — reload to refresh the swim verdict'):'failed: '+esc(j.error||'');}catch(e){s.textContent='error';}}
async function clearWaterTemp(btn){var box=btn.closest('.watertemp');var s=box.querySelector('.wt-status');s.textContent='Clearing…';
  try{var r=await fetch('/set-water-temp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({clear:true})});var j=await r.json();
    s.textContent=j.ok?'✓ cleared — reload to go back to “check the venue”':'failed: '+esc(j.error||'');}catch(e){s.textContent='error';}}
// Confirm the MODEL estimate as-is (data-est carries the estimated value); same write path as a correction.
async function confirmWaterTemp(btn){var box=btn.closest('.watertemp');var s=box.querySelector('.wt-status');var v=parseFloat(btn.getAttribute('data-est'));
  if(!isFinite(v)){s.textContent='nothing to confirm';return;}s.textContent='Confirming…';
  try{var r=await fetch('/set-water-temp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tempC:v})});var j=await r.json();
    s.textContent=j.ok?('✓ confirmed ~'+j.waterTempC+'°C — reload to refresh the swim verdict'):'failed: '+esc(j.error||'');}catch(e){s.textContent='error';}}
</script>
</section>

<section id="tab-performance" class="tab">
<p class="tab-intro">Your numbers — form &amp; load, your zones &amp; capacity, race readiness, then career history &amp; PBs.</p>
${perfFormLoad ? `<div class="section-rule-label">Form &amp; load</div>${perfFormLoad}` : ""}
${perfZones ? `<hr class="section-rule"><div class="section-rule-label">Zones &amp; capacity</div>${perfZones}` : ""}
${perfRace ? `<hr class="section-rule"><div class="section-rule-label">Race readiness</div>${perfRace}` : ""}
${career ? `<hr class="section-rule"><div class="section-rule-label">Career &amp; PBs</div>${renderCareerInner(career, share)}` : ""}
</section>
<footer style="margin:24px 0 8px;padding:0;color:#aaa;font-size:12px;line-height:1.5">
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
<script>
// Section tabs: hash-driven, no round-trip. Without JS the body has no .js class, so every tab shows
// (a plain long scroll) — degrade-don't-crash. A nav link with a bare #hash switches in-page; a /#hash
// link (from a standalone page) navigates home and the load-time fromHash() opens that tab.
(function(){
  var ids=['today','plan','decide','performance'];
  function show(id){
    if(ids.indexOf(id)<0)id='today';
    for(var i=0;i<ids.length;i++){var sec=document.getElementById('tab-'+ids[i]);if(sec)sec.classList.toggle('on',ids[i]===id);}
    var links=document.querySelectorAll('.nav-link');
    for(var j=0;j<links.length;j++){links[j].classList.toggle('on',links[j].getAttribute('data-tab')===id);}
  }
  function fromHash(){show((location.hash||'').replace('#','')||'today');}
  document.body.classList.add('js');
  var nav=document.querySelectorAll('.nav-link');
  for(var k=0;k<nav.length;k++){nav[k].addEventListener('click',function(e){
    var t=this.getAttribute('data-tab'); var href=this.getAttribute('href')||'';
    if(href.charAt(0)==='#'){e.preventDefault();if(history.replaceState)history.replaceState(null,'','#'+t);show(t);window.scrollTo(0,0);}
  });}
  window.addEventListener('hashchange',fromHash);
  fromHash();
})();
</script>
</main>
</body></html>`;
}
