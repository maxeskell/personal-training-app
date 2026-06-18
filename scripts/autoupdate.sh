#!/usr/bin/env bash
# Pull merged code and, if anything changed, restart the dashboard so the new code is live.
# Run by the autoupdate launchd timer (install-autoupdate.sh) and by `npm run update` on demand.
# SAFE: fast-forward only, and it refuses to touch the tree if you have uncommitted local edits —
# so it can never clobber work in progress. No-op when already up to date.
#
# It tracks a single DEPLOY branch (COACH_DEPLOY_BRANCH, default 'main') rather than whatever branch
# happens to be checked out. Otherwise, being parked on a stale feature branch silently no-ops every
# update — that branch never receives the merges that land on main, so you sit on old code while the
# updater honestly reports "already up to date". On a clean tree it switches back to the deploy branch
# automatically; if you have local edits it leaves your branch alone and tells you.
set -euo pipefail

PROJECT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT"
LABEL="com.endurance-coach.dashboard"
DEPLOY_BRANCH="${COACH_DEPLOY_BRANCH:-main}"
log() { printf '%s autoupdate: %s\n' "$(date '+%F %T')" "$*"; }

# Never discard uncommitted changes (e.g. if you're hand-editing locally).
if ! git diff --quiet || ! git diff --cached --quiet; then
  log "local changes present — skipping pull (commit/stash them to resume auto-update)."
  exit 0
fi

branch="$(git rev-parse --abbrev-ref HEAD)"
# Stay on the deploy branch: a stale feature branch never receives merges, so updates would silently
# no-op forever. The tree is clean here (checked above), so switching back is safe and non-destructive.
if [ "$branch" != "$DEPLOY_BRANCH" ]; then
  if git checkout --quiet "$DEPLOY_BRANCH" 2>/dev/null \
     || git checkout --quiet -b "$DEPLOY_BRANCH" --track "origin/$DEPLOY_BRANCH" 2>/dev/null; then
    log "switched '$branch' → '$DEPLOY_BRANCH' (updates track the deploy branch)."
    branch="$DEPLOY_BRANCH"
  else
    log "on '$branch', not deploy branch '$DEPLOY_BRANCH', and couldn't switch — skipping. Fix: cd \"$PROJECT\" && git checkout $DEPLOY_BRANCH  (or set COACH_DEPLOY_BRANCH)."
    exit 0
  fi
fi

before="$(git rev-parse HEAD)"
git fetch --quiet origin "$branch" || { log "fetch failed (offline?) — will retry next run."; exit 0; }
# Fast-forward only: if the local branch has diverged, do nothing rather than create a merge.
git merge --ff-only "origin/$branch" --quiet 2>/dev/null || { log "not fast-forwardable on '$branch' — skipping."; exit 0; }
after="$(git rev-parse HEAD)"

if [ "$before" != "$after" ]; then
  log "updated ${before:0:8} → ${after:0:8} on '$branch'; restarting dashboard."
  # Restart however the server is managed (launchd preferred; pm2 fallback). Harmless if neither is set up.
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || pm2 restart endurance-dashboard 2>/dev/null || \
    log "code updated, but no managed server found to restart (start one with: npm run serve:install)."
else
  log "already up to date on '$branch'."
fi
