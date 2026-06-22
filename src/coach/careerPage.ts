import { escapeHtml } from "../util/html.js";
import type { CareerHistory, PowerPoint, Race, BestValue, RaceSplit } from "./careerHistory.js";
import { isMultisport } from "./raceResults.js";

/**
 * Standalone read-only `/career` page: your race history + lifetime bests vs current form + an all-time
 * power curve. Linked from the dashboard ("Career & PBs →"). The data is loaded best-effort by the route
 * and may be `null` (→ a friendly empty state pointing at the generator). PURE; everything interpolated is
 * escaped (dashboard escaping convention).
 *
 * Share view (`?share=1`, mirroring the dashboard's screenshot mode): real event names and locations are
 * the identifying bits, so they're swapped for the neutral "Race N" label / hidden, and exact race dates
 * collapse to the YEAR (a fully-blanked date would make a career timeline meaningless). Bests/power are
 * just performance numbers — not identifying — so they're shown as-is.
 */

const DURATION_LABELS: Array<[number, string]> = [
  [5, "5s"], [15, "15s"], [30, "30s"], [60, "1m"], [120, "2m"], [300, "5m"],
  [480, "8m"], [600, "10m"], [1200, "20m"], [1800, "30m"], [3600, "60m"],
];

function durationLabel(sec: number): string {
  const hit = DURATION_LABELS.find(([s]) => s === sec);
  if (hit) return hit[1];
  return sec < 60 ? `${sec}s` : sec % 60 === 0 ? `${sec / 60}m` : `${Math.round(sec / 60)}m`;
}

function bestCell(v: BestValue | undefined, share: boolean): string {
  if (!v) return '<td class="num muted">—</td>';
  const when = !share && v.date ? `<div class="when">${escapeHtml(v.date)}</div>` : "";
  return `<td class="num">${escapeHtml(v.value)}${when}</td>`;
}

/** A collapsible per-interval split table (laps/lengths, or per-discipline legs) — pure HTML, no JS. */
function splitsBlock(splits: RaceSplit[]): string {
  const hasDist = splits.some((s) => s.dist);
  const hasPace = splits.some((s) => s.pace);
  const hasHr = splits.some((s) => s.hr != null);
  const hasW = splits.some((s) => s.watts != null);
  // [label, isNumericColumn] — only render columns that carry data, so a run doesn't show an empty W column.
  const cols: Array<[string, boolean]> = [["Split", false]];
  if (hasDist) cols.push(["Dist", true]);
  cols.push(["Time", true]);
  if (hasPace) cols.push(["Pace", true]);
  if (hasHr) cols.push(["HR", true]);
  if (hasW) cols.push(["W", true]);
  const thead = cols.map(([h, n]) => `<th${n ? ' class="num"' : ""}>${escapeHtml(h)}</th>`).join("");
  const body = splits
    .map((s) => {
      const cells = [`<td>${escapeHtml(s.label)}</td>`];
      if (hasDist) cells.push(`<td class="num">${s.dist ? escapeHtml(s.dist) : "—"}</td>`);
      cells.push(`<td class="num">${s.time ? escapeHtml(s.time) : "—"}</td>`);
      if (hasPace) cells.push(`<td class="num">${s.pace ? escapeHtml(s.pace) : "—"}</td>`);
      if (hasHr) cells.push(`<td class="num">${s.hr != null ? Math.round(s.hr) : "—"}</td>`);
      if (hasW) cells.push(`<td class="num">${s.watts != null ? Math.round(s.watts) : "—"}</td>`);
      return `<tr>${cells.join("")}</tr>`;
    })
    .join("");
  return `<details class="splits"><summary>Splits (${splits.length})</summary><table class="splitt"><thead><tr>${thead}</tr></thead><tbody>${body}</tbody></table></details>`;
}

/** Parse a pre-formatted clock string ("M:SS" or "H:MM:SS") back to whole seconds; null if it isn't one. */
function clockToSec(t: string): number | null {
  const parts = t.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  let sec = 0;
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    sec = sec * 60 + Number(p);
  }
  return sec;
}

/** Format whole seconds back to "M:SS" / "H:MM:SS" — mirrors the generator's clock() so the sum reads the same. */
function secToClock(sec: number): string {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${m}:${String(ss).padStart(2, "0")}`;
}

/**
 * Total time summed from the split times — but only when EVERY split carries a parseable clock time (a
 * partial set would mislead, so we return null and show nothing). Used for a multisport race whose overall
 * finish time wasn't hand-authored: summing the swim/bike/run legs gives a usable total — a touch under the
 * official finish, since transitions (T1/T2) aren't in the legs — so the Performance column shows a number
 * instead of just a "Splits" expander.
 */
function summedSplitTime(splits: RaceSplit[]): string | null {
  let sum = 0;
  for (const s of splits) {
    const sec = s.time ? clockToSec(s.time) : null;
    if (sec == null) return null;
    sum += sec;
  }
  return sum > 0 ? secToClock(sum) : null;
}

function raceRow(r: Race, idx: number, share: boolean): string {
  const when = share ? escapeHtml(r.date.slice(0, 4)) : escapeHtml(r.date);
  const event = share ? `Race ${idx + 1}` : escapeHtml(r.event ?? r.type);
  const loc = share ? '<span class="muted">—</span>' : escapeHtml(r.location ?? "—");
  const sub = !share && r.event ? `<div class="when">${escapeHtml(r.type)}</div>` : "";
  const conf = !share && r.confidence && r.confidence !== "confirmed" ? ` <span class="tag">${escapeHtml(r.confidence)}</span>` : "";
  const res = r.result ?? {};
  // No recorded finish time, but the splits are per-discipline legs (multisport)? Sum them so Performance
  // shows a total instead of "—". Honest-model labelled: it excludes transitions, so it reads a touch under
  // the official finish. Scoped to multisport on purpose — summing a *sample* of single-sport laps would
  // silently undercount, so we don't.
  const summed = !res.time && res.splits?.length && isMultisport(r.sport, r.type) ? summedSplitTime(res.splits) : null;
  const timeBit = res.time
    ? escapeHtml(res.time)
    : summed
      ? `≈${escapeHtml(summed)}${share ? "" : ` <span class="tag" title="Summed from the leg splits — excludes transitions (T1/T2), so a touch under the finish time">∑ splits</span>`}`
      : "";
  const perfBits = [
    timeBit,
    res.pace ? escapeHtml(res.pace) : "",
    res.distanceKm != null ? `${res.distanceKm.toFixed(res.distanceKm < 10 ? 2 : 1)} km` : "",
    res.avgW != null ? `${Math.round(res.avgW)} W` : "",
    res.avgHr != null ? `${Math.round(res.avgHr)} bpm` : "",
  ].filter(Boolean);
  // Provenance of derived numbers (hidden in share view) — ".FIT" or your activity "export".
  const via = !share && res.via ? ` <span class="tag" title="${res.via === "fit" ? "Pulled from your raw .FIT file" : "From your activity export"}">${res.via === "fit" ? ".FIT" : "export"}</span>` : "";
  const perf = perfBits.length ? perfBits.join(" · ") + via : '<span class="muted">—</span>';
  const splits = res.splits && res.splits.length ? splitsBlock(res.splits) : "";
  return `<tr><td>${when}</td><td>${event}${sub}${conf}</td><td>${loc}</td><td class="num">${perf}${splits}</td></tr>`;
}

/** Overlaid power-curve line chart (all-time / last-90d / season) over the standard durations. */
function powerCurveSvg(pc: NonNullable<CareerHistory["powerCurve"]>): string {
  const series: Array<{ name: string; color: string; pts: PowerPoint[] }> = [
    { name: "All-time", color: "#1f4e79", pts: pc.allTime },
    { name: "Last 90 days", color: "#c8642d", pts: pc.last90 ?? [] },
    { name: "Season", color: "#2e7d57", pts: pc.season ?? [] },
  ].filter((s) => s.pts.length);
  // X axis: the union of durations present, ascending (categorical, evenly spaced so short + long both read).
  const durs = [...new Set(series.flatMap((s) => s.pts.map((p) => p.durationSec)))].sort((a, b) => a - b);
  const wattsAll = series.flatMap((s) => s.pts.map((p) => p.watts));
  if (!durs.length || !wattsAll.length) return "";
  const W = 720, H = 320, ml = 48, mr = 16, mt = 16, mb = 40;
  const pw = W - ml - mr, ph = H - mt - mb;
  const wMax = Math.ceil(Math.max(...wattsAll) / 100) * 100;
  const xi = (sec: number) => ml + (durs.length === 1 ? pw / 2 : (pw * durs.indexOf(sec)) / (durs.length - 1));
  const y = (w: number) => mt + ph * (1 - w / wMax);
  const out: string[] = [`<svg viewBox="0 0 ${W} ${H}" class="pcurve" role="img" aria-label="Power curve">`];
  for (let g = 0; g <= wMax; g += wMax <= 600 ? 100 : 200) {
    const yy = y(g);
    out.push(`<line x1="${ml}" y1="${yy.toFixed(1)}" x2="${W - mr}" y2="${yy.toFixed(1)}" class="grid"/>`);
    out.push(`<text x="${ml - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" class="ax">${g}</text>`);
  }
  for (const sec of durs) {
    out.push(`<text x="${xi(sec).toFixed(1)}" y="${H - mb + 16}" text-anchor="middle" class="ax">${durationLabel(sec)}</text>`);
  }
  for (const s of series) {
    const pts = [...s.pts].sort((a, b) => a.durationSec - b.durationSec);
    const path = pts.map((p) => `${xi(p.durationSec).toFixed(1)},${y(p.watts).toFixed(1)}`).join(" ");
    out.push(`<polyline points="${path}" fill="none" stroke="${s.color}" stroke-width="2.5"/>`);
    for (const p of pts) out.push(`<circle cx="${xi(p.durationSec).toFixed(1)}" cy="${y(p.watts).toFixed(1)}" r="3" fill="${s.color}"/>`);
  }
  out.push("</svg>");
  const legend = series.map((s) => `<span class="leg"><span class="sw" style="background:${s.color}"></span>${escapeHtml(s.name)}</span>`).join("");
  return `<div class="pcwrap">${out.join("")}</div><div class="legend">${legend}</div>`;
}

const STYLE = `body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:820px;margin:0 auto;padding:26px 20px 64px;color:#2b2b2b;line-height:1.55;background:#f4f1ea}
h1{font-size:22px;margin:.1em 0 .1em}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:#999;margin:0 0 12px}
.sub{color:#777;font-size:13px;margin-bottom:18px}
a.back{display:inline-block;margin-bottom:14px;font-size:13px;color:#c8642d;text-decoration:none}
.card{background:#fff;border-radius:10px;padding:16px 18px;margin-bottom:16px;box-shadow:0 1px 3px rgba(0,0,0,.07)}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{padding:6px 7px;border-bottom:1px solid #f0ede5;text-align:left;vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#999;font-weight:600}
.num{text-align:right;font-variant-numeric:tabular-nums}.muted{color:#bbb}
.when{font-size:11px;color:#b1a78f}
.tag{font-size:10px;color:#9a7b3a;background:#faf3e3;border:1px solid #ecdcbf;border-radius:9px;padding:0 6px}
.pcwrap{overflow-x:auto}.pcurve{width:100%;height:auto;min-width:520px}
.pcurve .grid{stroke:#eee7d8}.pcurve .ax{fill:#9a8f78;font-size:11px}
.legend{margin-top:8px;font-size:12px;color:#666}.leg{margin-right:16px;white-space:nowrap}.sw{display:inline-block;width:12px;height:12px;border-radius:3px;margin-right:5px;vertical-align:-1px}
details.splits{margin-top:6px;text-align:left}details.splits>summary{cursor:pointer;font-size:12px;color:#c8642d}
table.splitt{margin-top:6px;font-size:12px}table.splitt td,table.splitt th{padding:3px 7px;border-bottom:1px solid #f4f1ea}
.note{background:#faf8f3;border-left:3px solid #e7d9c6;border-radius:5px;padding:12px 14px;font-size:14px;margin:0 0 18px}
code{background:#f4f1ea;border-radius:4px;padding:1px 5px;font-size:.92em}
.cols{display:flex;gap:16px;flex-wrap:wrap}.cols>div{flex:1;min-width:300px}`;

function shell(inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Career & PBs</title><style>${STYLE}</style></head><body><a class="back" href="/">← Back to the dashboard</a>${inner}</body></html>`;
}

export function renderCareerPage(data: CareerHistory | null, share = false): string {
  if (!data) {
    return shell(`<h1>Career &amp; PBs</h1>
      <div class="note">No career history yet. This page reads <code>data/career-history.json</code> — generate it from your TrainingPeaks / intervals.icu archive (plus your exported <code>.FIT</code> files for per-race performance &amp; splits) with <code>npm run career:build</code> (<code>scripts/build-career-history.ts</code>; see <code>SETUP.md</code> → "Career history"). The file is gitignored; <code>career-history.example.json</code> shows the shape.</div>`);
  }

  const seasonHdr = data.seasonYear ? `Season ${data.seasonYear}` : "Season";
  const gen = data.generatedAt ? `Built ${escapeHtml(data.generatedAt)} from your TrainingPeaks + intervals.icu archive.` : "";
  const shareNote = share
    ? `<div class="note">🔒 Share view — event names &amp; locations hidden, dates shown as year only. <a href="?">Exit</a></div>`
    : `<div class="sub" style="text-align:right;margin-top:-6px"><a href="?share=1" style="font-size:12px;color:#888">🔒 Share view</a></div>`;

  const races = data.races.length
    ? `<div class="card"><h2>Race history (${data.races.length})</h2>
        <table><thead><tr><th>Date</th><th>Race</th><th>Location</th><th class="num">Performance</th></tr></thead>
        <tbody>${data.races.map((r, i) => raceRow(r, i, share)).join("")}</tbody></table>
        <div class="sub" style="margin:10px 0 0">Performances are your own recorded numbers (time / pace / distance / power); locations not marked confirmed are nearest-town approximations from GPS. No official results were scraped.</div></div>`
    : "";

  const bests = data.bests.length
    ? `<div class="card"><h2>Bests vs current</h2><div class="cols">${data.bests
        .map(
          (b) => `<div><table><thead><tr><th>${escapeHtml(b.sport)}</th><th class="num">All-time</th><th class="num">Last 90d</th><th class="num">${escapeHtml(seasonHdr)}</th></tr></thead>
          <tbody>${b.rows
            .map((r) => `<tr><td>${escapeHtml(r.label)}</td>${bestCell(r.allTime, share)}${bestCell(r.last90, share)}${bestCell(r.season, share)}</tr>`)
            .join("")}</tbody></table></div>`,
        )
        .join("")}</div></div>`
    : "";

  const power = data.powerCurve
    ? `<div class="card"><h2>Power curve — best vs recent</h2>${powerCurveSvg(data.powerCurve)}
        <div class="sub" style="margin:8px 0 0">Mean-maximal power at each duration. All-time is your best ever; the recent lines show where you are now.</div></div>`
    : "";

  return shell(`<h1>Career &amp; PBs</h1><div class="sub">${gen}</div>${shareNote}${races}${bests}${power}`);
}
