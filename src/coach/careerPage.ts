import { escapeHtml } from "../util/html.js";
import { pageShell } from "./shell.js";
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

/**
 * The career content WITHOUT the page shell — wrapped in `.career-inner` so its scoped styles apply
 * (see shell.ts). Reused two ways: the standalone /career page wraps it in {@link pageShell}, and the
 * dashboard's Performance tab folds it in directly under a section rule.
 */
export function renderCareerInner(data: CareerHistory | null, share = false): string {
  if (!data) {
    return `<div class="career-inner"><h1>Career &amp; PBs</h1>
      <div class="note">No career history yet. This page reads <code>data/career-history.json</code> — generate it from your TrainingPeaks / intervals.icu archive (plus your exported <code>.FIT</code> files for per-race performance &amp; splits) with <code>npm run career:build</code> (<code>scripts/build-career-history.ts</code>; see <code>SETUP.md</code> → "Career history"). The file is gitignored; <code>career-history.example.json</code> shows the shape.</div></div>`;
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

  return `<div class="career-inner"><h1>Career &amp; PBs</h1><div class="sub">${gen}</div>${shareNote}${races}${bests}${power}</div>`;
}

/** Standalone /career page: the career content in the shared site shell (nav highlights Performance). */
export function renderCareerPage(data: CareerHistory | null, share = false): string {
  return pageShell({ title: "Career & PBs", active: "performance", share }, renderCareerInner(data, share));
}
