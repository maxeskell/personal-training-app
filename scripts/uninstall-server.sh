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

# Remove the auto-reload post-merge hook if it's the one we installed.
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$PROJECT/.git/hooks/post-merge"
if [[ -e "$HOOK" ]] && grep -q "$LABEL" "$HOOK" 2>/dev/null; then
  rm -f "$HOOK"
  echo "Removed the auto-reload git post-merge hook."
fi

echo "Removed $LABEL — the dashboard no longer auto-starts."
