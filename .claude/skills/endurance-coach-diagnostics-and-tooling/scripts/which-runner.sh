#!/usr/bin/env bash
# which-runner.sh — answer "what is actually serving the dashboard on port 3000, and how?"
#
# WHY: the dashboard has ONE canonical runner — the launchd service `com.endurance-coach.dashboard`
# (port 3000). `npm start` / `npm run serve` is DEV-ONLY and, if run alongside the service, fights it for
# the port. You CANNOT tell launchd from pm2 from a `npm start` by looking at a log line — you have to look
# at the socket + the service manager. This wraps the canonical diagnostic from CLAUDE.md verbatim and adds
# a plain-English verdict. READ-ONLY: it inspects sockets and service lists, mutates nothing.
#
# Usage:  bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/which-runner.sh
# Exit:   0 = port 3000 is being served; 1 = nothing is listening on 3000.
#
# Cross-ref: full runner rules + service table live in skill `endurance-coach-run-and-operate`.

set -u
PORT="${COACH_PORT:-3000}"

echo "=== Port ${PORT} listener (lsof) ==="
# -nP = no name/port resolution (fast, numeric); -sTCP:LISTEN = only listening sockets.
LSOF_OUT="$(lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN 2>/dev/null || true)"
if [ -n "${LSOF_OUT}" ]; then
  echo "${LSOF_OUT}"
else
  echo "  (nothing listening on ${PORT})"
fi

echo
echo "=== launchd services matching 'endurance' (macOS) ==="
if command -v launchctl >/dev/null 2>&1; then
  # Columns: PID  STATUS  LABEL.  PID='-' means loaded-but-not-running; a number means running.
  LAUNCH_OUT="$(launchctl list 2>/dev/null | grep -i endurance || true)"
  if [ -n "${LAUNCH_OUT}" ]; then
    echo "${LAUNCH_OUT}"
  else
    echo "  (no com.endurance-coach.* services loaded)"
  fi
else
  echo "  (launchctl not available — not macOS; the launchd model does not apply here)"
fi

echo
echo "=== pm2 (only relevant if pm2 is the alternative runner) ==="
if command -v pm2 >/dev/null 2>&1; then
  pm2 list 2>/dev/null | grep -i endurance || echo "  (pm2 present but no endurance process)"
else
  echo "  (pm2 not installed — expected on the canonical launchd setup)"
fi

echo
echo "=== verdict ==="
if [ -z "${LSOF_OUT}" ]; then
  echo "  ✗ Nothing is serving port ${PORT}. Start the canonical service: npm run serve:install"
  exit 1
fi

DASH_RUNNING=""
if command -v launchctl >/dev/null 2>&1; then
  # A leading numeric PID on the dashboard line means launchd has it running.
  DASH_RUNNING="$(launchctl list 2>/dev/null | grep -E '^[0-9]+[[:space:]].*com\.endurance-coach\.dashboard' || true)"
fi

if [ -n "${DASH_RUNNING}" ]; then
  echo "  ✓ launchd service com.endurance-coach.dashboard is running and owns the port — the canonical setup."
  echo "    Do NOT also run 'npm start'/'npm run serve' — a second instance fights for port ${PORT}."
else
  echo "  ⚠ Port ${PORT} is served, but launchd's dashboard service is NOT the running owner."
  echo "    It is likely a foreground 'npm start'/'npm run serve' (dev-only) or pm2. Reconcile to ONE runner:"
  echo "    canonical = launchd (npm run serve:install); pm2 is an alternative, never alongside launchd."
fi
exit 0
