#!/usr/bin/env bash
# Post-swim deep dive: refresh recent .FIT summaries (fit-sync) so today's swim is actually in the
# archive, then run the gated `post-swim` — which writes a deep-dive report ONLY if a swim landed today
# and today's dive isn't already written. Quiet and free on every other day, so a daily timer is fine.
# Installs a launchd agent that runs once a day at HH:MM (default 19:00 — after the evening pool session).
# Usage: bash /Users/maxeskell/dev/personal-training-app/scripts/install-post-swim.sh [HH] [MM]
set -euo pipefail

HH="${1:-19}"
MM="${2:-0}"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
# fit-sync spawns the Garmin MCP via `uvx` — include uv's bin dir on PATH (not in launchd's default PATH).
UVX_BIN="$(command -v uvx 2>/dev/null || true)"
UV_DIR="$([ -n "$UVX_BIN" ] && dirname "$UVX_BIN" || echo "$HOME/.local/bin")"
AGENT_PATH="$NODE_DIR:$UV_DIR:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.endurance-coach.post-swim"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only. On Linux, add a daily cron entry running:"
  echo "  cd $PROJECT && $NPM_BIN run fit-sync >> reports/post-swim.log 2>&1 ; $NPM_BIN run post-swim >> reports/post-swim.log 2>&1"
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
    <string>/bin/bash</string><string>-lc</string>
    <string>cd "$PROJECT" && "$NPM_BIN" run fit-sync ; "$NPM_BIN" run post-swim</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$AGENT_PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HH</integer><key>Minute</key><integer>$MM</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$PROJECT/reports/post-swim.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/post-swim.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — daily at %02d:%02d: fit-sync, then a deep dive only if you swam today.\n' "$LABEL" "$HH" "$MM"
echo "Log: tail -f $PROJECT/reports/post-swim.log    |   Uninstall: npm run post-swim:uninstall"
