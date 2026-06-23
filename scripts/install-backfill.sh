#!/usr/bin/env bash
# Grind the full Garmin daily-metrics history (a decade) in the background, a chunk at a time.
# Installs a launchd agent that runs `npm run backfill -- --daily-only --chunk N` every INTERVAL
# seconds. Resumable: each run fetches the next N un-archived days, then exits. Over days it
# completes the decade without one fragile multi-hour process. Uninstall when the archive is full.
# Usage: bash /Users/maxeskell/dev/personal-training-app/scripts/install-backfill.sh [CHUNK] [INTERVAL_SEC]
set -euo pipefail

CHUNK="${1:-200}"
INTERVAL="${2:-1800}"   # 30 min between runs (gentle on Garmin's rate limits)
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
# Backfill spawns the Garmin MCP via `uvx` — include uv's bin dir on PATH (not in default launchd PATH).
UVX_BIN="$(command -v uvx 2>/dev/null || true)"
UV_DIR="$([ -n "$UVX_BIN" ] && dirname "$UVX_BIN" || echo "$HOME/.local/bin")"
AGENT_PATH="$NODE_DIR:$UV_DIR:$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.endurance-coach.backfill"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only. On Linux, add a cron entry running:  cd $PROJECT && $NPM_BIN run backfill -- --daily-only --chunk $CHUNK"
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
    <string>$NPM_BIN</string><string>run</string><string>backfill</string>
    <string>--</string><string>--daily-only</string><string>--chunk</string><string>$CHUNK</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$AGENT_PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJECT/reports/backfill.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/backfill.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — grinds ~%s Garmin days every %s min, resumable.\n' "$LABEL" "$CHUNK" "$((INTERVAL/60))"
echo "Progress: cd $PROJECT && npm run backfill:status   (or tail $PROJECT/reports/backfill.log)"
echo "Stop when the archive is complete: bash $PROJECT/scripts/uninstall-backfill.sh"
