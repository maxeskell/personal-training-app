#!/usr/bin/env bash
# Stop the Sunday week-in-review release job (the morning ping still catches up a missing week Mon–Wed).
set -euo pipefail
LABEL="com.endurance-coach.weekly-brief"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[[ "$(uname)" != "Darwin" ]] && { echo "Not macOS — remove your cron entry manually."; exit 0; }
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL — Sunday week-in-review release stopped."
