#!/usr/bin/env bash
# ship.sh — local-first deploy. Gate, merge your branch → main, restart the live dashboard,
# back up to GitHub, then drop you back on your branch. Replaces the PR + auto-merge dance.
#
#   npm run ship            # ships the branch you're currently on
#   npm run ship -- <name>  # ships a named branch instead
#
# SAFE: aborts before merging if tests/typecheck fail or the tree is dirty. A failed backup push
# (e.g. branch protection still on, or offline) does NOT abort — your local deploy is already live;
# it just warns and tells you how to push later.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT"

DEPLOY_BRANCH="${COACH_DEPLOY_BRANCH:-main}"
LABEL="com.endurance-coach.dashboard"

log()  { printf '\033[1;34mship:\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31mship: %s\033[0m\n' "$*" >&2; exit 1; }

# Branch to ship: explicit arg wins, otherwise the branch you're on.
BRANCH="${1:-$(git rev-parse --abbrev-ref HEAD)}"

# --- guards ---------------------------------------------------------------
[ "$BRANCH" != "$DEPLOY_BRANCH" ] || die "you're on '$DEPLOY_BRANCH' — ship a feature branch, not the deploy branch."
git diff --quiet && git diff --cached --quiet || die "uncommitted changes on '$BRANCH' — commit or stash first."
git rev-parse --verify --quiet "$BRANCH" >/dev/null || die "branch '$BRANCH' not found."

# --- 1. local gate (replaces the dropped CI) ------------------------------
log "gate: npm test + typecheck on '$BRANCH'…"
npm test
npm run typecheck

# --- 2-3. merge feature → main --------------------------------------------
log "merging '$BRANCH' → '$DEPLOY_BRANCH'…"
git checkout "$DEPLOY_BRANCH"
git merge --no-ff "$BRANCH" -m "ship: merge $BRANCH into $DEPLOY_BRANCH"

# --- 4. restart the live dashboard (post-merge hook usually already did) ---
log "restarting dashboard…"
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null \
  || log "no managed dashboard found to restart (start one with: npm run serve:install)."

# --- 5. back up to GitHub (non-fatal: deploy is already live) -------------
log "backing up '$DEPLOY_BRANCH' to GitHub…"
if git push origin "$DEPLOY_BRANCH"; then
  log "backed up."
else
  log "⚠ push rejected/failed (branch protection still on? offline?). Local deploy IS live but NOT backed up."
  log "  fix, then: cd \"$PROJECT\" && git push origin $DEPLOY_BRANCH"
fi

# --- 6. drop you back on your branch --------------------------------------
git checkout "$BRANCH"
log "done — '$BRANCH' merged to '$DEPLOY_BRANCH', dashboard restarted."
