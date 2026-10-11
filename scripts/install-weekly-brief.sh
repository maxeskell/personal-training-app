#!/usr/bin/env bash
# Sunday week-in-review release: runs the gated `weekly-brief:due` every Sunday at HH:00 (default 16:00, or
# COACH_WEEKLY_BRIEF_HOUR from .env) — after the Sunday sessions, so the review covers the whole week. The
# gate writes it only if this week's review is missing, so a re-fire is free. If the Mac is asleep at that
# time launchd fires on wake; if it's off, the next morning ping catches up (Mon–Wed).
# Usage: bash /Users/maxeskell/dev/personal-training-app/scripts/install-weekly-brief.sh [HH]
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_HOUR="$(grep -E '^COACH_WEEKLY_BRIEF_HOUR=' "$PROJECT/.env" 2>/dev/null | tail -1 | cut -d= -f2 | tr -d '"'"'"' ' || true)"
HH="${1:-${ENV_HOUR:-16}}"
NPM_BIN="$(command -v npm)"
NODE_DIR="$(dirname "$(command -v node)")"
AGENT_PATH="$NODE_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
LABEL="com.endurance-coach.weekly-brief"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "macOS only. On Linux, add a cron entry (Sundays at $HH:00) running:"
  echo "  cd $PROJECT && $NPM_BIN run weekly-brief:due >> reports/weekly-brief.log 2>&1"
  exit 0
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT/reports"

# Runs under `caffeinate -is` so the Mac can't doze off mid-run (see install-schedule.sh / spec 11).
cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-is</string>
    <string>/bin/bash</string><string>-lc</string>
    <string>cd "$PROJECT" &amp;&amp; "$NPM_BIN" run weekly-brief:due</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>$AGENT_PATH</string><key>HOME</key><string>$HOME</string></dict>
  <key>StartCalendarInterval</key>
  <dict><key>Weekday</key><integer>0</integer><key>Hour</key><integer>$HH</integer><key>Minute</key><integer>0</integer></dict>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$PROJECT/reports/weekly-brief.log</string>
  <key>StandardErrorPath</key><string>$PROJECT/reports/weekly-brief.log</string>
</dict>
</plist>
PLIST_EOF

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"

printf '\nInstalled %s — Sundays at %02d:00: writes the week in review (if not already written) + a desktop notification.\n' "$LABEL" "$HH"
echo "Log: tail -f $PROJECT/reports/weekly-brief.log    |   Uninstall: npm run weekly-brief:uninstall"
