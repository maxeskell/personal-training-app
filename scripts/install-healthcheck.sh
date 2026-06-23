#!/usr/bin/env bash
# Watch the Endurance Coach connector from the OUTSIDE, the way Cowork reaches it: hit the PUBLIC tunnel
# URL's /health?deep=1 on a schedule and fire a macOS alert if the tunnel is down, the server is unhealthy,
# or AI Endurance needs re-auth — so you hear about it before Cowork does. Pair with install-mcp.sh.
# Usage: bash /Users/maxeskell/dev/personal-training-app/scripts/install-healthcheck.sh <PUBLIC_HTTPS_URL> [INTERVAL_SEC]
set -euo pipefail

PUBLIC_URL="${1:-}"
INTERVAL="${2:-1200}"   # 20 min between checks

if [[ -z "$PUBLIC_URL" || "$PUBLIC_URL" != https://* ]]; then
  echo "Usage: bash scripts/install-healthcheck.sh <PUBLIC_HTTPS_URL> [INTERVAL_SEC]"
  echo "  <PUBLIC_HTTPS_URL>  the SAME stable tunnel URL you passed to install-mcp.sh"
  exit 1
fi

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
AGENT_PATH="$NODE_DIR:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.endurance-coach.healthcheck"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only. On Linux, add a cron entry running:"
  echo "  cd $PROJECT && COACH_MCP_PUBLIC_URL=$PUBLIC_URL $NPM_BIN run health-remote"
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
    <string>$NPM_BIN</string><string>run</string><string>health-remote</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$AGENT_PATH</string>
    <key>HOME</key><string>$HOME</string>
    <key>COACH_MCP_PUBLIC_URL</key><string>$PUBLIC_URL</string>
  </dict>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>$PROJECT/reports/healthcheck.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/healthcheck.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — checks %s/health every %s min and alerts on trouble.\n' \
  "$LABEL" "${PUBLIC_URL%/}" "$((INTERVAL/60))"
echo "Logs:      $PROJECT/reports/healthcheck.log"
echo "Test now:  cd $PROJECT && COACH_MCP_PUBLIC_URL=$PUBLIC_URL npm run health-remote"
echo "Uninstall: bash $PROJECT/scripts/uninstall-healthcheck.sh"
