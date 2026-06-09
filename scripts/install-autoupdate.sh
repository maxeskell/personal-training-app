#!/usr/bin/env bash
# Keep the Mac's copy of the code current automatically: a launchd timer pulls merged changes and
# the server restarts itself — so you never run git. Pairs with the dashboard server (serve:install).
# Usage: bash scripts/install-autoupdate.sh [INTERVAL_SECONDS]   (default 900 = every 15 min)
set -euo pipefail

INTERVAL="${1:-900}"
PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_DIR="$(dirname "$(command -v git)")"
LABEL="com.endurance-coach.autoupdate"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This installer targets macOS launchd. On Linux, run scripts/autoupdate.sh from a systemd --user timer or cron."
  exit 0
fi

# Auto-update pulls the branch you're on. Normal use is 'main'; warn if you're elsewhere.
BRANCH="$(cd "$PROJECT" && git rev-parse --abbrev-ref HEAD)"
[[ "$BRANCH" != "main" ]] && echo "⚠ You're on '$BRANCH', not 'main' — auto-update will track '$BRANCH'. \`git checkout main\` if that's not intended."

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/reports"
chmod +x "$PROJECT/scripts/autoupdate.sh"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$PROJECT/scripts/autoupdate.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$GIT_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>HOME</key><string>$HOME</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>$INTERVAL</integer>
  <key>StandardOutPath</key><string>$PROJECT/reports/autoupdate.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/autoupdate.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — pulls merged code every %ds (and at login) on '\''%s'\'' and restarts the dashboard.\n' "$LABEL" "$INTERVAL" "$BRANCH"
echo "You no longer need to run git. Merged changes go live within ~$((INTERVAL / 60)) min."
echo "Log:       $PROJECT/reports/autoupdate.log"
echo "On demand: npm run update    |    Uninstall: bash $PROJECT/scripts/uninstall-autoupdate.sh"
