#!/usr/bin/env bash
# Proactive daily watch: refresh recent .FIT summaries (fit-sync) then run the fire-only `check`,
# which sends a macOS notification ONLY if a flag / health early-warning fires. Quiet otherwise.
# Installs a launchd agent that runs once a day at HH:MM (default 07:30).
# Usage: bash /Users/maxeskell/personal-training-app/scripts/install-watch.sh [HH] [MM]
set -euo pipefail

HH="${1:-7}"
MM="${2:-30}"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
LABEL="com.endurance-coach.watch"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only. On Linux, add a daily cron entry running:"
  echo "  cd $PROJECT && $NPM_BIN run fit-sync >> reports/watch.log 2>&1 ; $NPM_BIN run check >> reports/watch.log 2>&1"
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
    <string>cd "$PROJECT" && "$NPM_BIN" run fit-sync ; "$NPM_BIN" run check</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$HH</integer><key>Minute</key><integer>$MM</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$PROJECT/reports/watch.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/watch.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — daily at %02d:%02d: fit-sync then a fire-only check (notifies only if something fires).\n' "$LABEL" "$HH" "$MM"
echo "Log: tail -f $PROJECT/reports/watch.log    |   Uninstall: npm run watch:uninstall"
