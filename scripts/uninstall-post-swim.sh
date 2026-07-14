#!/usr/bin/env bash
# Stop the scheduled post-swim deep dive (fit-sync + gated deep dive).
set -euo pipefail
LABEL="com.endurance-coach.post-swim"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[[ "$(uname)" != "Darwin" ]] && { echo "Not macOS — remove your cron entry manually."; exit 0; }
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL — post-swim deep dive stopped."
