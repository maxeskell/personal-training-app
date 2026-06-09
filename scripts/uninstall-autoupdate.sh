#!/usr/bin/env bash
# Stop the auto-update timer (the code will no longer pull/restart on its own).
set -euo pipefail
LABEL="com.endurance-coach.autoupdate"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Not macOS — remove your systemd timer / cron entry for scripts/autoupdate.sh manually."
  exit 0
fi
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed $LABEL — auto-update is off. (Pull manually with: npm run update)"
