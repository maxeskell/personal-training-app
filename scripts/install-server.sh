#!/usr/bin/env bash
# Run the dashboard server automatically at login and keep it alive (macOS launchd).
# Starts on boot/login, restarts if it crashes, binds the LAN so your phone can reach it.
# Usage: bash /Users/maxeskell/personal-training-app/scripts/install-server.sh [PORT]
set -euo pipefail

PORT="${1:-3000}"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
# The dashboard spawns the Garmin MCP via `uvx`, so the agent's PATH must include uv's bin dir
# (uv lives in ~/.local/bin, not the default launchd PATH) — else Garmin reads silently return null.
UVX_BIN="$(command -v uvx 2>/dev/null || true)"
UV_DIR="$([ -n "$UVX_BIN" ] && dirname "$UVX_BIN" || echo "$HOME/.local/bin")"
AGENT_PATH="$NODE_DIR:$UV_DIR:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
[ -z "$UVX_BIN" ] && echo "⚠ uvx not found on PATH — Garmin reads need it; install uv or set GARMIN_MCP_COMMAND to its absolute path."
LABEL="com.endurance-coach.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer targets macOS launchd. On Linux, use a systemd --user service running:"
  echo "  cd $PROJECT && $NPM_BIN run serve   (with COACH_HOST=0.0.0.0 COACH_PORT=$PORT)"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/reports"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NPM_BIN</string>
    <string>run</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>COACH_LAN</key><string>1</string>
    <key>COACH_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$PROJECT/reports/server.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/server.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

# Auto-reload on `git pull`: a post-merge hook restarts the agent so new code takes effect with no
# manual kickstart. (launchd serves source via tsx, so a restart = picking up the latest code.)
HOOK="$PROJECT/.git/hooks/post-merge"
if [[ -d "$PROJECT/.git/hooks" && ! -e "$HOOK" ]]; then
  cat > "$HOOK" <<HOOK_EOF
#!/bin/sh
# Restart the Endurance dashboard after a pull so it serves the latest code (installed by install-server.sh).
launchctl kickstart -k "gui/\$(id -u)/$LABEL" 2>/dev/null || pm2 restart endurance-dashboard 2>/dev/null || true
HOOK_EOF
  chmod +x "$HOOK"
  echo "Installed git post-merge hook — \`git pull\` now auto-restarts the dashboard."
elif [[ -e "$HOOK" ]]; then
  echo "Note: a git post-merge hook already exists; add this line to auto-reload on pull:"
  echo "  launchctl kickstart -k \"gui/\$(id -u)/$LABEL\" 2>/dev/null || true"
fi

printf '\nInstalled %s — the dashboard now starts at login and restarts if it stops.\n' "$LABEL"
# The server requires a one-time pairing token (gates all access, incl. AI Endurance writes).
TOKEN="$(cat "$HOME/.endurance-coach/dashboard.token" 2>/dev/null || true)"
echo "Pair this device + your phone ONCE (sets an auth cookie):"
echo "  On this Mac:  http://localhost:$PORT/pair?token=${TOKEN:-<see reports/server.log>}"
for ip in $(ipconfig getifaddr en0 2>/dev/null) $(ipconfig getifaddr en1 2>/dev/null); do
  echo "  On your phone (same Wi-Fi):  http://$ip:$PORT/pair?token=${TOKEN:-<see reports/server.log>}"
done
echo "(token lives in ~/.endurance-coach/dashboard.token; it's also printed in reports/server.log at startup.)"
echo "Logs:      $PROJECT/reports/server.log"
echo "Uninstall: bash $PROJECT/scripts/uninstall-server.sh"
