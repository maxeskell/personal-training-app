import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { loadDashboardToken, isAuthorized, hostAllowed, COOKIE, timingSafeEqualStr } from "./serverAuth.js";
import { AieClient } from "./mcp/aieClient.js";
import { GarminClient } from "./mcp/garminClient.js";
import { StateStore } from "./state/store.js";
import { selectDataSource } from "./sources/index.js";
import { DecisionLog, suppressedInsightKeys, reactionFromLabel } from "./state/decisionLog.js";
import { InsightLog } from "./state/insightLog.js";
import { loadEngagementContext } from "./coach/engagementContext.js";
import { renderDashboard, renderResearchDigestPage, aieGapKeyFromSetupKey } from "./coach/dashboard.js";
import { latestAdviceFindings } from "./coach/adviceRecs.js";
import { updateLocalProfile } from "./profile/update.js";
import { latestWeeklyReview, latestResearchDigest } from "./coach/setupSources.js";
import { listPending, readPending } from "./knowledge/store.js";
import { loadSessionFeedbacks, saveSessionFeedback, latestByDate } from "./coach/sessionFeedbackStore.js";
import { loadMetricOverrides, setMetricOverride, clearMetricOverride } from "./state/metricOverrides.js";
import { TRACKED_METRICS } from "./coach/metricChanges.js";
import { backfillSessionFeedback } from "./coach/autoSessionFeedback.js";
import { buildInsights } from "./insights/engine.js";
import { loadArchive } from "./coach/orchestrator.js";
import { ArchiveStore } from "./archive/store.js";
import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { answerQuestion } from "./coach/ask.js";
import { loadProfileSafe } from "./profile/load.js";
import { runSessionFeedback, assembleSession } from "./coach/session.js";
import { loadSessionDecays, fitStreamsDir } from "./insights/fit.js";
import { readCostRecords } from "./llm/costLog.js";
import { syncFitSummaries, downloadFitStream, hasStreamDownloadTool } from "./archive/fitSync.js";
import { proposeAdjustments, validateProposals, buildProposerContext, writeContextFor } from "./coach/planAdjust.js";
import { WriteGate } from "./guardrails/writeGate.js";
import { alertFindings } from "./insights/metrics.js";
import { getForecast, refreshForecast } from "./weather/store.js";
import { assessWeek, upcomingPlanned, type WeekWeather } from "./weather/assess.js";
import { config } from "./config.js";
import { todayIso } from "./util/today.js";
import { coalesce } from "./util/coalesce.js";

/**
 * Local dashboard server (N1, Path-B need #2 upgraded to "online"). Binds to the LAN so a phone on
 * the same Wi-Fi can reach it at http://<mac-ip>:3000. Creds never leave the Mac — the phone only
 * talks to this server. Kept alive by pm2 (see ecosystem.config.cjs).
 *
 * Routes:
 *   GET /         render the dashboard from the latest persisted state (fast — no network)
 *   GET /refresh  re-assemble today's state (hits AIE + Garmin), then redirect to /
 */
const PORT = Number(process.env.COACH_PORT ?? 3000);
const LAN = process.env.COACH_LAN === "1"; // opt-in to bind the LAN (phone access); off → localhost only
const HOST = process.env.COACH_HOST ?? (LAN ? "0.0.0.0" : "127.0.0.1");
const TOKEN = loadDashboardToken();
const MAX_BODY = 64 * 1024;

/** The machine's own LAN IPv4s — allowed Host values when LAN mode is on (anti DNS-rebind). */
function lanIps(): string[] {
  const out: string[] = [];
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) if (i.family === "IPv4" && !i.internal) out.push(i.address);
  }
  return out;
}
const ALLOWED_HOSTS = LAN ? lanIps() : [];

function lanUrls(): string[] {
  const out: string[] = [`http://localhost:${PORT}`];
  if (!LAN) return out; // localhost-only: the LAN addresses aren't bound, so don't advertise them
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(`http://${i.address}:${PORT}`);
    }
  }
  return out;
}

async function renderLatest(share = false): Promise<string> {
  const store = new StateStore();
  const today = todayIso();
  const window = await store.recent(today, 14);
  if (!window.length) {
    return `<!doctype html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
      <h2>No data yet</h2><p>Run <code>npm run ping</code> (or hit <a href="/refresh">/refresh</a>) to assemble your first state.</p></body>`;
  }
  const latest = window[window.length - 1];
  const log = new DecisionLog();
  const decisions = await log.all();
  const reactionState = await log.insightReactions();
  const suppressed = suppressedInsightKeys(reactionState);
  const reactions = new Map([...reactionState].map(([k, v]) => [k, v.reaction] as const));
  const archive = await loadArchive();
  const engagement = await loadEngagementContext(window); // closes the loop: feedback/adherence reshape surfacing
  const insightLog = new InsightLog();
  // Read first-seen BEFORE recording this render, so a finding new to this render reads as brand new.
  const firstSeen = await insightLog.firstSeenByKey();
  // Reactable advice from the latest readiness + deep-dive write-ups (item 4-iii), dropping suppressed.
  const coachRecs = latestAdviceFindings(await insightLog.all(), suppressed);
  const insights = latest.raw ? buildInsights(latest, archive, { suppressed, history: window, engagement }) : undefined;
  // Record the full surfaced set (not just what gets a reaction) so the "what I listen to" model
  // (npm run listening) can read feedback against everything shown. Best-effort, de-duped, never blocks.
  if (insights) await insightLog.recordSurfaced(insights.topFindings, "dashboard");
  // Week-ahead weather: cached (or short-timeout fetched) forecast joined to the upcoming plan.
  // Best-effort — undefined just means the card is absent, never an error page.
  let weather: WeekWeather | undefined;
  if (config.weather.enabled) {
    const fc = await getForecast();
    if (fc) {
      const plan = upcomingPlanned(window, today);
      weather = assessWeek(plan.sessions, fc, { ...config.weather, planAsOf: plan.asOf });
    }
  }
  // Stale-while-revalidate (user ask: "sync when we load the page"): render instantly from the
  // snapshot, and when it's old enough, have the page kick a background Sync and reload itself.
  const staleMin = Math.round((Date.now() - new Date(latest.assembledAt).getTime()) / 60_000);
  const autoSyncStaleMin = config.autoSyncMinutes > 0 && staleMin >= config.autoSyncMinutes ? staleMin : undefined;
  return renderDashboard({
    window,
    decisions,
    insights,
    reactions,
    firstSeen,
    share,
    garminDays: archive?.garminDays,
    costRecords: await readCostRecords(),
    fitSummaries: archive?.fitSummaries,
    canFetchFit: config.garmin.enabled,
    weather,
    profile: (await loadProfileSafe())?.profile,
    autoSyncStaleMin,
    suppressed, // dismissed "Set up & improve" items (shares the insight snooze machinery)
    weeklyReview: await latestWeeklyReview(), // "This week" group — read persisted, never re-run
    researchDigest: await latestResearchDigest(), // "Worth considering" group — read persisted, never re-run
    sessionFeedbacks: await loadSessionFeedbacks(), // auto-generated at sync; shown inline, no LLM here
    metricOverrides: await loadMetricOverrides(), // your pins on auto-detected metrics (Data-changes card)
    coachRecs, // reactable recommendations from your latest readiness + deep-dive write-ups
    setupHealth: {
      hasApiKey: CoachLLM.hasApiKey(),
      waterTempSet: config.weather.waterTempC != null,
      lastSyncAgeHours: (Date.now() - new Date(latest.assembledAt).getTime()) / 3_600_000,
    },
  });
}

/** Concurrent /refresh calls (e.g. two devices auto-syncing at once) share ONE assemble. */
let refreshInFlight: Promise<void> | null = null;
function refreshOnce(): Promise<void> {
  refreshInFlight ??= refresh().finally(() => {
    refreshInFlight = null;
  });
  return refreshInFlight;
}

async function refresh(): Promise<void> {
  const store = new StateStore();
  const garmin = config.garmin.enabled ? new GarminClient() : undefined;
  if (garmin) await garmin.connect();
  try {
    // Assemble via the configured spine (AI Endurance or intervals.icu — see src/sources/).
    const today = todayIso();
    const state = await selectDataSource().assemble({ store, garmin, date: today, assembledAt: new Date().toISOString() });
    await store.save(state);
    // Keep the thermal layer (session card + heat confounder) current, hands-free. fit-sync dedups
    // against the archive, so steady-state this fetches ~0–1 new activities; only the first run is slow.
    // Best-effort: a fit-sync failure must never break a refresh. (Biomechanics still need a raw .FIT.)
    if (garmin) {
      try {
        const fs = await syncFitSummaries(garmin, new ArchiveStore(), 5);
        // A swallowed stream-download failure used to leave a clean-looking refresh hiding a missing
        // biomechanics layer. Surface the reason in the server log instead.
        if (fs.streamsFailed) {
          console.warn(`fit-sync: ${fs.streamsFailed} raw .FIT download(s) failed — biomechanics/splits will be missing for these:`);
          for (const f of fs.streamFailures) console.warn(`  ! ${f}`);
        }
      } catch (e) {
        console.warn(`fit-sync during refresh failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (config.weather.enabled) await refreshForecast(); // best-effort inside — never fails a refresh
    // Auto deep session-feedback: generate + persist a deep dive for any recent session that lacks one
    // (runs AFTER fit-sync so the raw .FIT is present). Best-effort + API-key-gated; no-FIT sessions are
    // retried cheaply on a later sync. The dashboard then shows it inline with no button.
    try {
      const li = await latestInsights();
      if (li) {
        const n = await backfillSessionFeedback(li.state, li.insights, {});
        if (n) console.log(`auto session-feedback: generated ${n} new readout(s)`);
      }
    } catch (e) {
      console.warn(`auto session-feedback skipped (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
    }
  } catch (err) {
    // Degrade, don't crash: an unreachable/unauthenticated spine leaves the last good state in place
    // rather than tearing down the refresh loop (which serves the dashboard hands-free).
    console.warn(`refresh skipped — data source unavailable: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await garmin?.close();
  }
}

/** Latest state + its insights (gated, feedback-aware) — shared by /act and /act-item. */
async function latestInsights() {
  const store = new StateStore();
  const today = todayIso();
  const window = await store.recent(today, 14);
  const state = window[window.length - 1];
  if (!state?.raw) return null;
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const engagement = await loadEngagementContext(window);
  const insights = buildInsights(state, await loadArchive(), { suppressed, history: window, engagement });
  return { state, insights, engagement };
}

type LatestInsights = NonNullable<Awaited<ReturnType<typeof latestInsights>>>;
type SessionFeedbackResult = { status: string; markdown: string; deep?: boolean };

/** In-flight session-feedback generations, keyed by `${date}:${force}` — see the /session-feedback route. */
const sessionFeedbackInFlight = new Map<string, Promise<SessionFeedbackResult>>();

/**
 * Draft a free-text request into concrete, validated, GATED plan-adjustment proposals (no write here —
 * confirming one is the only path that writes). Shared by /act (acts on the surfaced alerts) and /act-item
 * (acts on one specific "This week" recommendation). The proposer is re-validated against the athlete's
 * real scheduled sessions, so anything un-targetable degrades to a `notes` explanation, never a bad write.
 */
async function draftGatedProposals(li: LatestInsights, request: string) {
  const ctx = buildProposerContext(li.state, li.insights, li.engagement); // full picture: load/form + health + races + taper + decline-aware
  const { result } = await proposeAdjustments(new CoachLLM(await loadSystemPrompt(), "act"), request, li.state, ctx);
  const { valid, rejected } = validateProposals(result.proposals, li.state.plannedSessions.value ?? [], writeContextFor(li.state));
  const gate = new WriteGate(new AieClient(), new DecisionLog()); // propose() never calls the API
  const proposals = [];
  for (const p of valid) {
    const pr = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human });
    proposals.push({ id: pr.id, human: p.human, summary: p.summary, tradeoff: p.tradeoff, basis: p.basis });
  }
  const notes = [result.notes, rejected.length ? `Not applied: ${rejected.join("; ")}` : ""].filter(Boolean).join(" ");
  return { proposals, notes };
}

/**
 * Generate + persist deep feedback for ONE session — the expensive path: an optional on-demand .FIT
 * download, then one LLM call. Re-checks the store first so a sibling sync that just wrote it short-circuits
 * (no spend). Returns the card's response shape. Wrapped by coalesce() in the route so two concurrent
 * requests for the same session run it once and share the result (no double LLM spend).
 */
async function produceSessionFeedback(li: LatestInsights, date: string, force: boolean): Promise<SessionFeedbackResult> {
  let decays = loadSessionDecays();
  const fitSummaries = await new ArchiveStore().loadFitSummaries();
  const probe = assembleSession(li.state, li.insights, { date, decays, fitSummaries });
  if (!probe) return { status: "no-data", markdown: "No recent activity found to analyse." };
  const existing = latestByDate(await loadSessionFeedbacks()).get(probe.date);
  if (existing) return { status: "ready", markdown: existing.markdown, deep: existing.deep };
  // On-demand stream fetch: if the raw .FIT isn't local but the archive knows the Garmin id, pull it now
  // (~seconds) so the deep dive runs with biomechanics. Best-effort — the no-fit gate below still protects spend.
  if (!probe.decay && probe.fit?.activityId && config.garmin.enabled) {
    const g = new GarminClient();
    if (await g.connect()) {
      try {
        if ((await hasStreamDownloadTool(g)) && (await downloadFitStream(g, probe.fit.activityId, fitStreamsDir())).ok) {
          decays = loadSessionDecays();
        }
      } finally {
        await g.close();
      }
    }
  }
  const feedback = await runSessionFeedback(new CoachLLM(await loadSystemPrompt(), "session", "medium"), li.state, li.insights, { date, force, decays, fitSummaries });
  if (!feedback) return { status: "no-data", markdown: "No recent activity found to analyse." };
  if (feedback.skippedNoFit) return { status: "no-fit", markdown: feedback.markdown };
  // Persist so subsequent page loads serve it inline (no LLM on render) — same store the auto-backfill writes.
  await saveSessionFeedback({
    date: feedback.detail.date,
    sport: String(feedback.detail.sport),
    deep: !!feedback.detail.decay,
    generatedAt: new Date().toISOString(),
    costUsd: feedback.costUsd,
    markdown: feedback.markdown,
  });
  return { status: "ready", markdown: feedback.markdown, deep: !!feedback.detail.decay };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    let over = false;
    req.on("data", (c) => {
      if (over) return; // keep draining the socket but stop buffering
      size += (c as Buffer).length;
      if (size > MAX_BODY) {
        over = true;
        reject(new Error("body too large"));
        return;
      }
      data += String(c);
    });
    req.on("end", () => { if (!over) resolve(data); });
    req.on("error", reject);
    req.on("aborted", () => { if (!over) reject(new Error("request aborted")); });
  });
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  try {
    // Anti DNS-rebinding: the Host must be localhost (or our own LAN IP in LAN mode).
    if (!hostAllowed(req.headers.host, ALLOWED_HOSTS)) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Forbidden host");
      return;
    }
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    // Pairing: GET /pair?token=… sets the auth cookie, then redirect to the dashboard.
    if (url.pathname === "/pair") {
      const t = url.searchParams.get("token") ?? "";
      if (timingSafeEqualStr(t, TOKEN)) {
        res.writeHead(302, { Location: "/", "set-cookie": COOKIE(TOKEN) }).end();
      } else {
        res.writeHead(401, { "content-type": "text/plain" }).end("Bad pairing token");
      }
      return;
    }

    // Everything else requires the token (cookie from /pair, or X-Coach-Token header).
    if (!isAuthorized(req.headers, TOKEN)) {
      res.writeHead(401, { "content-type": "text/plain" }).end("Unauthorized — open the /pair?token=… link printed at startup.");
      return;
    }

    // Free-form Q&A (dashboard chat box posts here).
    if (url.pathname === "/ask" && req.method === "POST") {
      if (!CoachLLM.hasApiKey()) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer: "ANTHROPIC_API_KEY isn't set on the server, so I can't answer questions yet." }));
        return;
      }
      const body = await readBody(req);
      const question = String((JSON.parse(body || "{}") as { question?: string }).question ?? "").trim();
      if (!question) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ answer: "Ask me something about your training." }));
        return;
      }
      const store = new StateStore();
      const today = todayIso();
      const window = await store.recent(today, 1);
      const state = window[window.length - 1];
      if (!state) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer: "No data assembled yet — hit ↻ refresh first." }));
        return;
      }
      // Best-effort: attach the stable profile so the dashboard Ask box has the same medical/biomechanical
      // context as CLI/MCP ask (which build state via buildTodayState). In-memory only; degrades to
      // no-profile when absent/invalid, and the store strips it so it never reaches data/state/*.json.
      const loaded = await loadProfileSafe();
      if (loaded) state.profile = loaded.profile;
      const { answer } = await answerQuestion(new CoachLLM(await loadSystemPrompt(), "ask", "medium"), question, state, await loadArchive());
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer }));
      return;
    }

    // Deep feedback on a single session — the dashboard "Last session" card fetches this on page load
    // when no readout is stored yet (it downloads the raw .FIT on demand, generates, and persists, so the
    // next open is inline). Returns a `status` the card branches on: ready | no-fit | no-api-key | no-data.
    if (url.pathname === "/session-feedback" && req.method === "POST") {
      const json = (b: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (!CoachLLM.hasApiKey()) return json({ status: "no-api-key", markdown: "ANTHROPIC_API_KEY isn't set on the server, so I can't analyse sessions yet." });
      const li = await latestInsights();
      if (!li) return json({ status: "no-data", markdown: "No data assembled yet — hit ↻ Sync first." });
      const body = JSON.parse((await readBody(req)) || "{}") as { date?: string; force?: boolean };
      const reqDate = String(body.date ?? "");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(reqDate) ? reqDate : undefined;
      const force = body.force === true; // escape hatch: summary-only analysis without the raw .FIT
      // Resolve the target session up front (cheap — no network/LLM) so we can dedupe by its date and
      // short-circuit when it's already stored.
      const probe = assembleSession(li.state, li.insights, { date, decays: loadSessionDecays(), fitSummaries: await new ArchiveStore().loadFitSummaries() });
      if (!probe) return json({ status: "no-data", markdown: "No recent activity found to analyse." });
      const existing = latestByDate(await loadSessionFeedbacks()).get(probe.date);
      if (existing) return json({ status: "ready", markdown: existing.markdown, deep: existing.deep });
      // Coalesce concurrent requests for the SAME session into ONE generate: two dashboard tabs opened
      // together (or a quick double-load) must not each fire the LLM — the expensive download+analyse runs
      // once and both await it. Keyed by date(+force); the slot frees when it settles.
      return json(await coalesce(sessionFeedbackInFlight, `${probe.date}:${force ? "force" : ""}`, () => produceSessionFeedback(li, probe.date, force)));
    }

    // Insight feedback (the insights box + the Set-up card's task buttons post here). The UI vocabulary
    // maps to the persisted reactions: like→agree, dislike→disagree (still shown, just down-ranked),
    // snooze→ignore (hides ~2wk), done→completed and dismiss→dismissed (both hide forever), clear→neutral.
    // Canonical names are still accepted for back-compat.
    if (url.pathname === "/insight-feedback" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { key?: string; reaction?: string; summary?: string; family?: string };
      const reaction = reactionFromLabel(String(body.reaction));
      if (!body.key || !reaction) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "need key + reaction" }));
        return;
      }
      const family = typeof body.family === "string" && body.family.trim() ? body.family.trim() : undefined;
      await new DecisionLog().recordInsightFeedback(body.key, reaction, body.summary ?? body.key, family);
      // "✓ Done" on an AI-Endurance setup gap is also written `resolved` into profile.local.yaml, so the
      // gap stays cleared across rebuilds — not just suppressed in the decision log. Other item sources
      // have no profile field, so they're recorded only. Best-effort: a profile-write failure (e.g. the
      // no-live-numbers guard, missing file) must not fail the reaction the athlete already gave.
      let profileWritten = false;
      const gap = reaction === "done" ? aieGapKeyFromSetupKey(body.key) : null;
      if (gap) {
        try {
          await updateLocalProfile({ ai_endurance_todo: { [gap]: "resolved" } });
          profileWritten = true;
        } catch (e) {
          console.warn(`[insight-feedback] could not mark ${gap} resolved in profile:`, e);
        }
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, profileWritten }));
      return;
    }

    // Metric overrides (the Data-changes card's 👎 pin / un-pin). Pinning records "while the platform
    // reports `when`, use `use` instead"; clearing accepts the auto-detected value again. Applied at the
    // next sync's assemble. Validated against the tracked-metric set so an arbitrary field can't be set.
    if (url.pathname === "/metric-override" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { metric?: string; when?: number; use?: number; clear?: boolean };
      const json = (code: number, b: object) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (!body.metric || !TRACKED_METRICS.has(body.metric)) return json(400, { ok: false, error: "unknown metric" });
      if (body.clear) {
        await clearMetricOverride(body.metric);
        return json(200, { ok: true, cleared: body.metric });
      }
      if (typeof body.when !== "number" || typeof body.use !== "number") return json(400, { ok: false, error: "need numeric when + use" });
      await setMetricOverride(body.metric, body.when, body.use);
      return json(200, { ok: true });
    }

    // Action loop — generate GATED plan-adjustment proposals from the surfaced alerts (no write here).
    if (url.pathname === "/act" && req.method === "POST") {
      const json = (b: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (!CoachLLM.hasApiKey()) return json({ proposals: [], notes: "ANTHROPIC_API_KEY isn't set on the server." });
      const li = await latestInsights();
      if (!li) return json({ proposals: [], notes: "No data assembled yet — hit Sync first." });
      const actionable = alertFindings(li.insights.topFindings);
      if (!actionable.length) return json({ proposals: [], notes: "Nothing above the alert bar needs a plan change." });
      const request =
        "Turn these surfaced signals into minimal, specific plan adjustments with trade-offs (don't restructure the week; smallest change that helps):\n" +
        actionable.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}${f.recommendation ? ` (suggested: ${f.recommendation})` : ""}`).join("\n");
      return json(await draftGatedProposals(li, request));
    }

    // "Make this change" on a "This week" training card: draft ONE specific recommendation into a concrete,
    // gated plan edit (same propose→confirm machinery as /act). No matching session → notes with the steps.
    if (url.pathname === "/act-item" && req.method === "POST") {
      const json = (b: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (!CoachLLM.hasApiKey()) return json({ proposals: [], notes: "ANTHROPIC_API_KEY isn't set on the server." });
      const body = JSON.parse((await readBody(req)) || "{}") as { recommendation?: string };
      const recommendation = String(body.recommendation ?? "").slice(0, 300).trim();
      if (!recommendation) return json({ proposals: [], notes: "No recommendation provided." });
      const li = await latestInsights();
      if (!li) return json({ proposals: [], notes: "No data assembled yet — hit Sync first." });
      const request =
        "Turn THIS one recommendation from the weekly review into the smallest concrete plan edit that delivers it " +
        "(don't restructure the week). If it can't be tied to a specific scheduled session, propose nothing and use " +
        "`notes` to say — in plain English — exactly how to make it yourself in AI Endurance or Garmin:\n- " +
        recommendation;
      return json(await draftGatedProposals(li, request));
    }

    // Confirm a proposal — the ONLY path that WRITES to AI Endurance (gated; two-step from /act).
    if (url.pathname === "/confirm-proposal" && req.method === "POST") {
      const id = String((JSON.parse((await readBody(req)) || "{}") as { id?: string }).id ?? "");
      if (!id) return void res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "need id" }));
      const aie = new AieClient();
      await aie.connect();
      try {
        const result = await new WriteGate(aie, new DecisionLog()).confirm(id);
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, result: typeof result === "string" ? result.slice(0, 200) : "applied" }));
      } catch (err) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
      } finally {
        await aie.close();
      }
      return;
    }

    if (url.pathname === "/decline-proposal" && req.method === "POST") {
      const id = String((JSON.parse((await readBody(req)) || "{}") as { id?: string }).id ?? "");
      if (id) await new WriteGate(new AieClient(), new DecisionLog()).decline(id);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    if (url.pathname === "/refresh") {
      await refreshOnce();
      res.writeHead(302, { Location: "/" }).end();
      return;
    }
    // Read-only view of the latest pending research digest — what the "Worth considering" card's "Read the
    // full digest" link points at, so "where's the research?" is answered in-app (the digest itself lives in
    // gitignored knowledge/pending/). Best-effort: no/unreadable digest renders a friendly empty state.
    if (url.pathname === "/digest") {
      let file: string | null = null;
      let md: string | null = null;
      try {
        const newest = (await listPending())[0]; // newest-first
        if (newest) {
          file = newest.name;
          md = await readPending(newest.name);
        }
      } catch {
        /* degrade to the empty-state page */
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(renderResearchDigestPage(file, md));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      // ?share=1 → redacted view for screenshots (toggle link on the page). Real-time, no state change.
      const html = await renderLatest(url.searchParams.get("share") === "1");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
      return;
    }
    res.writeHead(404).end("Not found");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(msg === "body too large" ? 413 : 500, { "content-type": "text/plain" }).end(`Error: ${msg}`);
  }
}

/** Build the server without listening (so tests can bind an ephemeral port). */
export function createCoachServer(): Server {
  const s = createServer((req, res) => void handle(req, res));
  s.on("clientError", (_e, socket) => socket.destroy());
  return s;
}

// Only listen when run directly (not when imported by tests).
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const server = createCoachServer();
  server.on("error", (e) => console.error(`Server error: ${e instanceof Error ? e.message : e}`));
  server.listen(PORT, HOST, () => {
    console.log(`Endurance Coach dashboard on:`);
    // The pairing token is a secret. Only print it inline when stdout is an interactive TTY; under
    // launchd/pm2 (stdout → reports/server.log) print the bare URL so the token isn't persisted in a
    // log file (ENG-4). The token lives in ~/.endurance-coach/dashboard.token for first-time pairing.
    const showToken = process.stdout.isTTY;
    for (const u of lanUrls()) console.log(`  ${u}/pair${showToken ? `?token=${TOKEN}` : "?token=<see ~/.endurance-coach/dashboard.token>"}`);
    if (!showToken) console.log("(token redacted from this log — read it from ~/.endurance-coach/dashboard.token)");
    console.log(LAN ? "(open the /pair link on your phone — same Wi-Fi; token gates all access)" : "(localhost only; set COACH_LAN=1 to allow your phone on the LAN)");
  });
}
