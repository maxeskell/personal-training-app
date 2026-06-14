# MCP server — interrogate your data from Claude

`npm run mcp` runs a **local MCP server over stdio** that exposes the endurance coach as tools, so a
desktop agent — **Claude Cowork** or **Claude Desktop** — can interrogate your training data in
natural language. It is a thin adapter over the *same engine* the CLI (`src/cli.ts`) and the
dashboard server (`src/server.ts`) already use: the assembled `AthleteState`, the n=1 insight
engine, the coaching flows, and the gated propose→confirm write path. One engine, three faces — so
the answers Claude gives match the CLI and dashboard exactly.

> This is the "full local dataset" route. A remote AI Endurance connector wired straight into Claude
> only sees what AI Endurance exposes; this server runs on your Mac, so it *also* reaches your Garmin
> gap-metrics, the backfilled archive, and the locally-computed insight engine.

## Why local (the privacy posture)

The server speaks MCP on **stdio** and is launched by the agent as a child process on your machine.
Your AI Endurance OAuth tokens (`~/.endurance-coach`), Garmin creds (`~/.garminconnect`) and the
`data/` archive **never leave the Mac** — there is no network listener and no cloud connector. The
only outbound calls are the ones the coach already makes: AI Endurance (your data spine), Garmin (if
enabled), and the Anthropic API for the LLM tools (the same calls `npm run ask` / `weekly` make,
cost-logged to `data/cost-log.jsonl`).

## Run it

```bash
cd /Users/maxeskell/personal-training-app && npm run mcp
```

It prints a readiness banner to **stderr** (stdout is the MCP protocol channel) and then waits for a
client. `Ctrl-C` to stop. You normally don't run it by hand — you point an agent at the command.

### Wire it into Claude Cowork / Claude Desktop

In **Customize → Connectors → Add a local / custom MCP server**, configure a stdio server:

| Field | Value |
| --- | --- |
| command | `npm` |
| args | `run mcp` |
| working directory | `/Users/maxeskell/personal-training-app` |

(Equivalently, a `claude_desktop_config.json` entry:)

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
autonomous write. An agent can *draft* a change, but only an explicit `confirm` call applies it.

## No new configuration

The server reuses the existing config and secrets — there are **no new environment variables**. See
`.env.example` for everything that's already wired (AI Endurance, optional Garmin, the API key, cost
rates). The same `npm run doctor` health check covers it.
