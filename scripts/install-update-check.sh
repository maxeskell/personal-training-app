#!/usr/bin/env bash
# Install the weekly "is everything current?" check as a macOS launchd agent (dependency drift +
# integration health — see check-updates.sh). It only REPORTS; it never upgrades anything for you.
# Usage: bash scripts/install-update-check.sh [WEEKDAY] [HOUR] [MINUTE]   (defaults Mon 09:00)
#   WEEKDAY: 0/7=Sun, 1=Mon … 6=Sat.
set -euo pipefail

WEEKDAY="${1:-1}"
HOUR="${2:-9}"
MINUTE="${3:-0}"

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
AGENT_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.endurance-coach.update-check"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer targets macOS launchd. On Linux, add a cron entry (e.g. Mondays 09:00):"
  echo "  $MINUTE $HOUR * * $WEEKDAY  cd $PROJECT && $NPM_BIN run check:updates >> $PROJECT/reports/update-check.log 2>&1"
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
    <string>$NPM_BIN</string><string>run</string><string>check:updates</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Weekday</key><integer>$WEEKDAY</integer>
    <key>Hour</key><integer>$HOUR</integer>
    <key>Minute</key><integer>$MINUTE</integer>
  </dict>
  <!-- Separate run-log: check-updates.sh already appends the structured report to update-check.log itself,
       so capturing the agent's stdout/stderr to a DIFFERENT file avoids logging each scheduled run twice. -->
  <key>StandardOutPath</key><string>$PROJECT/reports/update-check.launchd.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/update-check.launchd.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — runs `npm run check:updates` weekly (weekday %s at %02d:%02d).\n' "$LABEL" "$WEEKDAY" "$HOUR" "$MINUTE"
echo "Report log: $PROJECT/reports/update-check.log (durable check history)"
echo "Run log:    $PROJECT/reports/update-check.launchd.log (this agent's stdout/stderr)"
echo "Test now:   cd $PROJECT && npm run check:updates"
echo "Uninstall:  bash $PROJECT/scripts/uninstall-update-check.sh"
