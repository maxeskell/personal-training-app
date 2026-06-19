import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyState } from "../src/state/types.js";
import { todayIso } from "../src/util/today.js";
import { buildInsights } from "../src/insights/engine.js";
import { renderDashboard, ftpEstimateGapNote, trendsHeading, renderSetupImprove, buildSetupItems, aieTodoCopy, parseResearchTopics, parseActionBullets, mdLite, commonTrailingSentences, sessionFeedbackCardState } from "../src/coach/dashboard.js";
import type { ProfileQuestion } from "../src/profile/questions.js";
import type { InsightReport } from "../src/insights/engine.js";
import type { Finding } from "../src/insights/metrics.js";
import type { Profile } from "../src/profile/schema.js";
import type { InsightReaction, DecisionRecord } from "../src/state/decisionLog.js";

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

test("sessionFeedbackCardState: stored wins; then key-gated; then local-FIT vs fetchable; else manual", () => {
  const base = { hasStored: false, hasApiKey: true, hasLocalFit: false, canFetchFit: false, hasActivityId: false };
  // A stored readout always wins, even with everything else absent.
  assert.deepEqual(sessionFeedbackCardState({ ...base, hasStored: true, hasApiKey: false }), { kind: "stored" });
  // No key → say so (can't generate at all), regardless of FIT availability.
  assert.deepEqual(sessionFeedbackCardState({ ...base, hasApiKey: false, hasLocalFit: true }), { kind: "no-api-key" });
  // Local .FIT present → generate now, no download needed.
  assert.deepEqual(sessionFeedbackCardState({ ...base, hasLocalFit: true }), { kind: "auto", needsDownload: false });
  // No local .FIT but fetchable (Garmin on + archived activity id) → download first, then generate.
  assert.deepEqual(sessionFeedbackCardState({ ...base, canFetchFit: true, hasActivityId: true }), { kind: "auto", needsDownload: true });
  // Fetchable needs BOTH the capability and a known id — missing either → manual export.
  assert.deepEqual(sessionFeedbackCardState({ ...base, canFetchFit: true }), { kind: "manual" });
  assert.deepEqual(sessionFeedbackCardState({ ...base, hasActivityId: true }), { kind: "manual" });
  assert.deepEqual(sessionFeedbackCardState(base), { kind: "manual" });
});

test("Last-session card: stored inline; live fetch when producible; honest note otherwise; never a button", () => {
  const s = emptyState("2026-06-09", new Date().toISOString());
  s.raw = { getRunningActivity: { activities: [{ activity_date_local: "2026-06-09", activity_movingtime: 3600, activity_avhr: 150 }] } };
  const ins = buildInsights(s, undefined, {});

  // No key → an honest "needs ANTHROPIC_API_KEY" note, no live placeholder, no button/handler.
  const noKey = renderDashboard({ window: [s], decisions: [], insights: ins });
  assert.ok(!noKey.includes("sessionFeedback()"), "the old on-demand button + handler are gone");
  assert.match(noKey, /needs ANTHROPIC_API_KEY/);
  assert.ok(!noKey.includes('id="sessfb"'), "no live placeholder when it can't be produced");

  // Key set + a fetchable .FIT (Garmin on + archived activity id for this date) → a live placeholder that
  // fetches on load, and the loader + on-load trigger are present.
  const fetchable = renderDashboard({
    window: [s],
    decisions: [],
    insights: ins,
    canFetchFit: true,
    fitSummaries: [{ activityId: "123", date: "2026-06-09", sport: "Run" }],
    setupHealth: { hasApiKey: true, waterTempSet: true, lastSyncAgeHours: 1 },
  });
  assert.match(fetchable, /<div id="sessfb" data-date="2026-06-09">/);
  assert.match(fetchable, /Downloading this session&#39;s \.FIT/); // the message is HTML-escaped
  assert.match(fetchable, /async function loadSessionFeedback\(\)/);
  assert.match(fetchable, /if\(document\.getElementById\('sessfb'\)\)loadSessionFeedback\(\);/);

  // Key set but no .FIT and no way to fetch one → the manual-export note, no live placeholder.
  const manual = renderDashboard({
    window: [s],
    decisions: [],
    insights: ins,
    setupHealth: { hasApiKey: true, waterTempSet: true, lastSyncAgeHours: 1 },
  });
  assert.match(manual, /No raw .FIT for this session and no automatic way to fetch it/);
  assert.ok(!manual.includes('id="sessfb"'));

  // Stored feedback for this session → rendered inline (markdown formatted), still no button or placeholder.
  const withFb = renderDashboard({
    window: [s],
    decisions: [],
    insights: ins,
    setupHealth: { hasApiKey: true, waterTempSet: true, lastSyncAgeHours: 1 },
    sessionFeedbacks: [
      { schemaVersion: 1, date: "2026-06-09", sport: "Run", deep: true, generatedAt: new Date().toISOString(), costUsd: 0.2, markdown: "# Session feedback — 2026-06-09 Run\n\n## Verdict\n**Solid** aerobic run." },
    ],
  });
  assert.match(withFb, /Session feedback <span class="muted">\(deep analysis/);
  assert.match(withFb, /<b>Solid<\/b> aerobic run/, "markdown is rendered inline");
  assert.ok(!withFb.includes("sessionFeedback()"), "still no button");
  assert.ok(!withFb.includes('id="sessfb"'), "stored → no live placeholder");

  // Every inline <script> still parses (the new loadSessionFeedback + on-load trigger included).
  for (const [i, sc] of [...fetchable.matchAll(/<script>([\s\S]*?)<\/script>/g)].entries()) {
    assert.doesNotThrow(() => new Function(sc[1]), `script block ${i} must parse`);
  }
});

test("mdLite: escapes injected markup before formatting headers/bold/code/bullets", () => {
  const out = mdLite("## Heading\n**bold** and `code`\n- item\n<script>bad()</script> **x**");
  assert.match(out, /<b style="font-size:15px">Heading<\/b>/);
  assert.match(out, /<b>bold<\/b>/);
  assert.match(out, /<code>code<\/code>/);
  assert.match(out, /• item/);
  assert.doesNotMatch(out, /<script>bad/);
  assert.match(out, /&lt;script&gt;/);
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
  assert.equal(aieTodoCopy("some_field", "set it in AIE").why, "set it in AIE", "a descriptive value passes through as the note");
  assert.equal(aieTodoCopy("some_new_field", "todo").label, "Some New Field");
  assert.equal(aieTodoCopy("some_new_field", "todo").why, "needs setting in AI Endurance");
});

// A tiny questions catalogue so buildSetupItems' "unfilled profile questions" branch is deterministic
// regardless of how the real catalogue grows.
const TEST_QUESTIONS: ProfileQuestion[] = [
  { area: "fuelling", field: "fuelling.carb_target_g_per_hour", question: "Typical long-run fuel?", why: "feeds nutrition advice" },
  { area: "availability", field: "availability.rest_day", question: "Which weekday is your rest day?", why: "shapes the week" },
];

test("buildSetupItems: drops race_targets, tags + routes each source, dedupes and caps", () => {
  const profile = {
    schema_version: 1,
    identity: {},
    ai_endurance_todo: {
      swim_css: "not_set",
      ftp_w: "unresolved",
      race_targets: "set the target_time for each race", // non-actionable → must be dropped
      legacy: "resolved", // resolved → dropped
    },
    open_items: ["Shim the bike cleat after Birmingham", "  ", 42 as unknown as string],
    fuelling: { carb_target_g_per_hour: { long: 80 } }, // filled → its question is NOT surfaced
    // availability.rest_day is absent → its question IS surfaced
  } as Profile;
  const items = buildSetupItems(profile, { questions: TEST_QUESTIONS });

  // race_targets and resolved are gone; only actionable items remain.
  assert.ok(!items.some((i) => /race target/i.test(i.label)), "the non-actionable race_targets item is dropped");
  assert.ok(!items.some((i) => i.label.toLowerCase().includes("legacy")), "a resolved item is dropped");

  const aie = items.filter((i) => i.source === "ai_endurance");
  assert.deepEqual(
    aie.map((i) => i.label),
    ["Set your swim CSS", "Resolve your cycling FTP"],
  );
  assert.ok(aie.every((i) => i.route === "in AI Endurance"));

  const open = items.filter((i) => i.source === "open_item");
  assert.deepEqual(open.map((i) => i.label), ["Shim the bike cleat after Birmingham"], "blank/non-string open items are skipped");
  assert.equal(open[0].route, "discuss with coach");

  const q = items.filter((i) => i.source === "profile_question");
  assert.deepEqual(q.map((i) => i.label), ["Answer: Which weekday is your rest day?"], "only the UNFILLED question surfaces");
  assert.equal(q[0].route, "edit profile");
});

test("buildSetupItems: dedupes across sources (first/higher-value wins) and caps at ~5", () => {
  // An open item restates an AIE label; the AIE one (added first) wins, the duplicate is dropped.
  const deduped = buildSetupItems({
    schema_version: 1,
    identity: {},
    ai_endurance_todo: { swim_css: "not_set" },
    open_items: ["set your swim css"],
  } as Profile);
  assert.equal(deduped.filter((i) => /swim css/i.test(i.label)).length, 1, "the restated item is deduped");
  assert.equal(deduped[0].source, "ai_endurance", "the higher-value source is kept");

  // With far more than five unfilled questions, the list is capped.
  const many: ProfileQuestion[] = Array.from({ length: 12 }, (_, i) => ({
    area: "health",
    field: `health.q${i}`,
    question: `Question ${i}?`,
    why: "why",
  }));
  const capped = buildSetupItems({ schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set", ftp_w: "unresolved" } } as Profile, { questions: many });
  assert.equal(capped.length, 5, "the card is capped to keep it a calm hub");
  assert.equal(capped[0].source, "ai_endurance", "AIE gaps lead the list");
});

test("buildSetupItems: ranks by value so high-impact gaps win the cap (coach-read > reference-only)", () => {
  // A reference-only question (sits FIRST in catalogue order) must rank below a coach-read one, and
  // both must rank below an AIE gap and an open item — so the cap keeps the high-value items.
  const questions: ProfileQuestion[] = [
    { area: "identity", field: "identity.height_cm", question: "Standing height (cm)?", why: "Stable anthropometry kept for reference." },
    { area: "fuelling", field: "fuelling.carb_target_g_per_hour", question: "Typical long-run fuel?", why: "Read into the coaching context as your per-session fuelling plan." },
  ];
  const items = buildSetupItems(
    { schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" }, open_items: ["Shim the cleat"] } as Profile,
    { questions },
  );
  assert.deepEqual(
    items.map((i) => i.source),
    ["ai_endurance", "open_item", "profile_question", "profile_question"],
    "AIE > open item > profile questions",
  );
  // Within the questions, the coach-read one outranks the reference-only one despite catalogue order.
  const labels = items.filter((i) => i.source === "profile_question").map((i) => i.label);
  assert.deepEqual(labels, ["Answer: Typical long-run fuel?", "Answer: Standing height (cm)?"]);
  assert.ok(items[0].priority > items[items.length - 1].priority, "priority is monotonic across the ranked list");
});

test("renderSetupImprove: renders the card, tags routes + dismiss control, hides in share mode, escapes values", () => {
  const profile = {
    schema_version: 1,
    identity: {},
    ai_endurance_todo: { swim_css: "not_set" },
    open_items: ["Shim the cleat"],
  } as Profile;
  const html = renderSetupImprove(profile, false, { questions: [] });
  assert.match(html, /Set up &amp; improve/);
  assert.match(html, /Set your swim CSS/);
  assert.match(html, /Shim the cleat/);
  assert.match(html, /in AI Endurance/);
  assert.match(html, /discuss with coach/);
  // Each item is an expandable <details> carrying its stable dismissal key, a ✕ (whose click stops the
  // dropdown toggling), and a self-serve proposed action in the body.
  assert.match(html, /<details class="setup-item" data-key="setup:aie:swim_css"/);
  assert.match(html, /class="dismiss"[^>]*onclick="event\.stopPropagation\(\);dismissSetup\(this\)"/);
  assert.match(html, /<div class="setup-action">[^<]*Profile → Thresholds/, "the swim-CSS proposed action is in the dropdown");
  // Redacted screenshot view and the empty cases produce nothing.
  assert.equal(renderSetupImprove(profile, true), "", "hidden in share mode");
  assert.equal(renderSetupImprove(undefined), "");
  assert.equal(renderSetupImprove({ schema_version: 1, identity: {} } as Profile, false, { questions: [] }), "", "no card when there's nothing to do");
  // Interpolated values are escaped (dashboard escaping convention).
  const nasty = renderSetupImprove({ schema_version: 1, identity: {}, ai_endurance_todo: { x: `<script>bad()</script>` } } as Profile, false, { questions: [] });
  assert.doesNotMatch(nasty, /<script>bad/);
  assert.match(nasty, /&lt;script&gt;/);
});

test("buildSetupItems: stable keys + a dismissed (snoozed) key is dropped, freeing its slot", () => {
  const profile = {
    schema_version: 1,
    identity: {},
    ai_endurance_todo: { swim_css: "not_set", ftp_w: "unresolved" },
    open_items: ["Shim the cleat"],
  } as Profile;
  // Keys are namespaced + derived from identity (todo key / normalised open text), not display copy.
  const keys = buildSetupItems(profile, { questions: [] }).map((i) => i.key);
  assert.deepEqual(keys, ["setup:aie:swim_css", "setup:aie:ftp_w", "setup:open:shim the cleat"]);
  // The same item yields the same key across renders (so a dismissal sticks).
  assert.deepEqual(buildSetupItems(profile, { questions: [] }).map((i) => i.key), keys);

  // Dismiss the FTP item → it drops, and the others remain (in order).
  const after = buildSetupItems(profile, { questions: [], suppressed: new Set(["setup:aie:ftp_w"]) });
  assert.deepEqual(after.map((i) => i.key), ["setup:aie:swim_css", "setup:open:shim the cleat"]);

  // Dismissal frees a slot before the ~5 cap: with 6 unfilled questions + 1 AIE gap, dismissing the
  // AIE gap lets a 6th question (otherwise cut) surface.
  // 1 AIE gap + 6 questions, cap 5 → shown = [swim, q0..q3]; q4 and q5 are cut.
  const many: ProfileQuestion[] = Array.from({ length: 6 }, (_, i) => ({ area: "health", field: `health.q${i}`, question: `Q${i}?`, why: "why" }));
  const full = buildSetupItems({ schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" } } as Profile, { questions: many });
  assert.equal(full.length, 5);
  assert.ok(!full.some((i) => i.key === "setup:q:health.q4"), "q4 is cut by the cap");
  // Dismiss the AIE gap → shown = [q0..q4], so q4 (previously cut) takes the freed slot.
  const freed = buildSetupItems({ schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" } } as Profile, { questions: many, suppressed: new Set(["setup:aie:swim_css"]) });
  assert.equal(freed.length, 5);
  assert.ok(freed.some((i) => i.key === "setup:q:health.q4"), "dismissing one item lets the next-best fill the freed slot");
});

// --- Phase 2/3: "This week" (marginal gains + weekly pointer) and "Worth considering" (research) ---
const NOW = Date.parse("2026-06-15T12:00:00Z");
const F = (o: Partial<Finding>): Finding => ({ family: "Aerobic efficiency", title: "t", severity: "watch", detail: "d", evidence: "e", confidence: 0.6, ...o });
const insightsWith = (findings: Finding[]) => ({ findings, topFindings: [] } as unknown as InsightReport);

test("parseResearchTopics: pulls bold topic headlines, deduped + capped, tolerant of format drift", () => {
  const md = [
    "# Research digest — 2026-06-01 (PROPOSED)",
    "- **Wider tyres** (CHANGE): 28–32mm at lower pressure.",
    "- **Carb intake 90 g/h** (NEW): for long course.",
    "* **Wider tyres** again — a duplicate, dropped.",
    "Some prose with no bold lead.",
    "- not bold either",
  ].join("\n");
  assert.deepEqual(parseResearchTopics(md), ["Wider tyres", "Carb intake 90 g/h"]);
  assert.deepEqual(parseResearchTopics(md, 1), ["Wider tyres"]);
  assert.deepEqual(parseResearchTopics("no parseable topics here"), []);

  // The labelled form (what the real digest produces) — pull the Topic VALUE, skip Source/Proposed prior
  // field-labels, and take "### Heading" topics. (Regression: the card used to show "Source"/"Proposed prior".)
  const labelled = [
    "# Research digest — 2026-06-01",
    "### Heat acclimation",
    "- **Topic**: Carbohydrate intake (CHANGE)",
    "- **Proposed prior**: aim 90 g/h on long course.",
    "- **Source**: Jeukendrup 2024.",
  ].join("\n");
  assert.deepEqual(parseResearchTopics(labelled), ["Heat acclimation", "Carbohydrate intake"]);
});

test("buildSetupItems: groups This week (gains + weekly pointer) and Worth considering (research) with as-of tags", () => {
  const profile = { schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" } } as Profile;
  const insights = insightsWith([
    F({ family: "Durability", title: "Brick pacing", severity: "watch", recommendation: "Start the brick run 5s/km easier", confidence: 0.8 }),
  ]);
  const items = buildSetupItems(profile, {
    questions: [],
    insights,
    weeklyReview: { date: "2026-06-12", actions: ["Cut one grey-zone ride"] }, // 3 days before NOW → fresh
    researchDigest: { date: "2026-06-10", topics: ["90 g/h carb", "165mm cranks"] }, // 5 days → fresh
    now: NOW,
  });
  assert.deepEqual([...new Set(items.map((i) => i.group))], ["finish_setup", "this_week", "worth_considering"]);

  const week = items.filter((i) => i.group === "this_week");
  assert.equal(week[0].label, "Start the brick run 5s/km easier", "marginal gain (its recommendation) leads This week");
  assert.equal(week[0].source, "tune");
  assert.ok(week[0].key.startsWith("setup:tune:"), "tune item carries a namespaced finding key");
  assert.ok(week.some((i) => i.source === "weekly" && i.label === "Cut one grey-zone ride" && /as of 3d ago/.test(i.why)), "the weekly review's own action item, as-of tagged");

  const consider = items.filter((i) => i.group === "worth_considering");
  assert.deepEqual(consider.map((i) => i.label), ["90 g/h carb", "165mm cranks"]);
  assert.ok(consider.every((i) => i.route === "discuss with coach" && /as of 5d ago/.test(i.why)));
  assert.equal(consider[0].key, "setup:research:90 g h carb");
});

test("parseActionBullets: pulls the bullets under the matched section only, deduped + capped", () => {
  const md = [
    "# Weekly review — 2026-06-12",
    "## Load by sport",
    "- Run: 3 sessions", // wrong section → ignored
    "## Next week",
    "- **Cut** one grey-zone ride",
    "- Move the long run off your GI-trough day",
    "- Cut one grey-zone ride", // a duplicate (after emphasis strip) → dropped
    "## Recovery",
    "- sleep was good", // after the section → ignored
  ].join("\n");
  const got = parseActionBullets(md, /next week/i);
  assert.deepEqual(got, ["Cut one grey-zone ride", "Move the long run off your GI-trough day"]);
  assert.deepEqual(parseActionBullets(md, /no such heading/i), [], "no matching section → no items");
});

test("buildSetupItems: integration/config-health nudges + an incomplete race entry (Finish setup)", () => {
  const profile = { schema_version: 1, identity: {}, races: [{ name: "Demo City Tri" /* no date */ }, { name: "Has Date", date: "2026-09-01" }] } as Profile;
  const items = buildSetupItems(profile, {
    questions: [],
    setupHealth: { hasApiKey: false, waterTempSet: false, lastSyncAgeHours: 96 },
    now: NOW,
  });
  const byKey = new Map(items.map((i) => [i.key, i]));
  // Operational nudges route to "in your setup".
  assert.ok(byKey.get("setup:health:apikey")?.route === "in your setup");
  assert.ok(byKey.get("setup:health:sync")?.label === "Sync your training data");
  assert.ok(byKey.get("setup:health:watertemp"), "open-water temp nudge present when unset");
  // A named race with no date gets an "edit profile" nudge; the dated one does not.
  assert.equal(byKey.get("setup:race:demo city tri")?.route, "edit profile");
  assert.ok(![...byKey.keys()].some((k) => k.includes("has date")), "a race with a date isn't nudged");
  // A healthy setup surfaces none of these.
  const clean = buildSetupItems({ schema_version: 1, identity: {} } as Profile, { questions: [], setupHealth: { hasApiKey: true, waterTempSet: true, lastSyncAgeHours: 2 }, now: NOW });
  assert.equal(clean.length, 0);
});

test("buildSetupItems: weekly review with no parseable actions falls back to a pointer", () => {
  const items = buildSetupItems({ schema_version: 1, identity: {} } as Profile, {
    questions: [],
    weeklyReview: { date: "2026-06-13", actions: [] },
    now: NOW,
  });
  assert.deepEqual(items.map((i) => [i.key, i.group]), [["setup:weekly:review", "this_week"]]);
});

test("buildSetupItems: stale weekly/research reports drop out (the freshness windows)", () => {
  const items = buildSetupItems({ schema_version: 1, identity: {} } as Profile, {
    questions: [],
    weeklyReview: { date: "2026-05-01", actions: ["old action"] }, // >10d before NOW → stale
    researchDigest: { date: "2026-01-01", topics: ["old topic"] }, // >45d → stale
    now: NOW,
  });
  assert.equal(items.length, 0, "nothing fresh, nothing to surface");
});

test("buildSetupItems: a research digest with no parseable topics falls back to a single review pointer", () => {
  const items = buildSetupItems({ schema_version: 1, identity: {} } as Profile, {
    questions: [],
    researchDigest: { date: "2026-06-14", topics: [] },
    now: NOW,
  });
  assert.deepEqual(items.map((i) => [i.label, i.key, i.group]), [["Review the latest research digest", "setup:research:digest", "worth_considering"]]);
});

test("buildSetupItems: a This-week item restating a finish-setup item is deduped (finish-setup wins)", () => {
  const profile = { schema_version: 1, identity: {}, open_items: ["Start the brick run easier"] } as Profile;
  const insights = insightsWith([F({ family: "Durability", title: "Brick", recommendation: "Start the brick run easier" })]);
  const items = buildSetupItems(profile, { questions: [], insights, now: NOW });
  const matching = items.filter((i) => /start the brick run easier/i.test(i.label));
  assert.equal(matching.length, 1, "the cross-group restatement is deduped");
  assert.equal(matching[0].group, "finish_setup", "and the finish-setup item is the one kept");
});

test("renderSetupImprove: group subheadings appear only when more than one section is present", () => {
  const profile = { schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" } } as Profile;
  const flat = renderSetupImprove(profile, false, { questions: [] });
  assert.doesNotMatch(flat, /setup-group/, "finish-setup only → flat, no subheadings");
  const grouped = renderSetupImprove(profile, false, {
    questions: [],
    researchDigest: { date: "2026-06-14", topics: ["90 g/h carb"] },
    now: NOW,
  });
  assert.match(grouped, /class="setup-group">Finish setup</);
  assert.match(grouped, /class="setup-group">Worth considering</);
  assert.match(grouped, /90 g\/h carb/);
});

test("Data changes card: surfaces an auto-detected metric change with agree/disagree, hidden when snoozed", () => {
  const mk = (date: string, ftp: number) => {
    const s = emptyState(date, new Date().toISOString());
    s.thresholds = { value: { bikeFtpW: ftp }, source: "garmin" };
    return s;
  };
  const window = [mk("2026-06-13", 250), mk(todayIso(), 262)];
  const html = renderDashboard({ window, decisions: [] });
  assert.match(html, /Data changes — your call/);
  assert.match(html, /<b>Bike FTP<\/b>: 250 W → <b>262 W<\/b>/);
  assert.match(html, /Garmin/);
  assert.match(html, /data-key="change:bikeFtpW:262"/);
  assert.match(html, /data-reaction="like" onclick="feedback\(this\)"/); // reuses the insight-feedback machinery
  // A saved disagree shows; snoozing (suppressed) hides the change entirely.
  const reacted = renderDashboard({ window, decisions: [], reactions: new Map([["change:bikeFtpW:262", "disagree"]]) });
  assert.match(reacted, /👎 disagreed/);
  const snoozed = renderDashboard({ window, decisions: [], suppressed: new Set(["change:bikeFtpW:262"]) });
  assert.doesNotMatch(snoozed, /Data changes — your call/);
  // No card when nothing changed.
  assert.doesNotMatch(renderDashboard({ window: [mk(todayIso(), 250)], decisions: [] }), /Data changes — your call/);
});

test("dashboard shows the Set-up-&-improve card only when a profile with outstanding items is supplied", () => {
  const s = emptyState("2026-06-18", new Date().toISOString());
  const withTodo = renderDashboard({
    window: [s],
    decisions: [],
    profile: { schema_version: 1, identity: {}, ai_endurance_todo: { swim_css: "not_set" } } as Profile,
  });
  assert.match(withTodo, /Set up &amp; improve/);
  assert.doesNotMatch(renderDashboard({ window: [s], decisions: [] }), /Set up &amp; improve/);
});

test("share view omits the interactive Sync card (no empty card in a screenshot/PDF)", () => {
  const s = emptyState("2026-06-18", new Date().toISOString());
  assert.match(renderDashboard({ window: [s], decisions: [] }), /Sync latest data/, "present in the interactive view");
  assert.doesNotMatch(renderDashboard({ window: [s], decisions: [], share: true }), /Sync latest data/, "dropped in share view");
  assert.match(renderDashboard({ window: [s], decisions: [] }), /\.syncbar\{display:none/, "and its card is print-hidden via .syncbar");
});

// --- De-dupe: each signal/recommendation appears in exactly one place ---

test("headline finding: shown once — the box marks it 'today's call', drops the repeated recommendation, stays reactable", () => {
  const s = emptyState("2026-06-08", new Date().toISOString());
  const ins = buildInsights(s, undefined, {});
  ins.topFindings = [
    { family: "Intensity distribution", title: "Grey-zone creep", severity: "watch", detail: "d", evidence: "e", confidence: 0.65, key: "grey", recommendation: "Slow the easy sessions down." } as Finding,
    { family: "Aerobic efficiency", title: "Run EF slipping", severity: "watch", detail: "d2", evidence: "e2", confidence: 0.6, key: "ef", recommendation: "Watch EF vs fatigue." } as Finding,
  ];
  const html = renderDashboard({ window: [s], decisions: [], insights: ins });
  // The lead recommendation appears exactly once (the Today action box) — not again in the insights box.
  assert.equal((html.match(/Slow the easy sessions down\./g) || []).length, 1, "lead recommendation is not duplicated");
  // The lead is marked in the box and still carries its feedback buttons (it stays reactable).
  assert.match(html, /today's call ↑/);
  assert.match(html, /data-key="grey"[\s\S]*?data-reaction="like"/);
  // A non-lead finding keeps its own recommendation arrow.
  assert.match(html, /→ Watch EF vs fatigue\./);
});

test("Today card shows each readiness signal once: Acute:chronic + limiter live in the drivers line, not also as chips", () => {
  const s = emptyState("2026-06-08", new Date().toISOString());
  s.trainingStatus = { value: { loadRatio: 1.0, acwrStatus: "OPTIMAL" }, source: "garmin" } as never;
  s.recovery = { value: { limiterToday: "ess" }, source: "ai-endurance" } as never;
  s.hrvStatus = { value: { status: "BALANCED" }, source: "garmin" } as never;
  const ins = buildInsights(s, undefined, {});
  ins.load = { ctl: 40, atl: 44, tsb: -4, rampPerWeek: 2, series: [{ date: "a", ctl: 38 }] } as never;
  const html = renderDashboard({ window: [s], decisions: [], insights: ins });
  assert.match(html, /Recovery limiter: ess/); // stated once, with context, in the drivers line
  assert.equal((html.match(/Acute:chronic/g) || []).length, 1, "ACWR shown once (drivers), not also a chip");
  assert.ok(!/<b>ess<\/b>/.test(html), "no standalone limiter chip duplicating the drivers line");
});

test("buildSetupItems: a gain already in the Top-insights box is dropped from This week (no cross-card repeat)", () => {
  const profile = { schema_version: 1, identity: {} } as Profile;
  const insights = insightsWith([F({ family: "Biomechanics", title: "Cadence fades", recommendation: "Add late-run cadence cues", key: "cad" })]);
  const shown = buildSetupItems(profile, { questions: [], insights });
  assert.ok(shown.some((i) => i.label === "Add late-run cadence cues"), "surfaces when NOT shown above");
  const hidden = buildSetupItems(profile, { questions: [], insights, surfacedInsightKeys: new Set(["cad"]) });
  assert.ok(!hidden.some((i) => i.label === "Add late-run cadence cues"), "dropped once it is in the box above");
});

test("buildSetupItems: a differently-worded restatement of the swim-CSS / FTP gap folds into the AIE item", () => {
  const items = buildSetupItems(
    {
      schema_version: 1,
      identity: {},
      ai_endurance_todo: { swim_css: "not_set", ftp_w: "unresolved" },
      open_items: ["Swim CSS not set in AI Endurance: no swim model", "FTP discrepancy: Garmin ~183 W vs AIE 223 W"],
    } as Profile,
    { questions: [] },
  );
  assert.equal(items.filter((i) => /css/i.test(i.label)).length, 1, "one swim-CSS item, not two");
  assert.equal(items.filter((i) => /ftp/i.test(i.label)).length, 1, "one FTP item, not two");
  assert.ok(items.every((i) => i.source !== "open_item"), "the open-item restatements folded into the AIE gaps");
});

test("recent decisions: re-reacting to the same insight is listed once (latest), not 2-3 times", () => {
  const s = emptyState("2026-06-08", new Date().toISOString());
  const decisions = [
    { kind: "insight-feedback", status: "accepted", summary: "Grey-zone creep" },
    { kind: "insight-feedback", status: "accepted", summary: "Cadence fades late in long runs" },
    { kind: "insight-feedback", status: "accepted", summary: "Grey-zone creep" },
  ] as unknown as DecisionRecord[];
  const html = renderDashboard({ window: [s], decisions });
  assert.equal((html.match(/Grey-zone creep/g) || []).length, 1, "the repeated reaction is shown once");
  assert.match(html, /Cadence fades late in long runs/);
});

test("commonTrailingSentences: returns the longest identical trailing run shared by all strings", () => {
  assert.equal(
    commonTrailingSentences(["A x. Shared one. Shared two.", "B y. Shared one. Shared two."]),
    "Shared one. Shared two.",
  );
  assert.equal(commonTrailingSentences(["only one string"]), "", "a single string shares nothing");
  assert.equal(commonTrailingSentences(["a. b.", "c. d."]), "", "no common tail → empty");
  assert.equal(commonTrailingSentences([]), "");
});

test("race splits: caveats every race repeats are hoisted into one shared note, stripped from each block", () => {
  const s = emptyState("2026-06-19", new Date().toISOString());
  const ins = buildInsights(s, undefined, {});
  const tail = "It assumes you stay healthy and taper. Worst case is racing at current fitness.";
  const stratTail = "Transitions are fixed estimates. Durability is trending up — wind it up.";
  ins.splits = [
    { race: "Race A", distanceKm: 50, predictedSec: 7740, worstSec: 7740, bestSec: 7560, rangeBasis: `With ~3 weeks to build, ~1.9%. ${tail}`, strategy: `Olympic plan: bike 83% FTP. ${stratTail}`, segments: [] },
    { race: "Race B", distanceKm: 50, predictedSec: 7800, worstSec: 7800, bestSec: 7400, rangeBasis: `With ~11 weeks to build, ~4.7%. ${tail}`, strategy: `Olympic plan: bike 83% FTP. ${stratTail}`, segments: [] },
  ] as never;
  const html = renderDashboard({ window: [s], decisions: [], insights: ins });
  // The shared caveats appear exactly once, under an "Applies to all races" note.
  assert.match(html, /Applies to all races:/);
  assert.equal((html.match(/Worst case is racing at current fitness\./g) || []).length, 1, "range caveat hoisted, not repeated");
  assert.equal((html.match(/Transitions are fixed estimates\./g) || []).length, 1, "strategy caveat hoisted, not repeated");
  // The race-specific lead of each block is kept.
  assert.match(html, /~1\.9%/);
  assert.match(html, /~4\.7%/);
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
