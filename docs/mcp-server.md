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

> **You do not need a tunnel, Tailscale or cloudflared** unless you specifically want **Claude Cowork**
> (Anthropic's cloud) to reach your Mac. The CLI, the dashboard, and Claude Desktop/Code all run fully
> locally with no tunnel. Tailscale/cloudflared appear below *only* to give Cowork's cloud VM a stable
> public HTTPS URL to your local server — skip sections B and C entirely if you're not using Cowork.

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
cd /path/to/personal-training-app && npm run mcp
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
      "cwd": "/path/to/personal-training-app"
    }
  }
}
```

Fully quit and reopen Desktop. If the tools don't appear, it's almost always PATH: a GUI app may not
find `npm` — run `which npm` and put the absolute path (e.g. `/opt/homebrew/bin/npm`) in `command`.
For Claude Code: `claude mcp add endurance-coach -- npm --prefix /path/to/personal-training-app run mcp`.

### B. Claude Cowork (HTTP + OAuth over an authenticated HTTPS tunnel)

Cowork runs your session in a **sandboxed cloud VM**, so it cannot spawn or reach a local stdio
server — a custom connector makes Anthropic's cloud call **out to a remote HTTPS URL**. And those
connectors authenticate via **OAuth, not a static token** — so `mcp:http` has an `oauth` mode that
runs a single-user OAuth 2.1 server (dynamic client registration + PKCE) whose **authorize step is
gated by your coach token**: Claude opens a consent page in your browser, you paste the token once,
and only then is access granted. The server still runs locally; a tunnel just gives Anthropic a
public HTTPS URL to reach it.

> ⚠️ This opens an internet-reachable path to your health data — and, unless you set
> `COACH_MCP_READONLY=true`, to the gated write tools. **Never** run the HTTP server without auth and
> a tunnel you control. Read-only is the recommended default for this remote surface.

**1. Open a tunnel first, so you know your public URL** (OAuth needs the issuer URL up front):
```bash
tailscale funnel --bg 8787      # serves 127.0.0.1:8787 publicly, in the background
tailscale funnel status         # prints your stable URL: https://<your-mac>.<tailnet>.ts.net
```
**Tailscale Funnel** is the recommended tunnel: free, no domain needed, and the URL is **stable
across reboots** — which matters because Cowork's OAuth issuer URL must not change between restarts.
(If you own a domain, a cloudflared **named tunnel** works the same way. The free cloudflared *quick*
tunnel — `cloudflared tunnel --url http://127.0.0.1:8787` — is fine for a throwaway test, but its URL
rotates on restart, which breaks the saved OAuth issuer, so don't use it for a lasting setup.)

**2. Start the server in OAuth mode, pointing it at that public URL** (read-only recommended):
```bash
cd /path/to/personal-training-app && \
  COACH_MCP_AUTH=oauth \
  COACH_MCP_PUBLIC_URL=https://<your-mac>.<tailnet>.ts.net \
  COACH_MCP_READONLY=true \
  npm run mcp:http
```
It prints the connector URL to use (`https://<your-tunnel>/mcp`) and your coach-token file location
(`~/.endurance-coach/mcp.token`, or set `COACH_MCP_TOKEN=...`).

**3. Add the connector in Cowork** → **Customize → Connectors → Add custom connector**:
- **URL:** `https://<your-mac>.<tailnet>.ts.net/mcp` (from step 2).
- **Auth:** leave it to do OAuth automatically (no client ID needed — the server supports dynamic
  registration). Click **Connect**.

**4. Approve:** Claude opens a small **"Authorize Endurance Coach"** page — paste your coach token and
submit. Cowork finishes the handshake and the tools appear.

**5. Verify:** ask Cowork *"what coach tools do you have?"* then *"what's my readiness today?"*

To stop exposing it, `Ctrl-C` the tunnel and the server — when they're down there's no remote access.
Rotate the token by deleting `~/.endurance-coach/mcp.token` (a new one is generated next start) or
setting a new `COACH_MCP_TOKEN`.

**Tokens persist across restarts.** In OAuth mode, the registered client + issued access/refresh
tokens are saved to `~/.endurance-coach/mcp-oauth.json` (0600) and reloaded on start, so a restart
(reboot, code update, `mcp:install` kickstart) does **not** force Cowork to re-authorize — your
connection just keeps working. Short-lived authorization codes are never persisted. To force a full
re-authorization, delete that file (and the access tokens it holds) and reconnect in Cowork.

### C. Always-on (no terminals to babysit)

Section B gets you connected, but you still start the server by hand each session. For a permanent,
hands-off setup, pair the stable **Tailscale Funnel** URL with the server as a **launchd service** so
both survive reboots with no terminal open.

**1. Stable URL via Tailscale Funnel** (free, no domain needed):
```bash
brew install --cask tailscale     # then open Tailscale and sign in
tailscale funnel --bg 8787        # serves localhost:8787 publicly, in the background, across reboots
tailscale funnel status           # shows your stable URL: https://<your-mac>.<tailnet>.ts.net
```
(If Tailscale says Funnel isn't enabled, follow its link to toggle it on for your tailnet once.)
Cloudflare named tunnels work too if you own a domain — same idea, stable hostname.

**2. Auto-start the server** at login (and restart on crash) pointed at that URL — stop any manual
`mcp:http` first (it holds port 8787):
```bash
cd /path/to/personal-training-app && npm run mcp:install -- https://<your-mac>.<tailnet>.ts.net
# read-only by default; append --allow-writes to also expose the gated write tools
# the installer SHOWS what it exposes (incl. your health + MEDICAL profile) and asks you to type
#   'yes' to confirm — append --yes to skip the prompt in a scripted install
npm run mcp:logs        # tail the service log
npm run mcp:uninstall   # stop auto-starting
```
It prints the Cowork connector URL (`…/mcp`) and your coach token. After a `git pull` the service
auto-restarts onto the new code. Now both the tunnel and the server survive reboots with no terminal
open — point Cowork at the stable `…/mcp` URL once and it keeps working.

> **What it exposes — shown on every start.** The server prints a banner to its log naming exactly
> what's reachable: your training data, health metrics, and your **medical** profile via `get_profile`
> (conditions, medication), plus the gated plan-write tools unless read-only. `auth=none` and
> `COACH_MCP_PROFILE_WRITE=true` get extra warning lines. It's there so the stakes are visible at the
> moment you stand the server up, not just in this doc — keep it behind your private, authenticated tunnel.

> The launchd job runs the server as a **single node process** (`node --import tsx src/mcpHttp.ts`),
> not `npm run mcp:http`. That matters: launchd's `KeepAlive` must supervise the *actual* server, not an
> `npm` wrapper — otherwise a crashed server can linger un-restarted while `npm` is still "alive".

**3. Watch it from outside** so a down tunnel or an expired token pages *you*, not Cowork. The server
answers an **unauthenticated** `GET /health` (info-only — no secrets):

| Request | Answers | Touches AI Endurance? |
| --- | --- | --- |
| `GET /health` | server + tunnel reachable? `{status, version, readOnly, authMode}` | no (instant) |
| `GET /health?deep=1` | adds `"aie": "ok" \| "reauth_needed" \| "unreachable"` | yes (bounded by `AIE_TIMEOUT_MS`) |

```bash
curl https://<your-mac>.<tailnet>.ts.net/health?deep=1     # one curl tells you which hop is broken
cd /path/to/personal-training-app && npm run health-remote                          # same probe + a macOS alert on trouble
cd /path/to/personal-training-app && npm run healthcheck:install -- https://<your-mac>.<tailnet>.ts.net   # every 20 min
npm run healthcheck:uninstall   # stop watching
```

`health-remote` reads `COACH_MCP_PUBLIC_URL` (the installer bakes it into the launchd job). It exercises
the **same path Cowork uses** (tunnel → server → AIE), so it catches what local `doctor` can't: a dropped
Funnel or a wedged server. The `aie` field separates *"the connector is unreachable"* from *"AI Endurance
just needs re-auth"* — the distinction that otherwise looks like the whole connector died.

> **Re-auth never hangs.** Only `npm run auth:aie` opens a browser. The server/cron/Cowork run
> non-interactively: an expired token returns a fast, clean `run npm run auth:aie` error (and `/health`
> reports `aie: reauth_needed`) instead of blocking on a browser that can't appear.

## Tools

Read/analysis tools are deterministic and make **no LLM call**. LLM tools need `ANTHROPIC_API_KEY`
in `.env`; if it's absent they return a clean message instead of failing. Writes are gated.

### Reads (no token cost)
- **`sync`** — assemble today's `AthleteState` fresh from AI Endurance (+ Garmin if enabled) and
  persist it. Returns a provenance-tagged summary + any sync gaps.
- **`get_state`** `{ fresh?: boolean }` — return today's state. Reads the last persisted snapshot by
  default; `fresh=true` re-syncs first.
- **`get_profile`** — the validated athlete profile (stable context: identity, biomechanics,
  health/medication, availability, equipment, fuelling, race targets) plus a computed `dose_cycle`
  (`days_since_dose`, `in_gi_trough`) when a medication cycle is set. **No live numbers** — FTP, weight,
  paces, swim CSS, HRV and load come from `get_state`. Reads `profile.local.yaml`, else the committed
  `profile.example.yaml`. Deterministic — no LLM cost. See [docs/profile.md](profile.md).
- **`update_profile`** `{ patch }` — **write** the athlete profile by talking to Claude. `patch` is a
  partial profile object (same shape as `get_profile`); it's **deep-merged** onto your current profile
  (nested objects merged, arrays/scalars replaced), **validated**, then written to the gitignored
  `profile.local.yaml`. The no-live-numbers guard rejects FTP/weight/HRV/CSS/pace/load, so they can
  never be written. **Gating:** always available to **local** Claude Desktop/Code (stdio); on the
  **HTTP/Cowork** surface it's **off unless `COACH_MCP_PROFILE_WRITE=true`** (it writes a file on your
  Mac from a remote session). Writes a local file only — never AI Endurance.
- **`insights`** — run the insight engine over your history (CTL/ATL/TSB & ramp, EF, durability,
  run-load, autocorr-aware correlations, change-points, taper target, validated monitoring rules)
  and return the computed metrics + top surfaced findings. Each top finding is annotated with its
  **`key`, age (NEW / Nd old) and your saved reaction**, so you know what's fresh and can react by key.
- **`react_to_insight`** `{ key, reaction: like|dislike|snooze|clear, summary? }` — record your reaction
  to a surfaced insight, full parity with the dashboard buttons (like/dislike persist and are reversible,
  dislike stays visible but down-ranks, snooze hides ~2 weeks, clear removes a prior opinion). It writes
  only to the **local decision log** — not AI Endurance — so it stays available even on the **read-only
  Cowork surface**.
- **`listening`** — your engagement model: which insight families you act on vs dismiss, gated-proposal
  accept/decline, what's snoozed, findings that recurred after a snooze, plan **adherence** (done vs
  planned, deferring to AI Endurance) and **plan changes** (added/moved/dropped). Deterministic, no LLM.
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
- **`tune`** — weekly marginal gains: the smaller, easy-to-action tweaks (efficiency, durability,
  fuelling, pacing, biomechanics), not "train more". Also writes a dated report.
- **`research`** — monthly web-grounded digest: searches recent training/triathlon/gear thinking against
  your knowledge layer and **drafts** a proposed prior update into `knowledge/pending/`. Review-gated —
  nothing is applied until you approve it from the CLI (`npm run knowledge -- approve <file>`). Uses the
  model's web search (best-effort, cost-logged).
- **`knowledge`** *(read)* — knowledge-layer freshness (last-verified + stale flag) and digests awaiting
  review. Approving is a deliberate CLI action, never the agent's.
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
| `COACH_MCP_AUTH` | `token` | `token` (bearer header) · `oauth` (for Cowork) · `none` (tunnel-only) |
| `COACH_MCP_PUBLIC_URL` | — | **required for `oauth`**: the public HTTPS tunnel URL (the OAuth issuer) |
| `COACH_MCP_HOST` | `127.0.0.1` | interface to bind (keep localhost; the tunnel reaches it) |
| `COACH_MCP_PORT` | `8787` | local port for the HTTP listener |
| `COACH_MCP_TOKEN` | _(generated)_ | the secret; `token` mode → bearer header, `oauth` mode → typed into the consent page. If unset, a random one is written to `<secretsDir>/mcp.token` (0600) |
| `COACH_MCP_READONLY` | `false` | `true` drops the gated AI Endurance write tools from the HTTP surface |
| `COACH_MCP_PROFILE_WRITE` | `false` | `true` exposes the local-file `update_profile` tool on the HTTP/Cowork surface (always on for local stdio) |

The same `npm run doctor` health check covers the rest.

## Hardening (the OAuth/HTTP surface)

Because OAuth mode is internet-reachable, the surface is defended in depth:

- **The consent endpoint is rate-limited** (10 attempts / 15 min / IP) and logs rejected attempts —
  the coach token can't be brute-forced unobserved. Set a long `COACH_MCP_TOKEN` (or let it
  auto-generate 48 hex chars); the server **refuses to start** with a token under 16 chars.
- **Issued tokens are audience-bound** to this server's `/mcp` resource and **must carry the `coach`
  scope** — a token can't be replayed against a different resource, and `/mcp` rejects scope-less tokens.
- **Dynamic client registration refuses non-HTTPS / non-loopback redirect URIs**, narrowing the
  phishing surface. The client/token stores are **bounded and swept** (codes expire in 5 min, access
  tokens 1 h, refresh tokens 30 days), so a long-running service can't be grown without limit. Clients
  + tokens are persisted (0600) so a connection survives a restart; auth codes are never persisted.
- **`auth=none` refuses to bind a non-loopback host** — it can only ever serve on `127.0.0.1`, so a
  misconfiguration can't silently expose the tools unauthenticated.

To turn the surface off entirely, stop the tunnel and the server (`npm run mcp:uninstall` if you
installed the service). The local **stdio** mode (Desktop/Code) has none of this exposure and is the
recommended default when Cowork isn't required.
