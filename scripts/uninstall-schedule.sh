#!/usr/bin/env bash
# Remove the morning readiness ping launchd agent.
set -euo pipefail
LABEL="com.endurance-coach.morning"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Not macOS — remove the cron entry you added manually."
  exit 0
fi
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL."
