#!/usr/bin/env bash
# Install the unattended morning readiness ping as a macOS launchd agent.
# Usage: bash scripts/install-schedule.sh [HOUR] [MINUTE]   (defaults 06:00)
set -euo pipefail

HOUR="${1:-6}"
MINUTE="${2:-0}"

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
LABEL="com.endurance-coach.morning"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer targets macOS launchd. On Linux, add a cron entry:"
  echo "  $MINUTE $HOUR * * *  cd $PROJECT && $NPM_BIN run ping >> $PROJECT/reports/ping.log 2>&1"
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
    <string>ping</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <key>StandardOutPath</key><string>$PROJECT/reports/ping.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/ping.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — runs `npm run ping` daily at %02d:%02d.\n' "$LABEL" "$HOUR" "$MINUTE"
echo "Logs: $PROJECT/reports/ping.log"
echo "Reads ANTHROPIC_API_KEY + Garmin/AIE creds from the project .env / ~/.endurance-coach / ~/.garminconnect."
echo "Uninstall: bash scripts/uninstall-schedule.sh"
