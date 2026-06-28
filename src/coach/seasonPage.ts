import { escapeHtml } from "../util/html.js";
import { pageShell } from "./shell.js";
import { mdProse, ageDaysFrom } from "./dashboardHelpers.js";
import type { SeasonArcReport, Lever, CtlPoint } from "./seasonArc.js";
import type { YearStat } from "./careerHistory.js";

/** A persisted coach-prose report surfaced read-only on this page (markdown + its YYYY-MM-DD date). */
export interface ProseReport {
  markdown: string;
  date: string;
}

/** The two latest coach-prose reports surfaced near the top of `/season` (each optional → degrade cleanly). */
export interface SeasonProse {
  narrative?: ProseReport;
  weekly?: ProseReport;
}

/** A report older than this many days gets a subtle "stale — refresh" hint (it's a snapshot, be honest). */
const STALE_DAYS = 10;

/** Drop a single leading "# ..." H1 line (the cards carry their own title) before mdLite-rendering. Pure. */
export function stripLeadingH1(md: string): string {
  return md.replace(/^\s*#[^\n#][^\n]*\n+/, "");
}

/** Strip the weekly review's "## Next week" section to its end — those action bullets already surface on the
 *  dashboard, so we don't duplicate them here. Cuts from the heading to the next "## "/EOF. Pure. */
export function stripNextWeek(md: string): string {
  return md.replace(/\n#{1,3}\s*next week\b[^\n]*\n[\s\S]*?(?=\n#{1,3}\s|$)/i, "\n");
}

/**
 * Read-only `/season` page: the deterministic multi-season strategic review (see seasonArc.ts +
 * docs/specs/Season_Arc_Spec.md). Linked from the dashboard ("Season arc →"). PURE; everything
 * interpolated is escaped (dashboard escaping convention). Degrades to a friendly empty state when no
 * `season_plan` is set. `share` is accepted for route symmetry with /career but is currently a no-op:
 * this page can surface derived medical context (e.g. GLP-1 medication presence, blood-panel recency),
 * so it relies on the dashboard's auth gate rather than a share-redaction pass.
 */

const DOT: Record<Lever["status"], string> = { ok: "#1a8a3a", watch: "#c98a00", gap: "#c0392b", info: "#9a8f78" };

function countdown(days: number | undefined): string {
  if (days == null) return "";
  if (days < 0) return `${-days}d ago`;
  if (days < 90) return `${days}d`;
  return `~${Math.round(days / 30)} months`;
}

function trajectoryBars(traj: YearStat[], peakYear: number | undefined, curYear: number): string {
  const max = Math.max(1, ...traj.map((y) => y.hours ?? 0));
  return traj
    .map((y) => {
      const pct = Math.round(((y.hours ?? 0) / max) * 100);
      const cls = y.year === peakYear ? "fill peak" : y.year === curYear ? "fill cur" : "fill";
      return `<div class="bar"><span class="yr">${String(y.year).slice(2)}</span><span class="track"><span class="${cls}" style="width:${pct}%"></span></span><span class="val">${y.hours ?? 0}h</span></div>`;
    })
    .join("");
}

/**
 * CTL-over-time as an SVG: your actual chronic-load curve (solid blue) against the phase target (dashed
 * orange) with the current point marked and the gap drawn between them — "where you are vs where the plan
 * wants you", visually. Pure. Returns "" with fewer than 2 points (the caller keeps the numeric grid).
 * Honest: the target line only appears when a numeric phase target exists; otherwise it's just your curve.
 */
function ctlGraph(series: CtlPoint[] | undefined, ctlTarget?: number): string {
  const pts = (series ?? []).filter((p) => typeof p.v === "number" && Number.isFinite(p.v));
  if (pts.length < 2) return "";
  const W = 320, H = 120, L = 6, R = 50, T = 10, B = 8;
  const vals = pts.map((p) => p.v);
  let lo = Math.min(...vals);
  let hi = Math.max(...vals);
  if (ctlTarget != null) {
    lo = Math.min(lo, ctlTarget);
    hi = Math.max(hi, ctlTarget);
  }
  const pad = (hi - lo || 1) * 0.15;
  lo -= pad;
  hi += pad;
  const sp = hi - lo || 1;
  const x = (i: number) => L + (i / (pts.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - lo) / sp) * (H - T - B);
  const linePts = pts.map((p, i) => `${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");
  const baseY = (H - B).toFixed(1);
  const areaPts = `${L},${baseY} ${linePts} ${x(pts.length - 1).toFixed(1)},${baseY}`;
  const nowV = pts[pts.length - 1].v;
  const nowX = x(pts.length - 1);
  const nowY = y(nowV);
  const tgtY = ctlTarget != null ? y(ctlTarget) : null;
  const targetEls =
    tgtY != null
      ? `<line x1="${L}" y1="${tgtY.toFixed(1)}" x2="${(W - R).toFixed(1)}" y2="${tgtY.toFixed(1)}" stroke="#c98a00" stroke-width="1.5" stroke-dasharray="5 3"/>
      <line x1="${nowX.toFixed(1)}" y1="${nowY.toFixed(1)}" x2="${nowX.toFixed(1)}" y2="${tgtY.toFixed(1)}" stroke="#9a8f78" stroke-width="1" stroke-dasharray="2 2"/>
      <text x="${(W - R + 4).toFixed(1)}" y="${tgtY.toFixed(1)}" dy="3.5" font-size="10" fill="#c98a00">target ${Math.round(ctlTarget!)}</text>`
      : "";
  return `<svg viewBox="0 0 ${W} ${H}" style="width:100%;max-width:520px;height:auto;display:block;margin:4px 0 2px">
    <polygon points="${areaPts}" fill="#1558d6" opacity="0.07"/>
    ${targetEls}
    <polyline points="${linePts}" fill="none" stroke="#1558d6" stroke-width="2"/>
    <circle cx="${nowX.toFixed(1)}" cy="${nowY.toFixed(1)}" r="3.5" fill="#1558d6"/>
    <text x="${(W - R + 4).toFixed(1)}" y="${nowY.toFixed(1)}" dy="3.5" font-size="10" fill="#1558d6">now ${Math.round(nowV)}</text>
  </svg>`;
}

/**
 * One read-only coach-prose card (season narrative or weekly review). The markdown is pre-processed by
 * `prep` (strip H1 / the dashboard-duplicated "## Next week" section), then mdLite-rendered (escape-first,
 * so injected markup can't break out). Shows an honest "Updated {date}" stamp, with a subtle stale hint +
 * the refresh command once the report is older than {@link STALE_DAYS}. Returns "" for an absent report so
 * a missing piece renders nothing (degrade-don't-crash) rather than an empty card.
 */
function proseCard(
  title: string,
  prose: ProseReport | undefined,
  refreshCmd: string,
  prep: (md: string) => string,
  collapsed = false,
): string {
  if (!prose) return "";
  const body = mdProse(prep(prose.markdown).trim());
  if (!body.trim()) return "";
  const age = ageDaysFrom(prose.date, Date.now());
  const stale = age != null && age > STALE_DAYS
    ? ` <span class="stale">(stale — run <code>${escapeHtml(refreshCmd)}</code> to refresh)</span>`
    : "";
  const stamp = `Updated ${escapeHtml(prose.date)}${stale}`;
  // Collapsed: a long strategic read (the season narrative) folds behind a one-click summary so it doesn't
  // dominate the page; the weekly review stays open and prominent at the top.
  if (collapsed) {
    return `<details class="card"><summary style="cursor:pointer;font-weight:600;color:#555">${escapeHtml(title)} <span class="stamp" style="font-weight:400">${stamp}</span></summary>
      <div class="prose" style="margin-top:10px">${body}</div></details>`;
  }
  return `<div class="card"><h2>${escapeHtml(title)}</h2>
    <div class="stamp">${stamp}</div>
    <div class="prose">${body}</div></div>`;
}

/** Standalone /season page: the season-arc content in the shared site shell (nav highlights Plan). */
export function renderSeasonPage(report: SeasonArcReport, share = false, prose?: SeasonProse): string {
  return pageShell({ title: "Season arc", active: "plan", share }, renderSeasonInner(report, share, prose));
}

/**
 * The "This week" coach-prose card (the latest weekly review, with its dashboard-duplicated "## Next week"
 * section stripped). It's a *this-week* read, so the dashboard lifts it up into the Plan tab's this-week
 * block — above the season-arc fold — and tells {@link renderSeasonInner} to omit it there (`omitWeekly`).
 * The standalone /season page keeps it at the top instead. Returns "" when there's no weekly report.
 */
export function renderWeeklyProse(prose?: SeasonProse): string {
  return proseCard("This week", prose?.weekly, "npm run weekly", (md) => stripNextWeek(stripLeadingH1(md)));
}

/**
 * The season-arc content WITHOUT the page shell — wrapped in `.season-inner` so its scoped styles apply
 * (see shell.ts). Reused two ways: the standalone /season page wraps it in {@link pageShell}, and the
 * dashboard's Plan tab folds it in directly under a section rule.
 */
export function renderSeasonInner(report: SeasonArcReport, share = false, prose?: SeasonProse, omitWeekly = false): string {
  // `share` is accepted for route symmetry but is a no-op here, as on the rest of this auth-gated page
  // (see the file header): the prose cards follow the same no-redaction convention as the existing cards.
  void share;
  const r = report;

  // This week's review goes FIRST and stays open (the most recent, most actionable read). The longer
  // multi-season narrative folds into a collapsed "full read" lower down so it doesn't bloat the page.
  // Each degrades to nothing when its report is absent or unreadable. On the dashboard the weekly card is
  // lifted up into the Plan tab's this-week block (above this fold), so `omitWeekly` drops it from here to
  // avoid showing it twice; the standalone /season page keeps it.
  const weeklyCard = omitWeekly ? "" : renderWeeklyProse(prose);
  const narrativeCard = proseCard("Coach's full season read", prose?.narrative, "npm run season", stripLeadingH1, true);

  const planless = !r.hasPlan
    ? `<div class="note">No multi-season plan yet. Add a <code>season_plan</code> block to <code>profile.local.yaml</code> (horizon goal + dated phases with a text <code>ctl_target</code>) — see <code>profile.example.yaml</code> and <code>SETUP.md → "Season arc"</code>. The chronic-load, trajectory and lever sections below still work without it.</div>`
    : "";

  const horizon = r.hasPlan && r.horizonGoal
    ? `<div class="card"><h2>Horizon</h2><div class="big">${escapeHtml(r.horizonGoal)}</div>${
        r.targetDate ? `<div class="sub" style="margin:4px 0 0">${escapeHtml(r.targetDate)} · ${escapeHtml(countdown(r.daysToTarget))} out</div>` : ""
      }</div>`
    : "";

  // Focus shows once, inside "This phase". `r.focus` IS the phase's own focus when the plan sets one
  // (see seasonArc.ts) and otherwise a derived CTL-gap nudge, so a single line covers both — no separate
  // "Focus now" card repeating the same string. The fallback `focus` card below only fires when there's
  // no active phase to host it.
  const phase = r.activePhase
    ? `<div class="card"><h2>This phase</h2>
        <div class="big" style="font-size:20px">${escapeHtml(r.activePhase.name ?? "—")}</div>
        ${r.focus ? `<div class="focus" style="margin:6px 0 8px">${escapeHtml(r.focus)}</div>` : ""}
        <div class="grid">
          ${r.activePhase.ctlTargetText ? `<div><div class="k">CTL target</div><div class="v">${escapeHtml(r.activePhase.ctlTargetText)}</div></div>` : ""}
          ${r.activePhase.until ? `<div><div class="k">Until</div><div class="v">${escapeHtml(r.activePhase.until)} <span class="unit">(${escapeHtml(countdown(r.activePhase.daysLeft))})</span></div></div>` : ""}
        </div></div>`
    : "";

  const trendCls = r.ctlTrend ? `trend-${r.ctlTrend}` : "";
  const trendArrow = r.ctlTrend === "rising" ? "↗ rising" : r.ctlTrend === "falling" ? "↘ falling" : r.ctlTrend === "flat" ? "→ flat" : "—";
  const graph = ctlGraph(r.ctlSeries, r.ctlTarget);
  const ctl = r.ctlNow != null || r.ctlTarget != null
    ? `<div class="card"><h2>Chronic load (CTL) — where you are vs where the plan wants you</h2>
        ${graph}
        <div class="grid"${graph ? ' style="margin-top:6px"' : ""}>
          <div><div class="k">Now</div><div class="big">${r.ctlNow != null ? Math.round(r.ctlNow) : "—"}</div></div>
          <div><div class="k">Trend</div><div class="v ${trendCls}">${trendArrow}</div></div>
          <div><div class="k">Phase target</div><div class="v">${r.ctlTarget != null ? r.ctlTarget : "—"}</div></div>
          <div><div class="k">Gap</div><div class="v">${r.ctlGap != null ? (r.ctlGap >= 0 ? `+${r.ctlGap}` : r.ctlGap) : "—"}</div></div>
        </div>
        <div class="sub" style="margin:8px 0 0">${graph ? "Blue = your CTL over recent weeks; dashed orange = the phase target, with the gap between them. " : ""}CTL is the platform's training-load MODEL — the multi-season game is raising it patiently and defending it, not spiking any single block.</div></div>`
    : "";

  const curYear = Number((r.currentYear?.year ?? new Date().getFullYear()));
  const traj = r.trajectory && r.trajectory.length
    ? `<div class="card"><h2>The long arc (annual hours)</h2>
        ${r.consistencyNote ? `<div class="sub" style="margin:-4px 0 10px">${escapeHtml(r.consistencyNote)}</div>` : ""}
        ${trajectoryBars(r.trajectory, r.peakYear?.year, curYear)}
        <div class="sub" style="margin:8px 0 0">Green = your peak year · orange = this year. Raising the floor of an average year beats any single big block.</div></div>`
    : "";

  const levers = r.levers.length
    ? `<div class="card"><h2>Structural levers</h2>${r.levers
        .map((l) => `<div class="lever"><span class="dot" style="background:${DOT[l.status]}"></span><span><span class="nm">${escapeHtml(l.name)}</span> ${escapeHtml(l.note)}</span></div>`)
        .join("")}</div>`
    : "";

  // Only when there's no active phase to fold the focus into (otherwise it'd repeat the phase-card line).
  const focus = r.focus && !r.activePhase ? `<div class="card"><h2>Focus now</h2><div class="focus">${escapeHtml(r.focus)}</div></div>` : "";
  const flags = r.flags.length
    ? `<div class="card"><h2>Watch (multi-season risks)</h2>${r.flags.map((f) => `<div class="flag">${escapeHtml(f)}</div>`).join("")}</div>`
    : "";

  // Reads top-down by narrowing focus: this week (lifted to the Plan tab on the dashboard) → the anchor
  // (where you're headed + the phase you're in, with its focus) → the CTL gap-to-target graph → the
  // structural levers + multi-season risks → the deep strategic read (collapsed) → and finally the long
  // arc of annual hours at the very bottom (the slowest-moving context).
  return `<div class="season-inner"><h1>Season arc</h1><div class="sub">Your plan, your numbers — the multi-season view.</div>${planless}${weeklyCard}${horizon}${phase}${focus}${ctl}${levers}${flags}${narrativeCard}${traj}</div>`;
}
