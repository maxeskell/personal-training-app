#!/usr/bin/env bash
# Stop the auto-start dashboard server and remove its launchd agent.
set -euo pipefail
LABEL="com.endurance-coach.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Not macOS — remove your systemd --user service manually."
  exit 0
fi
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL — the dashboard no longer auto-starts."
