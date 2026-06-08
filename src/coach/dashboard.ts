import type { AthleteState, ActualActivity } from "../state/types.js";
import type { DecisionRecord } from "../state/decisionLog.js";

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
}

export function renderDashboard({ window, decisions }: DashboardInput): string {
  const today = window[window.length - 1];

  // Today: latest readiness note + headline signals.
  const lastReadiness = [...decisions].reverse().find((d) => d.kind === "readiness");
  const verdictWord = lastReadiness?.summary.split(":")[0]?.trim().toLowerCase() ?? "unknown";
  const verdictColor =
    verdictWord === "green" ? "#1a8a3a" : verdictWord === "amber" ? "#c98a00" : verdictWord === "red" ? "#c0392b" : "#777";
  const r = today.recovery.value;

  // Week: load by sport.
  const load = activitiesLast7(today);
  const loadRows = [...load.entries()]
    .map(([s, e]) => `<tr><td>${s}</td><td>${e.n}</td><td>${Math.round(e.min)} min</td><td>${e.km.toFixed(1)} km</td></tr>`)
    .join("");

  // Trends.
  const series = (pick: (s: AthleteState) => number | null | undefined) => window.map(pick);
  const trendRow = (label: string, pick: (s: AthleteState) => number | null | undefined, d = 0) => {
    const vals = series(pick);
    const last = [...vals].reverse().find((v) => v != null);
    return `<tr><td>${label}</td><td>${spark(vals)}</td><td class="num">${last == null ? "—" : last.toFixed(d)}</td></tr>`;
  };

  // Race: next goals + countdown.
  const goals = (today.raw?.getRaceGoalEvent as { goals?: Array<{ event_name?: string; event_date?: string; priority?: unknown }> } | undefined)?.goals ?? [];
  const raceRows = goals
    .filter((g) => g.event_date)
    .map((g) => ({ ...g, dt: daysTo(today.date, g.event_date!) }))
    .sort((a, b) => a.dt - b.dt)
    .map(
      (g) =>
        `<tr><td>${g.event_name ?? "—"}</td><td>${g.event_date}</td><td class="num">${g.dt >= 0 ? `T-${g.dt}d` : `${-g.dt}d ago`}</td><td>${String(g.priority ?? "")}</td></tr>`,
    )
    .join("");

  const recentDecisions = [...decisions]
    .reverse()
    .slice(0, 8)
    .map((d) => `<tr><td>${d.kind}</td><td>${d.status}</td><td>${escapeHtml((d.summary ?? "").slice(0, 90))}</td></tr>`)
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
</style></head><body>
<h1>Endurance Coach</h1><div class="sub">as of ${today.assembledAt}</div>

<div class="card"><h2>Today</h2>
  <div class="verdict"><span class="dot" style="background:${verdictColor}"></span>
    <span class="big" style="color:${verdictColor}">${verdictWord}</span></div>
  <p style="font-size:14px;color:#444;margin:10px 0 14px">${escapeHtml(lastReadiness?.summary.split(":").slice(1).join(":").trim() ?? "Run readiness to populate.")}</p>
  <div class="grid">
    <div><div class="k">HRV (ms)</div><div class="v">${fmt(today.hrvOvernight.value)}</div></div>
    <div><div class="k">Resting HR</div><div class="v">${fmt(today.restingHr.value)}</div></div>
    <div><div class="k">Sleep (h)</div><div class="v">${fmt(today.sleep.value?.hours, 1)}</div></div>
    <div><div class="k">Cardio rec.</div><div class="v">${fmt(r?.cardioRecovery)}</div></div>
    <div><div class="k">Run ortho.</div><div class="v">${fmt(r?.orthopedic?.run)}</div></div>
  </div>
</div>

<div class="card"><h2>This week — load by sport</h2>
  <table><tr class="k"><td>Sport</td><td>Sessions</td><td>Time</td><td>Distance</td></tr>${loadRows || '<tr><td colspan="4" class="muted">no activities</td></tr>'}</table>
</div>

<div class="card"><h2>Trends (last ${window.length} days)</h2>
  <table>
    ${trendRow("HRV (ms)", (s) => s.hrvOvernight.value)}
    ${trendRow("Resting HR", (s) => s.restingHr.value)}
    ${trendRow("Sleep (h)", (s) => s.sleep.value?.hours, 1)}
    ${trendRow("Cardio recovery", (s) => s.recovery.value?.cardioRecovery)}
    ${trendRow("Run orthopedic", (s) => s.recovery.value?.orthopedic?.run)}
    ${trendRow("Weight (kg)", (s) => s.weightKg.value, 1)}
  </table>
  <div class="k" style="margin-top:8px">Weight is a trend, never a daily target.</div>
</div>

<div class="card"><h2>Race</h2>
  <table><tr class="k"><td>Event</td><td>Date</td><td>Countdown</td><td>Priority</td></tr>${raceRows || '<tr><td colspan="4" class="muted">no race goals</td></tr>'}</table>
</div>

<div class="card"><h2>Recent decisions</h2>
  <table><tr class="k"><td>Kind</td><td>Status</td><td>Summary</td></tr>${recentDecisions || '<tr><td colspan="3" class="muted">none yet</td></tr>'}</table>
</div>
</body></html>`;
}

function fmt(n: number | null | undefined, d = 0): string {
  return n == null ? "—" : n.toFixed(d);
}
function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}
