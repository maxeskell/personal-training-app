import { createServer, type IncomingMessage } from "node:http";
import { networkInterfaces } from "node:os";
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
import { proposeAdjustments, parseArgs } from "./coach/planAdjust.js";
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
const HOST = process.env.COACH_HOST ?? "0.0.0.0"; // all interfaces → reachable on the LAN

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
  return renderDashboard({ window, decisions, insights, garminDays: archive?.garminDays });
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
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += String(c)));
    req.on("end", () => resolve(data));
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

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
      const { answer } = await answerQuestion(new CoachLLM(await loadSystemPrompt()), question, state, await loadArchive());
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ answer }));
      return;
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
      const r = li.state.recovery.value;
      const ts = li.state.trainingStatus.value;
      const ctx = [
        li.insights.load ? `- Load: CTL ${li.insights.load.ctl} / ATL ${li.insights.load.atl} / TSB ${li.insights.load.tsb}, ΔCTL/wk ${li.insights.load.rampPerWeek}` : "",
        ts ? `- Garmin acute:chronic ${ts.loadRatio ?? "—"} (${ts.acwrStatus ?? "—"}), status ${ts.label ?? "—"}` : "",
        r?.limiterToday ? `- Recovery limiter: ${r.limiterToday}` : "",
      ].filter(Boolean).join("\n");
      const request =
        "Turn these surfaced signals into minimal, specific plan adjustments with trade-offs (don't restructure the week; smallest change that helps):\n" +
        actionable.map((f) => `- [${f.severity}] ${f.title}: ${f.detail}${f.recommendation ? ` (suggested: ${f.recommendation})` : ""}`).join("\n");
      const { result } = await proposeAdjustments(new CoachLLM(await loadSystemPrompt()), request, li.state, ctx);
      const gate = new WriteGate(new AieClient(), new DecisionLog()); // propose() never calls the API
      const proposals = [];
      for (const p of result.proposals) {
        const pr = await gate.propose({ tool: p.tool as never, args: parseArgs(p.argsJson), rationale: p.summary, tradeoff: p.tradeoff });
        proposals.push({ id: pr.id, summary: p.summary, tradeoff: p.tradeoff, tool: p.tool, argsJson: p.argsJson });
      }
      return json({ proposals, notes: result.notes });
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
    res.writeHead(500, { "content-type": "text/plain" }).end(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Endurance Coach dashboard on:`);
  for (const u of lanUrls()) console.log(`  ${u}`);
  console.log(`(open the 192.168.x.x / 10.x address on your phone — same Wi-Fi)`);
});
