# MCP server — interrogate your data from Claude

This exposes the endurance coach as MCP tools, so a Claude client can interrogate your training data
in natural language. It is a thin adapter over the *same engine* the CLI (`src/cli.ts`) and the
dashboard server (`src/server.ts`) already use: the assembled `AthleteState`, the n=1 insight
engine, the coaching flows, and the gated propose→confirm write path. One engine, many faces — so
the answers Claude gives match the CLI and dashboard exactly.

**Two transports, because clients differ:**

| Transport | Command | Use it from | Exposure |
| --- | --- | --- | --- |
| **stdio** | `npm run mcp` | **Claude Desktop**, **Claude Code** (local — they spawn the process) | none (no port) |
| **HTTP** | `npm run mcp:http` | **Claude Cowork** (its sandboxed cloud VM can't reach a local process — it needs a remote URL) | localhost + an **authenticated HTTPS tunnel** |

Pick stdio if Desktop/Code is fine — it's zero-exposure and the simplest. Use HTTP only when it has
to be **Cowork**, and only behind the bearer token + tunnel described below.

> This is the "full local dataset" route. A remote AI Endurance connector wired straight into Claude
> only sees what AI Endurance exposes; this server runs on your Mac, so it *also* reaches your Garmin
> gap-metrics, the backfilled archive, and the locally-computed insight engine.

## Why local (the privacy posture)

The server speaks MCP on **stdio** and is launched by the agent as a child process on your machine.
Your AI Endurance OAuth tokens (`~/.endurance-coach`), Garmin creds (`~/.garminconnect`) and the
`data/` archive **never leave the Mac**: the computation runs locally either way. In **stdio** mode
there is no network listener at all. In **HTTP** mode there is a localhost listener that is reachable
only with the bearer token, and only from the internet if you choose to point a tunnel at it — the
data is still assembled on the Mac and only the answers flow back through your own tunnel. The only
outbound calls are the ones the coach already makes: AI Endurance (your data spine), Garmin (if
enabled), and the Anthropic API for the LLM tools (the same calls `npm run ask` / `weekly` make,
cost-logged to `data/cost-log.jsonl`).

## Run it

```bash
cd /Users/maxeskell/personal-training-app && npm run mcp
```

It prints a readiness banner to **stderr** (stdout is the MCP protocol channel) and then waits for a
client. `Ctrl-C` to stop. You normally don't run it by hand — you point an agent at the command.

### A. Claude Desktop / Claude Code (stdio — recommended, no exposure)

Add it to `claude_desktop_config.json` (Desktop → Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "endurance-coach": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/Users/maxeskell/personal-training-app"
    }
  }
}
```

Fully quit and reopen Desktop. If the tools don't appear, it's almost always PATH: a GUI app may not
find `npm` — run `which npm` and put the absolute path (e.g. `/opt/homebrew/bin/npm`) in `command`.
For Claude Code: `claude mcp add endurance-coach -- npm --prefix /Users/maxeskell/personal-training-app run mcp`.

### B. Claude Cowork (HTTP over an authenticated HTTPS tunnel)

Cowork runs your session in a **sandboxed cloud VM**, so it cannot spawn or reach a local stdio
server — a custom connector makes Anthropic's cloud call **out to a remote HTTPS URL**. So the coach
has to be served over HTTP and exposed on a public, *authenticated* HTTPS endpoint. Keep it private
with the built-in **bearer token** plus a tunnel that points at localhost (the data stays on the Mac).

> ⚠️ This opens an internet-reachable path to your health data — and, unless you set
> `COACH_MCP_READONLY=true`, to the gated write tools. **Never** run `mcp:http` without the token and
> a tunnel you control. Read-only is the safer default for a remote surface.

**1. Start the HTTP server (read-only is recommended for the remote surface):**
```bash
cd /Users/maxeskell/personal-training-app && COACH_MCP_READONLY=true npm run mcp:http
```
On first run it prints the bearer token's location: `~/.endurance-coach/mcp.token` (or set
`COACH_MCP_TOKEN=...` yourself). It binds to `127.0.0.1:8787` (override with `COACH_MCP_PORT` / `COACH_MCP_HOST`).

**2. Open an HTTPS tunnel to it.** Either:
- **cloudflared:** `cloudflared tunnel --url http://127.0.0.1:8787` → prints a `https://<random>.trycloudflare.com` URL. (For a stable URL, set up a named tunnel on your own domain.)
- **Tailscale Funnel:** `tailscale funnel 8787` → a `https://<machine>.<tailnet>.ts.net` URL.

**3. Add the connector in Cowork** → **Customize → Connectors → Add custom connector**:
- **URL:** the tunnel's HTTPS URL from step 2.
- **Auth:** set the request header `Authorization: Bearer <token>` (the token from step 1) in the connector's advanced/header settings.

**4. Verify:** ask Cowork *"what coach tools do you have?"* then *"what's my readiness today?"*

To stop exposing it, `Ctrl-C` the tunnel and the `mcp:http` process — when they're down there's no
remote access. Rotate the token by deleting `~/.endurance-coach/mcp.token` (a new one is generated on
next start) or setting a new `COACH_MCP_TOKEN`.

Then ask in plain language: *"what does my endurance coach say about my readiness today?"*,
*"how were my long rides this month?"*, *"run a deep dive."*

## Tools

Read/analysis tools are deterministic and make **no LLM call**. LLM tools need `ANTHROPIC_API_KEY`
in `.env`; if it's absent they return a clean message instead of failing. Writes are gated.

### Reads (no token cost)
- **`sync`** — assemble today's `AthleteState` fresh from AI Endurance (+ Garmin if enabled) and
  persist it. Returns a provenance-tagged summary + any sync gaps.
- **`get_state`** `{ fresh?: boolean }` — return today's state. Reads the last persisted snapshot by
  default; `fresh=true` re-syncs first.
- **`insights`** — run the insight engine over your history (CTL/ATL/TSB & ramp, EF, durability,
  run-load, autocorr-aware correlations, change-points, taper target, validated monitoring rules)
  and return the computed metrics + top surfaced findings.
- **`list_reports`** / **`read_report`** `{ name }` — list and read the dated markdown reports under
  `reports/`. `read_report` only accepts a bare `*.md` file name (path-traversal guarded).
- **`decisions`** `{ filter?: "all" | "pending" }` — the decision-log audit trail; `pending` shows
  only plan proposals awaiting confirm/decline.
- **`cost`** `{ days?: number }` — local token-cost report (today / 7d / 30d / all-time, or a custom
  window) with a monthly projection.

### LLM flows (need `ANTHROPIC_API_KEY`; every call is cost-logged)
- **`ask`** `{ question }` — free-form Q&A over your assembled state + insights (same engine as the
  dashboard "Ask your data" box).
- **`readiness`** — green/amber/red verdict with cited drivers + a wellbeing check (logs to the
  decision log).
- **`weekly`** / **`race_prep`** `{ race? }` / **`deep_dive`** — the review flows; each also writes
  its dated report under `reports/`.
- **`session_feedback`** `{ date?, force? }` — deep feedback on one session. Needs the raw `.FIT` for
  biomechanics; `force=true` gives summary-only feedback.

### Gated writes — the only path that mutates AI Endurance
- **`propose_adjustment`** `{ request }` — turn a request (e.g. *"move my long run off race week"*)
  into validated proposals. **Writes nothing**: each proposal is logged with its trade-off and an id.
- **`confirm`** `{ id }` — the **only** tool that writes to AI Endurance, and only for a logged,
  un-consumed proposal. Single-use; refuses anything not in a confirmable state.
- **`decline`** `{ id }` — dismiss a pending proposal (no API call).

This is the same `WriteGate` two-step the CLI uses (`src/guardrails/writeGate.ts`): there is no
autonomous write. An agent can *draft* a change, but only an explicit `confirm` call applies it. On
the **HTTP** surface these three tools are dropped entirely when `COACH_MCP_READONLY=true` — the
recommended setting for anything reachable over a tunnel.

## Configuration

**stdio** mode needs no configuration — it reuses the existing config and secrets (AI Endurance,
optional Garmin, `ANTHROPIC_API_KEY` for the LLM tools). **HTTP** mode adds a few optional vars
(all documented in `.env.example`):

| Var | Default | Meaning |
| --- | --- | --- |
| `COACH_MCP_HOST` | `127.0.0.1` | interface to bind (keep localhost; the tunnel reaches it) |
| `COACH_MCP_PORT` | `8787` | local port for the HTTP listener |
| `COACH_MCP_TOKEN` | _(generated)_ | bearer token; if unset, a random one is written to `<secretsDir>/mcp.token` (0600) |
| `COACH_MCP_READONLY` | `false` | `true` drops the gated write tools from the HTTP surface |

The same `npm run doctor` health check covers the rest.
