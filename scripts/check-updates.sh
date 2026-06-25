#!/usr/bin/env bash
# Weekly "is everything current?" check — two dimensions in one report:
#   1. Dependency drift  — `npm outdated` (the libraries: Anthropic SDK, zod, TypeScript, dotenv, …).
#   2. Live integrations — `npm run doctor` (AI Endurance / Garmin creds + AIE tool drift, Anthropic key).
# Writes a timestamped section to reports/update-check.log and prints a summary. On macOS it raises a
# notification when packages are behind, so drift surfaces without you remembering to look.
#
# This NEVER mutates anything — it reports; you decide what to upgrade. Patch/minor bumps are safe to take
# behind the `npm run ship` gate; majors (zod, TypeScript, …) each want their own branch + typecheck/test
# pass. Run by hand (`npm run check:updates`) or on a schedule (`npm run check:updates:install`).
set -uo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT"
LOG="$PROJECT/reports/update-check.log"
mkdir -p "$PROJECT/reports"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

# --- 1. Dependency drift -------------------------------------------------------------------------------
# `npm outdated` exits 1 when anything is behind — expected, not a failure, so swallow the exit code.
OUTDATED_JSON="$(npm outdated --json 2>/dev/null || true)"
OUTDATED_TABLE="$(npm outdated 2>/dev/null || true)"
COUNT="$(printf '%s' "$OUTDATED_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(Object.keys(JSON.parse(s||"{}")).length)}catch{console.log(0)}})')"

# --- 2. Live integration health ------------------------------------------------------------------------
# Best-effort: doctor is degrade-don't-crash, so a missing key / unreachable AIE warns rather than fails.
DOCTOR_OUT="$(npm run --silent doctor 2>&1 || true)"

# --- Report --------------------------------------------------------------------------------------------
{
  echo "===== $STAMP ====="
  echo "[deps] $COUNT package(s) behind latest"
  [ "$COUNT" -gt 0 ] && printf '%s\n' "$OUTDATED_TABLE"
  echo "[integrations]"
  printf '%s\n' "$DOCTOR_OUT"
  echo ""
} >> "$LOG"

echo "Update check — $STAMP"
if [ "$COUNT" -gt 0 ]; then
  echo "  Dependencies: $COUNT behind latest —"
  printf '%s\n' "$OUTDATED_TABLE"
else
  echo "  Dependencies: all current ✓"
fi
echo "  Integrations: doctor ran (full output appended to the log)"
echo "  Full log:     $LOG"

# macOS nudge when something's behind — same alerting intent as the healthcheck agent.
if [ "$COUNT" -gt 0 ] && [ "$(uname)" = "Darwin" ]; then
  osascript -e "display notification \"$COUNT package(s) behind latest — run: npm outdated\" with title \"Endurance Coach: dependency drift\"" 2>/dev/null || true
fi

# A report never gates — always exit clean so launchd doesn't flag the run as failed.
exit 0
