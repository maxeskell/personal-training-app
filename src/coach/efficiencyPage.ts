import { escapeHtml } from "./dashboardHelpers.js";
import { pageShell } from "./shell.js";
import { paceLabel, type PerformanceReport, type Confidence, type FixedHrSummary, type AetSummary } from "../insights/performanceHistory.js";

/**
 * Standalone read-only /efficiency page: efficiency & performance from the .FIT archive (output at a fixed
 * HR, critical power, durability, DFA-α1 aerobic threshold). Every metric shows its CONFIDENCE, why it has
 * that confidence, and the concrete steps that would raise it, because each one is a MODEL on noisy n=1
 * data and the honest answer is often "not enough data yet". Display-only, no scripts, all text escaped
 * (dashboard escaping convention). `report` null → an empty state that says how to build the history. Pure.
 */

const CONF: Record<Confidence, { label: string; color: string; blurb: string }> = {
  none: { label: "Not enough data", color: "#9a9a9a", blurb: "Don't read anything into this yet." },
  low: { label: "Low confidence", color: "#c0392b", blurb: "A rough pointer only; could easily be noise." },
  moderate: { label: "Moderate confidence", color: "#c98a00", blurb: "Probably real in direction; the exact number is soft." },
  high: { label: "High confidence", color: "#1e8449", blurb: "Consistent, well-covered data. Still a MODEL, not a lab test." },
};

const E = escapeHtml;

function badge(c: Confidence): string {
  const m = CONF[c];
  return `<span class="badge" style="background:${m.color}">${E(m.label)}</span><span class="eff-blurb">${E(m.blurb)}</span>`;
}

function lists(why: string[], improve: string[]): string {
  return `<div class="eff-lists"><div><b>Why this confidence</b><ul>${why.map((w) => `<li>${E(w)}</li>`).join("")}</ul></div>
<div><b>How to raise it</b><ul>${improve.map((w) => `<li>${E(w)}</li>`).join("")}</ul></div></div>`;
}

/** Date-scaled scatter + rolling-median line. `invert` puts lower values at the top (pace: lower s/km is better). */
export function seriesChart(points: Array<{ date: string; value: number }>, fmt: (v: number) => string, invert = false): string {
  if (points.length < 2) return `<p class="muted">Not enough points to chart.</p>`;
  const W = 560, H = 170, L = 52, R = 10, T = 10, B = 24;
  const ts = points.map((p) => Date.parse(`${p.date}T00:00:00Z`));
  const t0 = Math.min(...ts), t1 = Math.max(...ts) || t0 + 1;
  const vs = points.map((p) => p.value);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  const pad = (hi - lo || Math.abs(hi) * 0.05 || 1) * 0.15;
  lo -= pad;
  hi += pad;
  const x = (t: number) => L + ((t - t0) / (t1 - t0 || 1)) * (W - L - R);
  const y = (v: number) => {
    const f = (v - lo) / (hi - lo || 1);
    return T + (invert ? f : 1 - f) * (H - T - B);
  };
  const dots = points
    .map((p, i) => `<circle cx="${x(ts[i]).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="2.6" fill="#1558d6" opacity="0.55"><title>${E(`${p.date}: ${fmt(p.value)}`)}</title></circle>`)
    .join("");
  // Rolling median of the last 5 points: the line to read, so one odd session doesn't steer the eye.
  const roll = points.map((_, i) => {
    const w = vs.slice(Math.max(0, i - 4), i + 1).sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)];
  });
  const line = roll.map((v, i) => `${x(ts[i]).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const yLab = (v: number) => `<text x="${L - 6}" y="${y(v).toFixed(1)}" dy="3.5" font-size="10" text-anchor="end" fill="#888">${E(fmt(v))}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" class="eff-chart" role="img" aria-label="trend chart">
<line x1="${L}" y1="${H - B}" x2="${W - R}" y2="${H - B}" stroke="#ddd"/>
${yLab(lo + pad)}${yLab(hi - pad)}
<text x="${L}" y="${H - 6}" font-size="10" fill="#888">${E(points[0].date)}</text>
<text x="${W - R}" y="${H - 6}" font-size="10" fill="#888" text-anchor="end">${E(points[points.length - 1].date)}</text>
${dots}<polyline points="${line}" fill="none" stroke="#1558d6" stroke-width="2"/>
</svg><div class="muted eff-legend">Dots: one session each. Line: rolling median of 5 sessions.</div>`;
}

function fixedHrCard(f: FixedHrSummary): string {
  const isRun = f.unit === "min/km";
  const fmt = (v: number) => (isRun ? `${paceLabel(v)}/km` : `${Math.round(v)} W`);
  const trend =
    f.trendPctPer30d == null
      ? "—"
      : `${f.trendPctPer30d > 0 ? "+" : ""}${f.trendPctPer30d}% per 30 days (±${f.trendCiPct}%)${isRun ? " (+ = faster)" : ""}`;
  return `<div class="card"><h2>${E(f.label)}</h2>
<div class="eff-head"><div class="eff-big">${f.recent != null ? E(fmt(f.recent)) : "—"}</div>
<div class="eff-meta">at <b>${f.refHr ?? "—"} bpm</b>${f.refHrSource ? ` <span class="muted">(${E(f.refHrSource)})</span>` : ""} · median of the last 28 days<br>Trend: <b>${E(trend)}</b> · ${f.points.length} sessions${f.heatAdjusted ? " · heat-corrected" : ""}</div></div>
${badge(f.confidence)}
${seriesChart(f.points, fmt, false)}
${lists(f.why, f.improve)}</div>`;
}

function cpCard(r: PerformanceReport): string {
  const c = r.cp;
  const rows = c.points.map((p) => `<tr><td>${Math.round(p.durationS / 60)} min</td><td class="num">${p.watts} W</td><td class="num">${E(p.date)}</td></tr>`).join("");
  return `<div class="card"><h2>Critical power (last 90 days)</h2>
<div class="eff-head"><div class="eff-big">${c.cpW != null ? `${c.cpW} W` : "—"}</div>
<div class="eff-meta">W′ (work above CP) <b>${c.wPrimeKj ?? "—"} kJ</b>${c.p3OverP20 != null ? ` · best 3-min ÷ best 20-min ${c.p3OverP20}` : ""}<br>A threshold estimate between tests, from your best efforts. Compare with your set FTP.</div></div>
${badge(c.confidence)}
${rows ? `<table class="eff-table"><tr><th>Duration</th><th class="num">Best</th><th class="num">Set on</th></tr>${rows}</table>` : ""}
${lists(c.why, c.improve)}</div>`;
}

function durabilityCard(r: PerformanceReport): string {
  const d = r.durability;
  const cell = (w: number | null, pct: number | null) => (w == null ? "—" : `${w} W <span class="muted">(${pct ?? "—"}%)</span>`);
  const rows = d.rows.map((x) => `<tr><td>after ${x.kj} kJ</td><td class="num">${cell(x.p300, x.p300Pct)}</td><td class="num">${cell(x.p1200, x.p1200Pct)}</td><td class="num">${x.rides}</td></tr>`).join("");
  return `<div class="card"><h2>Durability (last 90 days)</h2>
<div class="eff-meta">How much of your fresh power is still there after a long ride's work. For a 70.3 this matters more than fresh FTP.</div>
${badge(d.confidence)}
<table class="eff-table"><tr><th></th><th class="num">Best 5 min</th><th class="num">Best 20 min</th><th class="num">Rides</th></tr>
<tr><td>fresh</td><td class="num">${d.fresh300 ?? "—"} W</td><td class="num">${d.fresh1200 ?? "—"} W</td><td></td></tr>${rows}</table>
${lists(d.why, d.improve)}</div>`;
}

function aetCard(a: AetSummary): string {
  const isRun = a.kind === "run";
  const out = a.recentOutput == null ? "" : ` ≈ ${isRun ? `${paceLabel(a.recentOutput)}/km` : `${a.recentOutput} W`}`;
  return `<div class="card"><h2>Aerobic threshold, ${isRun ? "run" : "bike"} (DFA-α1)</h2>
<div class="eff-head"><div class="eff-big">${a.recentHr != null ? `${a.recentHr} bpm` : "—"}</div>
<div class="eff-meta">${out ? `Output at that HR${E(out)} · ` : ""}median of the last 60 days · ${a.points.length} sessions with a reading in total<br>The top of zone 2: where easy stops being easy.</div></div>
${badge(a.confidence)}
${seriesChart(a.points.map((p) => ({ date: p.date, value: p.hr })), (v) => `${Math.round(v)} bpm`)}
${lists(a.why, a.improve)}</div>`;
}

const PAGE_CSS = `<style>
.eff-head{display:flex;gap:16px;align-items:center;margin-bottom:8px;flex-wrap:wrap}
.eff-big{font-size:30px;font-weight:600;font-variant-numeric:tabular-nums}
.eff-meta{color:#555;font-size:13px;line-height:1.5}
.eff-blurb{color:#666;font-size:12px}
.eff-chart{width:100%;max-width:560px;height:auto;display:block;margin:10px 0 2px}
.eff-legend{font-size:11px;margin-bottom:6px}
.eff-lists{display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:13px;margin-top:8px}
.eff-lists ul{margin:4px 0 0;padding-left:18px}.eff-lists li{margin-bottom:4px;line-height:1.4}
.eff-table{border-collapse:collapse;font-size:13px;margin:10px 0}.eff-table td,.eff-table th{padding:3px 10px 3px 0;text-align:left}
.eff-caveat{background:#fff8e6;border-left:3px solid #c98a00}
@media (max-width:620px){.eff-lists{grid-template-columns:1fr}}
</style>`;

export function renderEfficiencyInner(report: PerformanceReport | null): string {
  const caveats = `<div class="card eff-caveat"><h2>Read this first</h2><ul class="eff-meta">
<li>Every number here is a <b>MODEL</b> estimate from your own ride and run files. None is a lab measurement.</li>
<li>Each card has a <b>confidence</b> rating. Low or "not enough data" means don't act on it.</li>
<li>Indoor and outdoor power are kept apart: the Wattbike and the Rally pedals can read a few % differently.</li>
<li>Heat, hills, fatigue, sleep and caffeine all move heart rate. The heat correction only switches on when your own data shows a heat effect.</li>
<li>Trends need weeks of similar sessions. A single session moving is normal day-to-day noise.</li>
<li>For a decision that matters (zones, race targets), check against a proper test: the February lab ramp.</li></ul></div>`;
  if (!report || report.sessions === 0) {
    return `${PAGE_CSS}<div class="eff-inner"><h1>Efficiency &amp; performance</h1>${caveats}<div class="card"><h2>No data yet</h2><p class="eff-meta">No analysable rides or runs found. Build the history with
<code>npm run efficiency</code> (the first run parses the whole activity archive and takes a while). If the archive is empty, fill it first with <code>npm run archive:backfill</code>.</p></div></div>`;
  }
  const b = report.build;
  const sub = `${report.sessions} sessions analysed${b?.pending ? ` · ${b.pending} new files not parsed yet (run <code>npm run efficiency</code>)` : ""} · as of ${E(report.today)}`;
  return `${PAGE_CSS}<div class="eff-inner"><h1>Efficiency &amp; performance</h1><div class="sub">${sub}</div>
${caveats}
<div class="section-rule-label">Efficiency: same heart rate, more output?</div>
${report.fixedHr.map(fixedHrCard).join("")}
<div class="section-rule-label">Performance</div>
${cpCard(report)}${durabilityCard(report)}
<div class="section-rule-label">Aerobic threshold from beat-to-beat heart rate</div>
${report.aet.map(aetCard).join("")}
</div>`;
}

/** Standalone /efficiency page in the shared site shell (nav highlights Performance). */
export function renderEfficiencyPage(report: PerformanceReport | null, share = false): string {
  return pageShell({ title: "Efficiency & performance", active: "performance", share }, renderEfficiencyInner(report));
}
