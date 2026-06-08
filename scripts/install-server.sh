#!/usr/bin/env bash
# Run the dashboard server automatically at login and keep it alive (macOS launchd).
# Starts on boot/login, restarts if it crashes, binds the LAN so your phone can reach it.
# Usage: bash /Users/maxeskell/personal-training-app/scripts/install-server.sh [PORT]
set -euo pipefail

PORT="${1:-3000}"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
LABEL="com.endurance-coach.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer targets macOS launchd. On Linux, use a systemd --user service running:"
  echo "  cd $PROJECT && $NPM_BIN run serve   (with COACH_HOST=0.0.0.0 COACH_PORT=$PORT)"
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
    <string>$NPM_BIN</string>
    <string>run</string>
    <string>serve</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>COACH_HOST</key><string>0.0.0.0</string>
    <key>COACH_PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$PROJECT/reports/server.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/server.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — the dashboard now starts at login and restarts if it stops.\n' "$LABEL"
echo "On this Mac:  http://localhost:$PORT"
for ip in $(ipconfig getifaddr en0 2>/dev/null) $(ipconfig getifaddr en1 2>/dev/null); do
  echo "On your phone (same Wi-Fi):  http://$ip:$PORT"
done
echo "Logs:      $PROJECT/reports/server.log"
echo "Uninstall: bash $PROJECT/scripts/uninstall-server.sh"
