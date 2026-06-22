#!/usr/bin/env bash
# Stop the scheduled activity-archive auto-heal.
set -euo pipefail
LABEL="com.endurance-coach.archive-heal"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[[ "$(uname)" != "Darwin" ]] && { echo "Not macOS — remove your cron entry manually."; exit 0; }
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL — archive auto-heal stopped."
