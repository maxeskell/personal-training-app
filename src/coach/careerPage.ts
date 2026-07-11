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
  // Finishing position (official results, hand-authored) — hidden in share view alongside the other
  // identifying bits (a placing + event combination narrows who you are).
  const pos = !share && r.position ? `<div class="when">${escapeHtml(r.position)}</div>` : "";
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
  return `<tr><td>${when}</td><td>${event}${sub}${pos}${conf}</td><td>${loc}</td><td class="num">${perf}${splits}</td></tr>`;
}

/** One overlaid power-curve line: a name, a stroke colour, and the mean-maximal points. */
export interface PowerSeries {
  name: string;
  color: string;
  pts: PowerPoint[];
}

/**
 * Collapse power-curve series that are IDENTICAL point-for-point (same durations + same watts) into a single
 * line. This is the common case, not an edge one: whenever every season best was also set inside the last 90
 * days, the Last-90-days and Season curves coincide exactly — and drawn naively the one painted last sits
 * directly on top of the other, so a real line looks like it's "not showing" (the classic bug: only two of
 * three lines visible). Merging is the honest fix — one line, its label joining the coincident names
 * ("Last 90 days / Season"), so the chart says *why* there are fewer lines than series rather than hiding one.
 *
 * Pure + deterministic: order-preserving by first appearance, and the first series in a coincident group keeps
 * its colour. Empty series should be filtered out before this (an empty curve isn't a real line to merge).
 */
export function mergeCoincidentSeries(series: PowerSeries[]): PowerSeries[] {
  const sig = (s: PowerSeries) =>
    [...s.pts].sort((a, b) => a.durationSec - b.durationSec).map((p) => `${p.durationSec}:${p.watts}`).join("|");
  const out: PowerSeries[] = [];
  const bySig = new Map<string, PowerSeries>();
  for (const s of series) {
    const existing = bySig.get(sig(s));
    if (existing) existing.name = `${existing.name} / ${s.name}`;
    else {
      const kept: PowerSeries = { name: s.name, color: s.color, pts: s.pts };
      bySig.set(sig(s), kept);
      out.push(kept);
    }
  }
  return out;
}

/** A "nice" round gridline interval (1 / 2 / 5 × 10ⁿ) that splits `range` into roughly `target` divisions. */
function niceStep(range: number, target = 5): number {
  const raw = range > 0 ? range / target : 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const mult = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return mult * mag;
}

/** Overlaid power-curve line chart (all-time / last-90d / season) over the standard durations. Coincident
 *  curves are merged into one labelled line (see {@link mergeCoincidentSeries}) so none hides another.
 *  `seasonYear` (when known) year-stamps the Season line's legend + tooltip so its window isn't ambiguous. */
function powerCurveSvg(pc: NonNullable<CareerHistory["powerCurve"]>, seasonYear?: number): string {
  const series = mergeCoincidentSeries(
    [
      { name: "All-time", color: "#1f4e79", pts: pc.allTime },
      { name: "Last 90 days", color: "#c8642d", pts: pc.last90 ?? [] },
      { name: seasonYear ? `Season ${seasonYear}` : "Season", color: "#2e7d57", pts: pc.season ?? [] },
    ].filter((s) => s.pts.length),
  );
  // Per-line hover tooltip spelling out the window each curve is drawn over (the difference the legend can't show).
  const tip = (name: string) => {
    const parts: string[] = [];
    if (/All-time/.test(name)) parts.push("every ride with power in your archive");
    if (/Last 90 days/.test(name)) parts.push("a rolling 90-day window");
    if (/Season/.test(name)) parts.push(seasonYear ? `${seasonYear} to date (since 1 Jan)` : "this year to date (since 1 Jan)");
    return `${name} — best mean-maximal power over ${parts.join(" + ")}`;
  };
  // X axis: the union of durations present, ascending (categorical, evenly spaced so short + long both read).
  const durs = [...new Set(series.flatMap((s) => s.pts.map((p) => p.durationSec)))].sort((a, b) => a - b);
  const wattsAll = series.flatMap((s) => s.pts.map((p) => p.watts));
  if (!durs.length || !wattsAll.length) return "";
  const W = 720, H = 320, ml = 48, mr = 16, mt = 20, mb = 40;
  const pw = W - ml - mr, ph = H - mt - mb;
  // Y axis floored to the data, NOT to zero. A power curve compares lines whose interesting variation lives
  // hundreds of watts above zero, so a 0-based axis squashes them into the top band (and crushes the long
  // durations, where the lines converge, into an unreadable smear). We bracket the data with round gridlines
  // instead — the lines spread out and separate — and print every point's exact figure so nothing is inferred.
  const dataMin = Math.min(...wattsAll), dataMax = Math.max(...wattsAll);
  const step = niceStep(dataMax - dataMin);
  const wLo = Math.max(0, Math.floor(dataMin / step) * step);
  const wHi = Math.max(wLo + step, Math.ceil(dataMax / step) * step);
  const xi = (sec: number) => ml + (durs.length === 1 ? pw / 2 : (pw * durs.indexOf(sec)) / (durs.length - 1));
  const y = (w: number) => mt + ph * (1 - (w - wLo) / (wHi - wLo));
  const out: string[] = [`<svg viewBox="0 0 ${W} ${H}" class="pcurve" role="img" aria-label="Power curve">`];
  for (let g = wLo; g <= wHi + 1e-6; g += step) {
    const yy = y(g);
    out.push(`<line x1="${ml}" y1="${yy.toFixed(1)}" x2="${W - mr}" y2="${yy.toFixed(1)}" class="grid"/>`);
    out.push(`<text x="${ml - 6}" y="${(yy + 4).toFixed(1)}" text-anchor="end" class="ax">${g}</text>`);
  }
  for (const sec of durs) {
    out.push(`<text x="${xi(sec).toFixed(1)}" y="${H - mb + 16}" text-anchor="middle" class="ax">${durationLabel(sec)}</text>`);
  }
  // Data-label placement, resolved per duration-column so overlaid lines that converge don't stack their
  // figures on top of each other. In each column the highest point labels ABOVE its dot; the rest pack
  // DOWNWARD below their dots with a minimum gap, and the stack is lifted back up if it would spill past
  // the plot floor. Keyed by "seriesIndex:durationSec" so each point looks up its own resolved y.
  const LH = 11, topLim = mt + 4, botLim = H - mb + 4; // label baseline bounds
  const labelY = new Map<string, number>();
  for (const sec of durs) {
    // Group the column's points by watts: series that coincide here (e.g. Last-90 == Season) share one label
    // rather than printing the same number twice on the same dot. Groups descend by watts (strongest first).
    const groups: Array<{ w: number; sis: number[] }> = [];
    for (const { si, w } of series
      .map((s, si) => ({ si, w: s.pts.find((q) => q.durationSec === sec)?.watts }))
      .filter((c): c is { si: number; w: number } => c.w != null)
      .sort((a, b) => b.w - a.w)) {
      const g = groups.find((x) => x.w === w);
      if (g) g.sis.push(si);
      else groups.push({ w, sis: [si] });
    }
    if (!groups.length) continue;
    const setAll = (sis: number[], yy: number) => sis.forEach((si) => labelY.set(`${si}:${sec}`, yy));
    const y0 = Math.max(y(groups[0].w) - 7, topLim); // strongest group: label above its dot
    setAll(groups[0].sis, y0);
    let cursor = y0;
    for (let i = 1; i < groups.length; i++) {
      const yy = Math.max(y(groups[i].w) + 13, cursor + LH); // pack the rest downward, min gap LH
      setAll(groups[i].sis, yy);
      cursor = yy;
    }
    if (cursor > botLim) {
      // Below-stack spilled past the floor: lift it, but never above `y0 + i·LH` so it can't collide upward.
      const shift = cursor - botLim;
      for (let i = 1; i < groups.length; i++)
        setAll(groups[i].sis, Math.max(labelY.get(`${groups[i].sis[0]}:${sec}`)! - shift, y0 + i * LH));
    }
  }
  series.forEach((s, si) => {
    const pts = [...s.pts].sort((a, b) => a.durationSec - b.durationSec);
    const path = pts.map((p) => `${xi(p.durationSec).toFixed(1)},${y(p.watts).toFixed(1)}`).join(" ");
    out.push(`<polyline points="${path}" fill="none" stroke="${s.color}" stroke-width="2.5"><title>${escapeHtml(tip(s.name))}</title></polyline>`);
    for (const p of pts) {
      const px = xi(p.durationSec), py = y(p.watts);
      out.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="${s.color}"/>`);
      const ly = labelY.get(`${si}:${p.durationSec}`) ?? py - 7;
      // The leftmost column's labels would sit on the y-axis ticks — inset them so figures don't run together.
      const first = p.durationSec === durs[0];
      out.push(`<text x="${(first ? px + 5 : px).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="${first ? "start" : "middle"}" class="dl" fill="${s.color}">${p.watts}</text>`);
    }
  });
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
      <div class="note">No career history yet. This page reads <code>data/career-history.json</code> — generate it from your TrainingPeaks archive (plus your exported <code>.FIT</code> files for per-race performance &amp; splits) with <code>npm run career:build</code> (<code>scripts/build-career-history.ts</code>; see <code>SETUP.md</code> → "Career history"). The file is gitignored; <code>career-history.example.json</code> shows the shape.</div></div>`;
  }

  const seasonHdr = data.seasonYear ? `Season ${data.seasonYear}` : "Season";
  const gen = data.generatedAt ? `Built ${escapeHtml(data.generatedAt)} from your TrainingPeaks archive + exported .FIT files.` : "";
  const shareNote = share
    ? `<div class="note">🔒 Share view — event names &amp; locations hidden, dates shown as year only. <a href="?">Exit</a></div>`
    : `<div class="sub" style="text-align:right;margin-top:-6px"><a href="?share=1" style="font-size:12px;color:#888">🔒 Share view</a></div>`;

  const races = data.races.length
    ? `<div class="card"><h2>Race history (${data.races.length})</h2>
        <table><thead><tr><th>Date</th><th>Race</th><th>Location</th><th class="num">Performance</th></tr></thead>
        <tbody>${data.races.map((r, i) => raceRow(r, i, share)).join("")}</tbody></table>
        <div class="sub" style="margin:10px 0 0">Performances are your own recorded numbers (time / pace / distance / power); locations not marked confirmed are nearest-town approximations from GPS. No official results were scraped.</div></div>`
    : "";

  // "Best ride power" is normalized power over a whole ride — an honest caveat, since a low-HR ride can post
  // a high NP and power meters drift across the years, so it is NOT a duration record (the power curve is).
  const hasRidePower = data.bests.some((b) => b.rows.some((r) => /ride power|best power/i.test(r.label)));
  const bestsNote = hasRidePower
    ? `<div class="sub" style="margin:10px 0 0"><b>Best ride power</b> is normalized power (NP) over a whole ride ≥20&nbsp;km — spike-weighted, not a fixed-duration record (a low-HR ride can still post a high NP, and power meters drift across years). For true 5/20/60-min bests read the power-curve chart below.</div>`
    : "";
  const bests = data.bests.length
    ? `<div class="card"><h2>Bests vs current</h2><div class="cols">${data.bests
        .map(
          (b) => `<div><table><thead><tr><th>${escapeHtml(b.sport)}</th><th class="num">All-time</th><th class="num">Last 90d</th><th class="num">${escapeHtml(seasonHdr)}</th></tr></thead>
          <tbody>${b.rows
            .map((r) => `<tr><td>${escapeHtml(r.label)}</td>${bestCell(r.allTime, share)}${bestCell(r.last90, share)}${bestCell(r.season, share)}</tr>`)
            .join("")}</tbody></table></div>`,
        )
        .join("")}</div>${bestsNote}</div>`
    : "";

  const power = data.powerCurve
    ? `<div class="card"><h2>Power curve — best vs recent</h2>${powerCurveSvg(data.powerCurve, data.seasonYear)}
        <div class="sub" style="margin:8px 0 0">Mean-maximal power at each duration — the best average you've sustained for that long, from your power-meter rides. <b>All-time</b> is your best ever. <b>Season${data.seasonYear ? ` ${data.seasonYear}` : ""}</b> is this year to date (since 1&nbsp;Jan); <b>Last 90 days</b> is a rolling 90-day window. The two recent windows overlap but aren't identical, so they diverge at any duration whose best effort falls in one window but not the other.</div></div>`
    : "";

  return `<div class="career-inner"><h1>Career &amp; PBs</h1><div class="sub">${gen}</div>${shareNote}${races}${bests}${power}</div>`;
}

/** Standalone /career page: the career content in the shared site shell (nav highlights Performance). */
export function renderCareerPage(data: CareerHistory | null, share = false): string {
  return pageShell({ title: "Career & PBs", active: "performance", share }, renderCareerInner(data, share));
}
