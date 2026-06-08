import { createServer } from "node:http";
import { networkInterfaces } from "node:os";
import { AieClient } from "./mcp/aieClient.js";
import { GarminClient } from "./mcp/garminClient.js";
import { StateStore } from "./state/store.js";
import { assembleState } from "./state/assemble.js";
import { DecisionLog } from "./state/decisionLog.js";
import { renderDashboard } from "./coach/dashboard.js";
import { buildInsights } from "./insights/engine.js";
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
  const decisions = await new DecisionLog().all();
  const insights = latest.raw ? buildInsights(latest) : undefined;
  return renderDashboard({ window, decisions, insights });
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

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
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
