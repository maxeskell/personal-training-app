import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fixedHrSeries, criticalPower, durability, aerobicThreshold, summarisePerformance, formatPerformanceReport, buildPerformanceHistory, paceLabel,
} from "../src/insights/performanceHistory.js";
import type { SessionPerformance } from "../src/insights/performance.js";
import { renderEfficiencyPage } from "../src/coach/efficiencyPage.js";

/** History summaries: reference HR, no extrapolation, heat correction only when detected, confidence, CP, durability. */

const TODAY = "2026-10-24";
function day(n: number): string {
  return new Date(Date.parse(`${TODAY}T00:00:00Z`) - n * 86400000).toISOString().slice(0, 10);
}
function ride(daysAgo: number, wattsAt140: number, over: Partial<SessionPerformance> = {}): SessionPerformance {
  return {
    date: day(daysAgo), startTimeS: null, kind: "ride", indoor: false, durationMin: 90, avgTempC: 12,
    steady: { fit: { slope: 2, intercept: wattsAt140 - 280, r2: 0.9, n: 30, xLo: 130, xHi: 150 }, points: 30 },
    mmp: null, dfa: null, ...over,
  };
}

test("fixedHrSeries: a steady 0.1 W/day gain over 25 rides reads as a rising trend with high confidence", () => {
  const s = Array.from({ length: 25 }, (_, i) => ride(100 - i * 4, 180 + (100 - (100 - i * 4)) * 0.1 + (i % 2 ? 1 : -1)));
  const f = fixedHrSeries(s, "bike-outdoor", { today: TODAY });
  assert.equal(f.refHr, 140, "reference HR = typical steady HR midpoint");
  assert.equal(f.points.length, 25);
  assert.ok(f.trendPctPer30d! > 1, `trend ${f.trendPctPer30d}`);
  assert.equal(f.confidence, "high");
  assert.equal(f.heatAdjusted, false, "constant temperature: no heat effect to correct");
});

test("fixedHrSeries: never extrapolates beyond a session's HR range", () => {
  const s = [ride(10, 200), ride(8, 200, { steady: { fit: { slope: 2, intercept: -80, r2: 0.9, n: 20, xLo: 100, xHi: 115 }, points: 20 } })];
  const f = fixedHrSeries(s, "bike-outdoor", { refHr: 140, today: TODAY });
  assert.equal(f.points.length, 1);
  assert.equal(f.confidence, "none");
});

test("fixedHrSeries: corrects for heat only when the athlete's own data shows it", () => {
  // Flat fitness; output drops 1.5 W per °C above 10°C. Temperatures vary.
  const temps = [5, 22, 8, 18, 12, 25, 6, 20, 10, 24, 7, 16, 14, 21];
  const s = temps.map((t, i) => ride(60 - i * 4, 200 - 1.5 * (t - 10) + (i % 2 ? 0.5 : -0.5), { avgTempC: t }));
  const f = fixedHrSeries(s, "bike-outdoor", { today: TODAY });
  assert.equal(f.heatAdjusted, true);
  assert.ok(f.heatPerDegPct! < 0);
  assert.ok(Math.abs(f.trendPctPer30d!) < 1, `heat-corrected trend is flat: ${f.trendPctPer30d}`);
});

test("fixedHrSeries: indoor and outdoor never mix", () => {
  const s = [ride(5, 200), ride(4, 180, { indoor: true })];
  assert.equal(fixedHrSeries(s, "bike-indoor", { today: TODAY }).points.length, 1);
});

function mmpRide(daysAgo: number, cp: number, wPrimeJ: number, totalKj = 1000): SessionPerformance {
  const p = (t: number) => Math.round(cp + wPrimeJ / t);
  return { ...ride(daysAgo, 200), mmp: { fresh: { 180: p(180), 300: p(300), 600: p(600), 1200: p(1200) }, afterKj: { 1500: { p300: null, p1200: null }, 2500: { p300: null, p1200: null } }, totalKj } };
}

test("criticalPower: recovers CP and W′ from maximal efforts", () => {
  const c = criticalPower([mmpRide(10, 240, 20000), mmpRide(30, 230, 18000), mmpRide(50, 235, 15000)], { today: TODAY });
  assert.ok(Math.abs(c.cpW! - 240) <= 2, `cp ${c.cpW}`);
  assert.ok(Math.abs(c.wPrimeKj! - 20) <= 1, `w' ${c.wPrimeKj}`);
  assert.notEqual(c.confidence, "none");
});

test("criticalPower: steady-only riding is flagged as submaximal, low confidence", () => {
  const flat: SessionPerformance = { ...ride(5, 200), mmp: { fresh: { 180: 215, 300: 212, 600: 208, 1200: 205 }, afterKj: {}, totalKj: 900 } };
  const c = criticalPower([flat], { today: TODAY });
  assert.equal(c.confidence, "low");
  assert.match(c.why.join(" "), /UNDERESTIMATED/);
});

test("criticalPower: rides older than 90 days don't count", () => {
  assert.equal(criticalPower([mmpRide(120, 240, 20000)], { today: TODAY }).confidence, "none");
});

test("durability: % of fresh after 1500 kJ, confidence from how many long rides", () => {
  const long = (d: number, p: number): SessionPerformance => ({
    ...ride(d, 200),
    mmp: { fresh: { 180: 330, 300: 300, 600: 280, 1200: 260 }, afterKj: { 1500: { p300: p, p1200: p - 30 }, 2500: { p300: null, p1200: null } }, totalKj: 2000 },
  });
  const d = durability([long(5, 270), long(20, 255), long(40, 240)], { today: TODAY });
  assert.equal(d.rows[0].rides, 3);
  assert.equal(d.rows[0].p300Pct, 90);
  assert.equal(d.confidence, "moderate");
  assert.equal(durability([], { today: TODAY }).confidence, "none");
});

test("aerobicThreshold: median of recent readings; a wide spread lowers confidence", () => {
  const dfa = (d: number, hr: number): SessionPerformance => ({ ...ride(d, 200), dfa: { aetHr: hr, aetOutput: 180, windows: 20, artefactPct: 1, r2: 0.7 } });
  const tight = aerobicThreshold([dfa(5, 140), dfa(15, 142), dfa(25, 141), dfa(35, 139), dfa(45, 140)], "ride", { today: TODAY });
  assert.equal(tight.recentHr, 140);
  assert.equal(tight.confidence, "high");
  const wide = aerobicThreshold([dfa(5, 130), dfa(15, 150), dfa(25, 141)], "ride", { today: TODAY });
  assert.equal(wide.confidence, "low");
});

test("paceLabel formats m/s as min:ss per km", () => {
  assert.equal(paceLabel(1000 / 300), "5:00");
  assert.equal(paceLabel(null), "—");
});

test("summarise + format + page: every section renders, text is escaped, SVG closes, empty state guides", () => {
  const sessions = [mmpRide(10, 240, 20000), ...Array.from({ length: 6 }, (_, i) => ride(30 - i * 4, 200 + i))];
  const r = summarisePerformance(sessions, { today: TODAY });
  const text = formatPerformanceReport(r).join("\n");
  assert.match(text, /Critical power/);
  assert.match(text, /confidence/i);
  const html = renderEfficiencyPage(r);
  assert.match(html, /Read this first/);
  assert.match(html, /How to raise it/);
  assert.equal((html.match(/<svg/g) ?? []).length, (html.match(/<\/svg>/g) ?? []).length);
  assert.doesNotMatch(html, /<script/, "display-only: no scripts");
  const evil = { ...r, today: "<img src=x onerror=alert(1)>" };
  assert.doesNotMatch(renderEfficiencyPage(evil), /<img src=x/);
  assert.match(renderEfficiencyPage(null), /npm run efficiency/);
});

test("buildPerformanceHistory: empty dirs give an empty history; maxParse caps work and reports pending", () => {
  const root = mkdtempSync(join(tmpdir(), "perf-"));
  try {
    const streams = join(root, "s");
    mkdirSync(streams);
    writeFileSync(join(streams, "a.fit"), Buffer.from("not a fit"));
    writeFileSync(join(streams, "b.fit"), Buffer.from("not a fit either"));
    const capped = buildPerformanceHistory({ archiveDir: join(root, "none"), streamsDir: streams, cachePath: join(root, "c.json"), maxParse: 1 });
    assert.equal(capped.parsed, 1);
    assert.equal(capped.pending, 1);
    const rest = buildPerformanceHistory({ archiveDir: join(root, "none"), streamsDir: streams, cachePath: join(root, "c.json") });
    assert.equal(rest.parsed, 1, "only the remaining file is parsed");
    assert.equal(rest.sessions.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("summarisePerformance: broken file dates are left out and counted, not allowed to stretch the trend", () => {
  const sessions = [ride(10, 200), ride(5, 201), { ...ride(1, 999), date: "1946-06-01" }, { ...ride(1, 999), date: "" }];
  const r = summarisePerformance(sessions, { today: TODAY });
  assert.equal(r.sessions, 2);
  assert.equal(r.droppedBadDates, 2);
  assert.match(formatPerformanceReport(r).join("\n"), /2 session\(s\) left out/);
});

test("summarisePerformance: a bike aerobic threshold at or above CP is flagged implausible, low confidence", () => {
  const dfa = (d: number): SessionPerformance => ({ ...ride(d, 200), dfa: { aetHr: 159, aetOutput: 231, windows: 20, artefactPct: 1, r2: 0.7 } });
  const r = summarisePerformance([mmpRide(10, 213, 14000), mmpRide(30, 210, 14000), dfa(5), dfa(15), dfa(25)], { today: TODAY });
  const ride_ = r.aet.find((a) => a.kind === "ride")!;
  assert.equal(ride_.confidence, "low");
  assert.match(ride_.why[0], /Implausible: 231 W/);
});
