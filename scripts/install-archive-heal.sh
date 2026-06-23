#!/usr/bin/env bash
# PERMANENT auto-heal for the durable activity archive (data/activity-archive/). Installs a launchd agent
# that runs `npm run archive:heal -- --chunk N` every INTERVAL seconds: it incrementally refreshes the
# Garmin activity list and pulls the raw .FIT for anything not yet archived. Cheap in steady state (the
# forward sync hook already archives new activities); after any gap/outage it quietly refills over a few
# runs. Unlike the finite daily-metrics backfill grind, LEAVE THIS RUNNING — gaps can always happen.
# Usage: bash /Users/maxeskell/dev/personal-training-app/scripts/install-archive-heal.sh [CHUNK] [INTERVAL_SEC]
set -euo pipefail

CHUNK="${1:-200}"
INTERVAL="${2:-21600}"   # every 6h (the forward hook handles real-time; this is the safety net)
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
# archive:heal spawns the Garmin MCP via `uvx` — include uv's bin dir on PATH (not in default launchd PATH).
UVX_BIN="$(command -v uvx 2>/dev/null || true)"
UV_DIR="$([ -n "$UVX_BIN" ] && dirname "$UVX_BIN" || echo "$HOME/.local/bin")"
AGENT_PATH="$NODE_DIR:$UV_DIR:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.endurance-coach.archive-heal"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only. On Linux, add a cron entry running:  cd $PROJECT && $NPM_BIN run archive:heal -- --chunk $CHUNK"
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
    <string>$NPM_BIN</string><string>run</string><string>archive:heal</string>
    <string>--</string><string>--chunk</string><string>$CHUNK</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$AGENT_PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJECT/reports/archive-heal.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/archive-heal.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — auto-heals the activity archive (≤%s files/run) every %s h.\n' "$LABEL" "$CHUNK" "$((INTERVAL/3600))"
echo "Status: cd $PROJECT && npm run archive:import   (or tail $PROJECT/reports/archive-heal.log)"
echo "Stop: bash $PROJECT/scripts/uninstall-archive-heal.sh"
