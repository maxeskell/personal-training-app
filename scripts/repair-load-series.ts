/**
 * One-off repair (Oct 2026): rewrite the persisted CTL/ATL/TSB in data/state/*.json from the archive-extended
 * ESS series. Until the fix, each day's load was seeded from AIE's ~14-day recovery window, so the stored
 * series lurched (29.8 → 19.3 → 38.2 across two weeks) and the season-arc CTL trend read it as real.
 *
 * Only days ≥ 42 days after the archive's first activity are rewritten — earlier ones have no burn-in either
 * way and are left as they were. Uses the newest snapshot's AIE window for the latest days. Idempotent.
 * Usage: cd /Users/maxeskell/dev/personal-training-app && npm run load:repair [-- --dry-run]
 */
import { ArchiveStore } from "../src/archive/store.js";
import { StateStore } from "../src/state/store.js";
import { essSeriesWithHistory, loadModel, mapRichActivity } from "../src/insights/metrics.js";
import { shiftIso } from "../src/util/today.js";

const dry = process.argv.includes("--dry-run");
const store = new StateStore();
const acts = (await new ArchiveStore().loadActivities()).map((a) => mapRichActivity(a.raw, a.sport));
const dates = await store.dates();
const newest = dates.length ? await store.load(dates[dates.length - 1]) : undefined;
const rec = (newest?.raw?.getRecoveryModel as { data?: { date?: unknown[]; external_stress_score?: unknown[] } } | undefined)?.data;
const lm = loadModel(essSeriesWithHistory(rec, acts));
if (!lm) {
  console.log("No usable ESS history — nothing repaired.");
  process.exit(0);
}
const burnedIn = shiftIso(lm.series[0].date, 42);
const byDate = new Map(lm.series.map((p) => [p.date, p]));
let changed = 0;
for (const d of dates) {
  if (d < burnedIn) continue;
  const p = byDate.get(d);
  const s = await store.load(d);
  if (!p || !s) continue;
  const before = s.load?.value;
  if (before && before.ctl === p.ctl && before.atl === p.atl && before.tsb === p.tsb) continue;
  console.log(`${d}  CTL ${before?.ctl ?? "—"} → ${p.ctl}   ATL ${before?.atl ?? "—"} → ${p.atl}   TSB ${before?.tsb ?? "—"} → ${p.tsb}`);
  if (!dry) await store.save({ ...s, load: { value: { ctl: p.ctl, atl: p.atl, tsb: p.tsb }, source: "ai-endurance" } });
  changed++;
}
console.log(`${dry ? "[dry run] would repair" : "Repaired"} ${changed} snapshot(s) from ${burnedIn} on (history from ${lm.series[0].date}).`);
