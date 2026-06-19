import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/types.js";
import { buildInsights } from "../src/insights/engine.js";
import { renderDashboard, ftpEstimateGapNote, trendsHeading, renderAieTodo, aieTodoCopy } from "../src/coach/dashboard.js";
import type { Profile } from "../src/profile/schema.js";
import type { Finding } from "../src/insights/metrics.js";
import type { SessionDecay } from "../src/insights/fit.js";
import type { InsightReaction } from "../src/state/decisionLog.js";

const NASTY = `O'Brien "5x3'" \\ </script><b>x</b>`; // apostrophe, quote, backslash, tag, </script>

function render(): string {
  const s = emptyState("2026-06-08", new Date().toISOString());
  s.raw = { getRaceGoalEvent: { goals: [{ event_name: NASTY, event_date: "2026-07-11", priority: "A" }] } };
  const ins = buildInsights(s, undefined, {});
  ins.topFindings.unshift({ family: "Load & injury risk", title: NASTY, severity: "flag", detail: "ratio 1.7", evidence: "e", confidence: 0.8, recommendation: "Cut the hardest session." } as Finding);
  ins.load = { ctl: 32, atl: 45, tsb: -13, rampPerWeek: 3, series: [{ date: "a", ctl: 30 }] } as never;
  return renderDashboard({ window: [s], decisions: [], insights: ins });
}

test("every inline <script> in the dashboard is syntactically valid JS", () => {
  const html = render();
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.ok(scripts.length >= 2, "has script blocks");
  for (const [i, sc] of scripts.entries()) {
    // new Function throws on a syntax error — the failure mode that silently killed Ask/feedback/act.
    assert.doesNotThrow(() => new Function(sc), `script block ${i} must parse`);
  }
});

test("dashboard renders the action button + its handlers, no undefined/NaN", () => {
  const html = render();
  assert.match(html, /Turn this into a plan change/);
  assert.match(html, /async function actPlan\(\)/);
  assert.match(html, /confirmProposal\(this\)/); // no quote-escaped id arg
  assert.ok(!html.includes("undefined") && !html.includes("NaN"));
});

test("adversarial finding/goal text can't break handlers or inject markup (Spec 3)", () => {
  const html = render();
  // The raw nasty string must NOT appear verbatim anywhere (everything is escaped).
  assert.ok(!html.includes(NASTY), "nasty string must be escaped, never literal");
  // No raw </script> that would end the script context early.
  assert.ok(!html.includes("</script><b>x</b>"), "no unescaped injected tag");
  // Feedback buttons carry data-* not quoted JS-string args.
  assert.match(html, /data-reaction="like" onclick="feedback\(this\)"/);
  assert.match(html, /data-summary="/);
  // The page still has valid scripts (this is the test that would FAIL pre-fix on the apostrophe).
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const [i, sc] of scripts.entries()) assert.doesNotThrow(() => new Function(sc), `script ${i}`);
});

test("insights box: a saved like is highlighted + reversible, snooze is separate, NEW/age flag freshness", () => {
  const s = emptyState("2026-06-08", new Date().toISOString());
  const ins = buildInsights(s, undefined, {});
  ins.topFindings = [
    { family: "Durability", title: "Run durability slipping", severity: "watch", detail: "d", evidence: "e", confidence: 0.7, key: "dur" } as Finding,
    { family: "Load & form", title: "TSB negative", severity: "watch", detail: "d", evidence: "e", confidence: 0.7, key: "tsb" } as Finding,
  ];
  const reactions = new Map<string, InsightReaction>([["dur", "agree"]]); // liked
  const firstSeen = new Map<string, string>([["dur", new Date(Date.now() - 6 * 86_400_000).toISOString()]]); // tsb absent → brand new
  const html = renderDashboard({ window: [s], decisions: [], insights: ins, reactions, firstSeen });

  // Liked → the Like button carries the 'on' state and the saved label; dislike stays available (not hidden).
  assert.match(html, /class="agree on" data-reaction="like"/);
  assert.match(html, /👍 liked/);
  assert.match(html, /data-reaction="dislike"/);
  // Snooze is a separate hide action.
  assert.match(html, /💤 Snooze/);
  assert.match(html, /data-reaction="snooze"/);
  // dur is 6 days old → an age line, no NEW; tsb has no first-seen → a NEW badge, and the header counts it.
  assert.match(html, /first seen .* · 6d/);
  assert.match(html, /class="newbadge">NEW</);
  assert.match(html, /1 new/);
  // The page still parses (the rewritten feedback() handler included).
  for (const [i, sc] of [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) assert.doesNotThrow(() => new Function(sc[1]), `script ${i}`);
});

test("share view: redacts real race names + dates and shows the banner; normal view offers the toggle", () => {
  const s = emptyState("2026-06-08", new Date().toISOString());
  s.raw = { getRaceGoalEvent: { goals: [{ event_name: "Big City Marathon", event_date: "2026-10-11", priority: "A" }] } };

  const normal = renderDashboard({ window: [s], decisions: [] });
  assert.match(normal, /Big City Marathon/); // real name shown
  assert.match(normal, /\?share=1/); // toggle link to enter share view

  const shared = renderDashboard({ window: [s], decisions: [], share: true });
  assert.ok(!shared.includes("Big City Marathon"), "real race name redacted");
  assert.ok(!shared.includes("2026-10-11"), "exact race date hidden");
  assert.match(shared, /Race 1/); // generic label instead
  assert.match(shared, /Share view/); // the redaction banner
  for (const [i, sc] of [...shared.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) assert.doesNotThrow(() => new Function(sc[1]), `script ${i}`);
});

test("dashboard surfaces the wellbeing escalation banner; Share mode suppresses it", () => {
  const win = Array.from({ length: 7 }, (_, i) => {
    const s = emptyState(`2026-06-${String(8 + i).padStart(2, "0")}`, new Date().toISOString());
    s.weightKg = { value: 70 - i * 0.3, source: "garmin" }; // ~2.7% drop across the window
    s.sleep = { value: { hours: 5.8, score: 55 }, source: "garmin" };
    return s;
  });
  const today = win[win.length - 1];
  today.hrvOvernight = { value: 45, source: "garmin" };
  today.hrv7dBaseline = { value: 60, source: "derived" };
  today.restingHr = { value: 56, source: "garmin" };
  today.restingHr7dBaseline = { value: 48, source: "derived" };

  const html = renderDashboard({ window: win, decisions: [] });
  assert.match(html, /Health check|Health signals worth/); // banner present
  assert.match(html, /doctor|physician|easing off/i); // with the professional-referral message

  const shared = renderDashboard({ window: win, decisions: [], share: true });
  assert.ok(!/Health check|Health signals worth/.test(shared), "health banner suppressed in Share view (personal health detail)");
});

test("freshness line is human-readable (no raw ISO), with time-since + latest-workout gap", () => {
  const updated = new Date(Date.now() - (2 * 60 + 41) * 60_000); // 2h 41m ago
  const s = emptyState("2026-06-18", updated.toISOString());
  s.actualActivities = { value: [{ date: "2026-06-16", sport: "Run", durationMin: 60, distanceKm: 12 }], source: "ai-endurance" };
  const html = renderDashboard({ window: [s], decisions: [] });
  assert.match(html, /Data last updated <b>/); // readable label
  assert.match(html, /\dh \d+m ago|\dm ago|just now/); // duration since update
  assert.match(html, /Latest ingested workout <b>/); // workout line
  assert.match(html, /before this update/); // the gap between update and the last workout
  assert.ok(!html.includes(updated.toISOString()), "the raw ISO timestamp must not appear");
  assert.ok(!html.includes("as of 2026"), "the old 'as of <ISO>' line is gone");
});

test("week table uses h:mm, missing swim distance shows — , planned session joins the last-session card", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.actualActivities = {
    value: [
      { date: "2026-06-08", sport: "Run", durationMin: 95, distanceKm: 18.2 },
      { date: "2026-06-07", sport: "Swim", durationMin: 45 }, // no distance — AIE swim feed gap
    ],
    source: "ai-endurance",
  };
  s.plannedSessions = { value: [{ date: "2026-06-08", sport: "Run", title: "Tempo 3x10min", type: "Run", durationMin: 90 }], source: "ai-endurance" };
  s.raw = { getRunningActivity: { activities: [{ activity_date_local: "2026-06-08", activity_movingtime: 95 * 60, activity_avhr: 150 }] } };
  const html = renderDashboard({ window: [s], decisions: [] });
  assert.match(html, /1h 35m/); // 95 min in h:mm, not "95 min"
  assert.ok(!/95 min/.test(html));
  assert.match(html, /<tr><td>Swim<\/td><td>1<\/td><td>45m<\/td><td><span class="muted">—<\/span><\/td>/);
  assert.match(html, /Planned: <b>Tempo 3x10min/); // what the session was meant to be
  assert.match(html, /1h 30m planned → 1h 35m done/);
});

test("trends keep one sleep graph (score); power-curve bests carry the date they were set", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.powerCurve = {
    value: { ftpEstimateW: 250, activitiesAnalyzed: 9, bests: [{ duration: "5min", watts: 320, date: "2026-05-19" }, { duration: "20min", watts: 255 }] },
    source: "garmin",
  };
  const garminDays = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-05-${String(i + 1).padStart(2, "0")}`,
    sleepHours: 7 + (i % 2),
    sleepScore: 70 + i,
  }));
  const html = renderDashboard({ window: [s], decisions: [], garminDays });
  assert.match(html, /<tr><td>Sleep score<\/td>/);
  assert.ok(!html.includes("<tr><td>Sleep (h)</td>"), "duplicate sleep-hours sparkline removed");
  assert.match(html, /<td>Set on<\/td>/);
  assert.match(html, /2026-05-19/);
});

test("deep-feedback button shows when the .FIT stream is joined OR fetchable on demand (user ask)", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.raw = { getRunningActivity: { activities: [{ activity_date_local: "2026-06-09", activity_movingtime: 3600, activity_avhr: 150 }] } };
  const ins = buildInsights(s, undefined, {});
  // No stream and no auto-fetch path → unlock note instead of the button (no pointless LLM spend).
  ins.sessionDecays = [];
  const without = renderDashboard({ window: [s], decisions: [], insights: ins });
  assert.ok(!without.includes('onclick="sessionFeedback()"'), "no button without the stream");
  assert.match(without, /Export Original/);
  // No stream, but Garmin on + the archive knows this activity's id → button (server fetches first).
  const fetchable = renderDashboard({
    window: [s],
    decisions: [],
    insights: ins,
    canFetchFit: true,
    fitSummaries: [{ activityId: "G1", date: "2026-06-09", sport: "Run" }],
  });
  assert.match(fetchable, /onclick="sessionFeedback\(\)"/);
  assert.match(fetchable, /fetches this session's raw \.FIT/);
  // Matching stream → button, no fetch hint.
  const decay: SessionDecay = { activityId: "a1", date: "2026-06-09", sport: "running", durationMin: 60, cadenceDropPct: null, gctRisePct: null, voRisePct: null, hrDriftPct: null, decouplingPct: null, avgTempC: null, avgPowerW: null, avgHr: null };
  ins.sessionDecays = [decay];
  const withStream = renderDashboard({ window: [s], decisions: [], insights: ins });
  assert.match(withStream, /onclick="sessionFeedback\(\)"/);
  assert.ok(!withStream.includes("fetches this session's raw .FIT"));
});

test("mdToHtml renders the LLM markdown readably and escapes injected markup first", () => {
  const html = render();
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((sc) => sc.includes("function mdToHtml"));
  assert.ok(script, "mdToHtml is defined in the page script");
  const { mdToHtml } = new Function(`${script}; return { mdToHtml: mdToHtml };`)() as { mdToHtml: (s: string) => string };
  assert.equal(mdToHtml("**(1) Verdict:** strong"), "<b>(1) Verdict:</b> strong");
  assert.equal(mdToHtml("## What went well"), '<b style="font-size:15px">What went well</b>');
  assert.equal(mdToHtml("held it *better* than"), "held it <i>better</i> than");
  assert.equal(mdToHtml("- bank it"), "• bank it");
  assert.equal(mdToHtml("run `npm test`"), "run <code>npm test</code>");
  const nasty = mdToHtml('<img onerror=x> **b** </script>');
  assert.ok(!nasty.includes("<img"), "HTML is escaped before formatting");
  assert.ok(nasty.includes("<b>b</b>"), "formatting still applies after escaping");
});

test("stale snapshot triggers the on-load auto-sync; a fresh one (and the CLI file) doesn't", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  const auto = renderDashboard({ window: [s], decisions: [], autoSyncStaleMin: 95 });
  assert.match(auto, /<script>autoSync\(95\)<\/script>/);
  assert.match(auto, /function autoSync\(min\)/);
  for (const [i, sc] of [...auto.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
    assert.doesNotThrow(() => new Function(sc[1]), `script block ${i} must parse`);
  }
  const fresh = renderDashboard({ window: [s], decisions: [] });
  assert.ok(!fresh.includes("<script>autoSync("), "no auto-sync call without the server's staleness signal");
});

test("a power-curve FTP estimate well below the configured FTP is reconciled on the dashboard, not left as a bare conflict", () => {
  // The real-world report: Garmin's configured cycling FTP is 223 W, but the MMP power-duration
  // curve estimates 183 W (it only sees power-equipped rides) — two FTP numbers on one page.
  const note = ftpEstimateGapNote(223, 183);
  assert.ok(note && /18% under your configured 223 W FTP/.test(note), "names the gap and the configured FTP");
  assert.ok(note && /Zones use the 223 W figure/.test(note), "tells the reader which figure drives zones");
  // No nagging: estimate at/above the configured FTP, within ~5% noise, or missing inputs → no note.
  assert.equal(ftpEstimateGapNote(223, 223), null);
  assert.equal(ftpEstimateGapNote(223, 250), null);
  assert.equal(ftpEstimateGapNote(223, 215), null, "4% gap is within noise");
  assert.equal(ftpEstimateGapNote(undefined, 183), null);
  assert.equal(ftpEstimateGapNote(223, undefined), null);

  // And it actually renders in the Garmin scores card when both numbers are present.
  const s = emptyState("2026-06-14", new Date().toISOString());
  s.thresholds = { value: { bikeFtpW: 223, bikeFtpWkg: 3.19 }, source: "garmin" };
  s.powerCurve = { value: { ftpEstimateW: 183, activitiesAnalyzed: 7, bests: [] }, source: "garmin" };
  const html = renderDashboard({ window: [s], decisions: [] });
  assert.match(html, /FTP estimate is 18% under your configured 223 W FTP/);
});

test("trends heading drops the window suffix until there are ≥2 days to trend (no 'last 0 days' / '1 days')", () => {
  // The demo (single snapshot, no Garmin archive) and a brand-new install must not show a nonsensical window.
  assert.equal(trendsHeading(0), "Trends");
  assert.equal(trendsHeading(1), "Trends");
  assert.equal(trendsHeading(2), "Trends (last 2 days)");
  assert.equal(trendsHeading(42), "Trends (last 42 days)");
  // And the rendered demo-style dashboard (no garminDays) never emits the broken label.
  const html = renderDashboard({ window: [emptyState("2026-06-18", new Date().toISOString())], decisions: [] });
  assert.doesNotMatch(html, /last 0 days|last 1 days/, "no broken window label on a single-snapshot dashboard");
  assert.match(html, /<h2>Trends<\/h2>/, "shows a clean 'Trends' heading instead");
});

test("aieTodoCopy: status tokens get the curated 'why', free text passes through, unknown keys title-case", () => {
  assert.deepEqual(aieTodoCopy("swim_css", "not_set"), {
    label: "Set your swim CSS",
    why: "without it there's no swim model for your races — the highest-value fix for a triathlete",
  });
  assert.equal(aieTodoCopy("ftp_w", "unresolved").label, "Resolve your cycling FTP");
  assert.equal(aieTodoCopy("race_targets", "set the three target times").why, "set the three target times");
  assert.equal(aieTodoCopy("some_new_field", "todo").label, "Some New Field");
  assert.equal(aieTodoCopy("some_new_field", "todo").why, "needs setting in AI Endurance");
});

test("renderAieTodo: surfaces ai_endurance_todo as a card, drops resolved items, hides in share mode, escapes values", () => {
  const profile = {
    schema_version: 1,
    identity: {},
    ai_endurance_todo: { swim_css: "not_set", ftp_w: "unresolved", race_targets: "set the three target times", legacy: "resolved" },
  } as Profile;
  const html = renderAieTodo(profile);
  assert.match(html, /Fix these in AI Endurance/);
  assert.match(html, /Set your swim CSS/);
  assert.match(html, /Resolve your cycling FTP/);
  assert.match(html, /Set your race target times/);
  assert.match(html, /set the three target times/, "a descriptive value passes through as the note");
  assert.doesNotMatch(html, /legacy|resolved/, "an item marked 'resolved' is dropped");
  // Redacted screenshot view and the empty cases produce nothing.
  assert.equal(renderAieTodo(profile, true), "", "hidden in share mode");
  assert.equal(renderAieTodo(undefined), "");
  assert.equal(renderAieTodo({ schema_version: 1, identity: {} } as Profile), "", "no card when there's nothing to do");
  // Interpolated values are escaped (dashboard escaping convention).
  const nasty = renderAieTodo({ schema_version: 1, identity: {}, ai_endurance_todo: { x: `<script>bad()</script>` } } as Profile);
  assert.doesNotMatch(nasty, /<script>bad/);
  assert.match(nasty, /&lt;script&gt;/);
});

test("dashboard shows the AIE-todo card only when a profile with outstanding items is supplied", () => {
  const s = emptyState("2026-06-18", new Date().toISOString());
  const withTodo = renderDashboard({
    window: [s],
    decisions: [],
    profile: { schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" } } as Profile,
  });
  assert.match(withTodo, /Fix these in AI Endurance/);
  assert.doesNotMatch(renderDashboard({ window: [s], decisions: [] }), /Fix these in AI Endurance/);
});

test("share view omits the interactive Sync card (no empty card in a screenshot/PDF)", () => {
  const s = emptyState("2026-06-18", new Date().toISOString());
  assert.match(renderDashboard({ window: [s], decisions: [] }), /Sync latest data/, "present in the interactive view");
  assert.doesNotMatch(renderDashboard({ window: [s], decisions: [], share: true }), /Sync latest data/, "dropped in share view");
  assert.match(renderDashboard({ window: [s], decisions: [] }), /\.syncbar\{display:none/, "and its card is print-hidden via .syncbar");
});

test("API cost card renders windowed totals + a monthly projection when records are present", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  const costRecords = [
    { ts: new Date().toISOString(), operation: "ask", model: "claude-opus-4-8", input: 100, output: 200, cacheWrite: 0, cacheRead: 0, costUsd: 0.05, schemaVersion: 1 },
    { ts: new Date().toISOString(), operation: "weekly", model: "claude-opus-4-8", input: 100, output: 800, cacheWrite: 0, cacheRead: 0, costUsd: 0.2, schemaVersion: 1 },
  ];
  const html = renderDashboard({ window: [s], decisions: [], costRecords });
  assert.match(html, /API cost/);
  assert.match(html, /\/mo/); // monthly projection present
  assert.match(html, /weekly \$0\.200/); // top-flow breakdown, cost-desc
  // No card when there are no records.
  assert.ok(!renderDashboard({ window: [s], decisions: [] }).includes("API cost"));
});
