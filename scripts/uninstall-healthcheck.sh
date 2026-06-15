#!/usr/bin/env bash
# Stop the scheduled remote health check.
set -euo pipefail
LABEL="com.endurance-coach.healthcheck"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[[ "$(uname)" != "Darwin" ]] && { echo "Not macOS — remove your cron entry manually."; exit 0; }
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL — remote health check stopped."
