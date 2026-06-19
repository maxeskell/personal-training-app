#!/usr/bin/env bash
# Run the coach MCP HTTP server (OAuth mode, for Claude Cowork) automatically at login and keep it
# alive (macOS launchd). Starts at login, restarts if it crashes — no terminal to babysit. Pair it
# with a stable tunnel (Tailscale Funnel / a Cloudflare named tunnel) whose public URL you pass here.
# Usage: bash /Users/maxeskell/personal-training-app/scripts/install-mcp.sh <PUBLIC_HTTPS_URL> [--allow-writes]
set -euo pipefail

PUBLIC_URL="${1:-}"
READONLY="true"
ASSUME_YES="false"
[[ $# -gt 0 ]] && shift
for arg in "$@"; do
  case "$arg" in
    --allow-writes) READONLY="false" ;;
    --yes|-y) ASSUME_YES="true" ;;
  esac
done

if [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" != https://* ]]; then
  echo "Usage: bash scripts/install-mcp.sh <PUBLIC_HTTPS_URL> [--allow-writes] [--yes]"
  echo "  <PUBLIC_HTTPS_URL>  your STABLE tunnel URL, e.g. https://your-mac.tailXXXX.ts.net"
  echo "                      (Cowork connects to <PUBLIC_HTTPS_URL>/mcp)"
  echo "  --allow-writes      also expose the gated write tools (default: read-only — recommended)"
  echo "  --yes               skip the 'this exposes your health/medical data' confirmation prompt"
  exit 1
fi

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_BIN="$(command -v node)"
NODE_DIR="$(dirname "$NODE_BIN")"
# The server may spawn the Garmin MCP via `uvx`, so the agent's PATH must include uv's bin dir.
UVX_BIN="$(command -v uvx 2>/dev/null || true)"
UV_DIR="$([ -n "$UVX_BIN" ] && dirname "$UVX_BIN" || echo "$HOME/.local/bin")"
AGENT_PATH="$NODE_DIR:$UV_DIR:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.endurance-coach.mcp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer targets macOS launchd. On Linux, run as a systemd --user service:"
  echo "  cd $PROJECT && COACH_MCP_AUTH=oauth COACH_MCP_PUBLIC_URL=$PUBLIC_URL COACH_MCP_READONLY=$READONLY $NPM_BIN run mcp:http"
  exit 0
fi

# --- Security confirmation: this stands up a server that exposes health + MEDICAL data ---
cat <<WARN

  ┌─ Before you install: what this exposes ───────────────────────────────────┐
  An always-on server lets a Claude client reach, over your tunnel
  ($PUBLIC_URL), these about YOU:
    • training data + health metrics (HRV, resting HR, sleep, VO2max)
    • your MEDICAL profile via get_profile — conditions and medication
    • $([ "$READONLY" = true ] && echo 'plan writes are OFF (read-only — recommended)' || echo 'the gated plan-WRITE tools (you passed --allow-writes)')
  It is OAuth-gated by your coach token and MUST sit behind a PRIVATE tunnel you
  control (Tailscale Funnel). Anyone with that URL + token can read the above.
  └───────────────────────────────────────────────────────────────────────────┘

WARN
if [[ "$ASSUME_YES" != "true" ]]; then
  if [[ ! -t 0 ]]; then
    echo "Refusing to install non-interactively. Re-run with --yes once you've read the above." >&2
    exit 1
  fi
  read -r -p "Type 'yes' to install this internet-reachable server: " CONFIRM
  if [[ "$CONFIRM" != "yes" ]]; then
    echo "Aborted — nothing installed."
    exit 1
  fi
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/reports"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <!-- Run node directly with tsx's in-process loader, NOT 'npm run mcp:http': launchd's KeepAlive must
       supervise the ACTUAL server process. Going through npm makes launchd watch the npm wrapper, so a
       crashed node child can linger un-restarted. 'node --import tsx' is a single process (tsx >= 4.7). -->
  <array>
    <string>$NODE_BIN</string>
    <string>--import</string>
    <string>tsx</string>
    <string>src/mcpHttp.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>COACH_MCP_AUTH</key><string>oauth</string>
    <key>COACH_MCP_PUBLIC_URL</key><string>$PUBLIC_URL</string>
    <key>COACH_MCP_READONLY</key><string>$READONLY</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$PROJECT/reports/mcp.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/mcp.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# Auto-reload on `git pull`: append our restart to the post-merge hook (shared with the dashboard's).
HOOK="$PROJECT/.git/hooks/post-merge"
KICK="launchctl kickstart -k \"gui/\$(id -u)/$LABEL\" 2>/dev/null || true"
if [[ -d "$PROJECT/.git/hooks" ]]; then
  if [[ ! -e "$HOOK" ]]; then
    printf '#!/bin/sh\n%s\n' "$KICK" > "$HOOK"
    chmod +x "$HOOK"
    echo "Installed git post-merge hook — \`git pull\` now auto-restarts the MCP server."
  elif ! grep -q "$LABEL" "$HOOK" 2>/dev/null; then
    printf '%s\n' "$KICK" >> "$HOOK"
    echo "Added MCP restart to the existing git post-merge hook."
  fi
fi

printf '\nInstalled %s — the MCP server now starts at login (OAuth mode, %s) and restarts if it stops.\n' \
  "$LABEL" "$([ "$READONLY" = true ] && echo 'read-only' || echo 'WRITES ENABLED')"
echo "Cowork connector URL:  ${PUBLIC_URL%/}/mcp"
echo "Coach token (consent page):  $(cat "$HOME/.endurance-coach/mcp.token" 2>/dev/null || echo '<see reports/mcp.log>')"
echo "Logs:      $PROJECT/reports/mcp.log   (npm run mcp:logs)"
echo "Uninstall: bash $PROJECT/scripts/uninstall-mcp.sh"
echo
echo "NOTE: stop any manually-running 'npm run mcp:http' first (it holds port 8787, else this service"
echo "      will crash-loop on EADDRINUSE until it's freed)."
echo "NOTE: this only works while your tunnel is up. For an always-on stable URL, run Tailscale Funnel"
echo "      in the background (see docs/mcp-server.md):  tailscale funnel --bg 8787"
