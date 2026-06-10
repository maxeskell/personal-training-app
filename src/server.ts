import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { networkInterfaces } from "node:os";
import { pathToFileURL } from "node:url";
import { loadDashboardToken, isAuthorized, hostAllowed, COOKIE, timingSafeEqualStr } from "./serverAuth.js";
import { AieClient } from "./mcp/aieClient.js";
import { GarminClient } from "./mcp/garminClient.js";
import { StateStore } from "./state/store.js";
import { assembleState } from "./state/assemble.js";
import { DecisionLog, suppressedInsightKeys, type InsightReaction } from "./state/decisionLog.js";
import { renderDashboard } from "./coach/dashboard.js";
import { buildInsights, type ArchiveInput } from "./insights/engine.js";
import { mapRichActivity } from "./insights/metrics.js";
import { ArchiveStore } from "./archive/store.js";
import { CoachLLM } from "./llm/client.js";
import { loadSystemPrompt } from "./coach/persona.js";
import { answerQuestion } from "./coach/ask.js";
import { runSessionFeedback, assembleSession } from "./coach/session.js";
import { loadSessionDecays, fitStreamsDir } from "./insights/fit.js";
import { readCostRecords } from "./llm/costLog.js";
import { syncFitSummaries, downloadFitStream, hasStreamDownloadTool } from "./archive/fitSync.js";
import { proposeAdjustments, validateProposals, buildProposerContext } from "./coach/planAdjust.js";
import { WriteGate } from "./guardrails/writeGate.js";
import { alertFindings } from "./insights/metrics.js";
import { config } from "./config.js";

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

async function loadArchive(): Promise<ArchiveInput | undefined> {
  const store = new ArchiveStore();
  const acts = await store.loadActivities();
  const gar = await store.loadGarminDays();
  const fitSummaries = await store.loadFitSummaries();
  if (!acts.length && !gar.length && !fitSummaries.length) return undefined;
  return {
    activities: acts.map((a) => mapRichActivity(a.raw, a.sport)),
    garminDays: gar, // GarminDay already carries every field ArchiveInput needs (incl. slice-1b series)
    fitSummaries,
  };
}

function lanUrls(): string[] {
  const out: string[] = [`http://localhost:${PORT}`];
  for (const ifs of Object.values(networkInterfaces())) {
    for (const i of ifs ?? []) {
      if (i.family === "IPv4" && !i.internal) out.push(`http://${i.address}:${PORT}`);
    }
  }
  return out;
}

async function renderLatest(): Promise<string> {
  const store = new StateStore();
  const today = new Date().toISOString().slice(0, 10);
  const window = await store.recent(today, 14);
  if (!window.length) {
    return `<!doctype html><body style="font-family:sans-serif;padding:40px;max-width:600px;margin:auto">
      <h2>No data yet</h2><p>Run <code>npm run ping</code> (or hit <a href="/refresh">/refresh</a>) to assemble your first state.</p></body>`;
  }
  const latest = window[window.length - 1];
  const log = new DecisionLog();
  const decisions = await log.all();
  const suppressed = suppressedInsightKeys(await log.insightReactions());
  const archive = await loadArchive();
  const insights = latest.raw ? buildInsights(latest, archive, { suppressed, history: window }) : undefined;
  return renderDashboard({
    window,
    decisions,
    insights,
    garminDays: archive?.garminDays,
    costRecords: await readCostRecords(),
    fitSummaries: archive?.fitSummaries,
    canFetchFit: config.garmin.enabled,
  });
}

async function refresh(): Promise<void> {
  const store = new StateStore();
  const garmin = config.garmin.enabled ? new GarminClient() : undefined;
  if (garmin) await garmin.connect();
  const aie = new AieClient();
  await aie.connect();
  try {
    const today = new Date().toISOString().slice(0, 10);
    const state = await assembleState(aie, garmin, store, { date: today, assembledAt: new Date().toISOString() });
    await store.save(state);
    // Keep the thermal layer (session card + heat confounder) current, hands-free. fit-sync dedups
    // against the archive, so steady-state this fetches ~0–1 new activities; only the first run is slow.
    // Best-effort: a fit-sync failure must never break a refresh. (Biomechanics still need a raw .FIT.)
    if (garmin) {
      try {
        await syncFitSummaries(garmin, new ArchiveStore(), 5);
      } catch (e) {
        console.warn(`fit-sync during refresh failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  } finally {
    await aie.close();
    await garmin?.close();
  }
}

/** Latest state + its insights (gated, feedback-aware) — shared by /act. */
async function latestInsights() {
  const store = new StateStore();
  const today = new Date().toISOString().slice(0, 10);
  const window = await store.recent(today, 14);
  const state = window[window.length - 1];
  if (!state?.raw) return null;
  const suppressed = suppressedInsightKeys(await new DecisionLog().insightReactions());
  const insights = buildInsights(state, await loadArchive(), { suppressed, history: window });
  return { state, insights };
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
      const today = new Date().toISOString().slice(0, 10);
      const window = await store.recent(today, 1);
      const state = window[window.length - 1];
      if (!state) {
        res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer: "No data assembled yet — hit ↻ refresh first." }));
        return;
      }
      const { answer } = await answerQuestion(new CoachLLM(await loadSystemPrompt(), "ask", "medium"), question, state, await loadArchive());
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer }));
      return;
    }

    // Deep feedback on a single session (the dashboard "Last session" card posts here).
    if (url.pathname === "/session-feedback" && req.method === "POST") {
      const json = (b: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (!CoachLLM.hasApiKey()) return json({ markdown: "ANTHROPIC_API_KEY isn't set on the server, so I can't analyse sessions yet." });
      const li = await latestInsights();
      if (!li) return json({ markdown: "No data assembled yet — hit ↻ Sync first." });
      const body = JSON.parse((await readBody(req)) || "{}") as { date?: string; force?: boolean };
      const reqDate = String(body.date ?? "");
      const date = /^\d{4}-\d{2}-\d{2}$/.test(reqDate) ? reqDate : undefined;
      let decays = loadSessionDecays();
      const fitSummaries = await new ArchiveStore().loadFitSummaries();
      // On-demand stream fetch (user ask): if the target session's raw .FIT isn't local but the archive
      // knows its Garmin id, pull it now (~seconds) so the deep dive runs with biomechanics instead of
      // skipping. Best-effort — on any failure the no-fit gate below still protects the LLM spend.
      const probe = assembleSession(li.state, li.insights, { date, decays, fitSummaries });
      if (probe && !probe.decay && probe.fit?.activityId && config.garmin.enabled) {
        const g = new GarminClient();
        if (await g.connect()) {
          try {
            if ((await hasStreamDownloadTool(g)) && (await downloadFitStream(g, probe.fit.activityId, fitStreamsDir()))) {
              decays = loadSessionDecays();
            }
          } finally {
            await g.close();
          }
        }
      }
      const feedback = await runSessionFeedback(new CoachLLM(await loadSystemPrompt(), "session", "medium"), li.state, li.insights, {
        date,
        force: body.force === true, // escape hatch: summary-only analysis without the raw .FIT
        decays,
        fitSummaries,
      });
      return json({ markdown: feedback?.markdown ?? "No recent activity found to analyse.", skippedNoFit: feedback?.skippedNoFit === true });
    }

    // Insight feedback (the insights box posts agree/disagree/ignore here).
    if (url.pathname === "/insight-feedback" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}") as { key?: string; reaction?: string; summary?: string };
      const reaction = body.reaction as InsightReaction;
      if (!body.key || !["agree", "disagree", "ignore"].includes(reaction)) {
        res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ ok: false, error: "need key + reaction" }));
        return;
      }
      await new DecisionLog().recordInsightFeedback(body.key, reaction, body.summary ?? body.key);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }

    // Action loop — generate GATED plan-adjustment proposals from the surfaced alerts (no write here).
    if (url.pathname === "/act" && req.method === "POST") {
      const json = (b: object) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(b));
      if (!CoachLLM.hasApiKey()) return json({ proposals: [], notes: "ANTHROPIC_API_KEY isn't set on the server." });
      const li = await latestInsights();
      if (!li) return json({ proposals: [], notes: "No data assembled yet — hit Sync first." });
      const actionable = alertFindings(li.insights.topFindings);
      if (!actionable.length) return json({ proposals: [], notes: "Nothing above the alert bar needs a plan change." });
      const ctx = buildProposerContext(li.state, li.insights); // full picture: load/form + health + races + taper
      const request =
        "Turn these surfaced signals into minimal, specific plan adjustments with trade-offs (don't restructure the week; smallest change that helps):\n" +
        actionable.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}${f.recommendation ? ` (suggested: ${f.recommendation})` : ""}`).join("\n");
      const { result } = await proposeAdjustments(new CoachLLM(await loadSystemPrompt(), "act"), request, li.state, ctx);
      const { valid, rejected } = validateProposals(result.proposals, li.state.plannedSessions.value ?? []);
      const gate = new WriteGate(new AieClient(), new DecisionLog()); // propose() never calls the API
      const proposals = [];
      for (const p of valid) {
        const pr = await gate.propose({ tool: p.tool as never, args: p.args, rationale: p.summary, tradeoff: p.tradeoff, human: p.human });
        proposals.push({ id: pr.id, human: p.human, summary: p.summary, tradeoff: p.tradeoff, basis: p.basis });
      }
      const notes = [result.notes, rejected.length ? `Not applied: ${rejected.join("; ")}` : ""].filter(Boolean).join(" ");
      return json({ proposals, notes });
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
      await refresh();
      res.writeHead(302, { Location: "/" }).end();
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await renderLatest();
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
    for (const u of lanUrls()) console.log(`  ${u}/pair?token=${TOKEN}`);
    console.log(LAN ? "(open the /pair link on your phone — same Wi-Fi; token gates all access)" : "(localhost only; set COACH_LAN=1 to allow your phone on the LAN)");
  });
}
