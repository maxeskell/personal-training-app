import type { AthleteState, ActualActivity } from "../state/types.js";
import type { DecisionRecord } from "../state/decisionLog.js";
import type { InsightReport } from "../insights/engine.js";

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
}

function renderSignals(ins: InsightReport): string {
  const sevColor = (s: string) => (s === "flag" ? "#c0392b" : s === "watch" ? "#c98a00" : "#1a8a3a");
  const findings = ins.findings.length
    ? ins.findings
        .map(
          (f) =>
            `<div class="finding"><span class="badge" style="background:${sevColor(f.severity)}">${f.severity}</span>
             <b>${escapeHtml(f.title)}</b><div class="fdetail">${escapeHtml(f.detail)}</div>
             <div class="ev">${escapeHtml(f.evidence)}${f.recommendation ? " · → " + escapeHtml(f.recommendation) : ""}</div></div>`,
        )
        .join("")
    : `<div class="muted">No signals flagged — carry on.</div>`;

  const L = ins.load;
  const ctlSpark = L ? spark(L.series.map((p) => p.ctl), 160, 30) : "";
  const trend = (label: string, t: { recent: number | null; deltaPct: number | null; n: number }) =>
    t.recent == null
      ? ""
      : `<tr><td>${label}</td><td class="num">${t.recent}</td><td class="num">${t.deltaPct == null ? "—" : (t.deltaPct >= 0 ? "+" : "") + t.deltaPct + "%"}</td><td class="muted">${t.n} pts</td></tr>`;

  return `<div class="card"><h2>Signals (insight engine)</h2>
    ${findings}
    <div class="grid" style="margin-top:14px">
      <div><div class="k">Fitness (CTL)</div><div class="v">${L ? L.ctl : "—"}</div></div>
      <div><div class="k">Fatigue (ATL)</div><div class="v">${L ? L.atl : "—"}</div></div>
      <div><div class="k">Form (TSB)</div><div class="v">${L ? L.tsb : "—"}</div></div>
      <div><div class="k">CTL trend</div>${ctlSpark || '<span class="muted">—</span>'}</div>
    </div>
    <table style="margin-top:12px"><tr class="k"><td>Trend (recent vs prior)</td><td>Now</td><td>Δ</td><td></td></tr>
      ${trend("Run efficiency (EF)", ins.ef.run)}
      ${trend("Ride efficiency (EF)", ins.ef.ride)}
      ${trend("Run durability %", ins.durability.run)}
      ${trend("Run aerobic threshold (HR)", ins.threshold.run)}
    </table>
    <div class="k" style="margin-top:8px">CTL/ATL/TSB derived from daily ESS. EF on steady runs ≥40min. Durability/threshold from AI Endurance's DFA-α1. ACWR intentionally not used (validity).</div>
    ${renderAnalytics(ins)}
  </div>`;
}

/** New n=1 analytics layers (Q1–Q7): backtested monitoring rule, regime shifts, tri execution, taper. */
function renderAnalytics(ins: InsightReport): string {
  const m = ins.monitoring.best;
  const rule = m
    ? `<b>${escapeHtml(m.name)}</b> → lead ${m.lead}d · hit ${Math.round(m.hitRate * 100)}% · false-alarm ${Math.round(m.falseAlarmRate * 100)}% <span class="muted">(over ${ins.monitoring.days}d)</span>`
    : `<span class="muted">no backtested rule with skill yet (${ins.monitoring.days}d history)</span>`;
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

export function renderDashboard({ window, decisions, insights }: DashboardInput): string {
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
.finding{padding:8px 0;border-bottom:1px solid #f0ede5}.finding:last-child{border:0}
.badge{color:#fff;font-size:10px;text-transform:uppercase;letter-spacing:.05em;padding:2px 7px;border-radius:10px;margin-right:8px}
.fdetail{font-size:13px;color:#444;margin:3px 0}.ev{font-size:11px;color:#999}
.syncbtn{padding:8px 16px;border:0;border-radius:8px;background:#c8642d;color:#fff;font-size:14px;cursor:pointer}
.syncbtn:disabled{opacity:.55;cursor:default}
.syncstatus{margin-left:10px;font-size:13px;color:#888}
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
</script>

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

${insights ? renderSignals(insights) : ""}

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
