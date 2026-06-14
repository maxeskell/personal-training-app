#!/usr/bin/env bash
# Stop the auto-start MCP server and remove its launchd agent.
set -euo pipefail
LABEL="com.endurance-coach.mcp"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
if [[ "$(uname)" != "Darwin" ]]; then
  echo "Not macOS — remove your systemd --user service manually."
  exit 0
fi
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

# Remove just our restart line from the (possibly shared) post-merge hook; drop the hook if only the
# shebang remains.
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOOK="$PROJECT/.git/hooks/post-merge"
if [[ -e "$HOOK" ]] && grep -q "$LABEL" "$HOOK" 2>/dev/null; then
  grep -v "$LABEL" "$HOOK" > "$HOOK.tmp" && mv "$HOOK.tmp" "$HOOK"
  chmod +x "$HOOK"
  if [[ "$(grep -vcE '^#!|^[[:space:]]*$' "$HOOK")" == "0" ]]; then rm -f "$HOOK"; fi
  echo "Removed the MCP restart from the git post-merge hook."
fi

echo "Removed $LABEL — the MCP server no longer auto-starts."
echo "(Your Tailscale Funnel, if any, is separate — stop it with: tailscale funnel --bg off 8787)"
