#!/usr/bin/env bash
# ship.sh — local-first deploy. Gate, merge your branch → main, restart the live dashboard,
# back up to GitHub, then drop you back on your branch. Replaces the PR + auto-merge dance.
#
#   npm run ship            # ships the branch you're currently on
#   npm run ship -- <name>  # ships a named branch instead
#
# SAFE: aborts before merging if tests/typecheck fail, the tree is dirty, or a merge/rebase is already
# in progress. If the merge itself conflicts it backs out cleanly (git merge --abort) and returns you to
# your branch — nothing half-merged is ever left on the deploy branch. A failed backup push (e.g.
# offline) does NOT abort — your local deploy is already live; it just warns how to push later.
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

# Never start on top of an unfinished merge/rebase — that is exactly how a half-finished state gets stranded.
if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
  die "a merge is already in progress in $PROJECT — finish it, or run 'git merge --abort', before shipping."
fi
if [ -d "$(git rev-parse --git-path rebase-merge 2>/dev/null)" ] || [ -d "$(git rev-parse --git-path rebase-apply 2>/dev/null)" ]; then
  die "a rebase is in progress in $PROJECT — finish it, or run 'git rebase --abort', before shipping."
fi

# --- 1. local gate (replaces the dropped CI) ------------------------------
log "gate: npm test + typecheck on '$BRANCH'…"
npm test
npm run typecheck

# --- 2-3. merge feature → main --------------------------------------------
log "merging '$BRANCH' → '$DEPLOY_BRANCH'…"
git checkout "$DEPLOY_BRANCH"
if ! git merge --no-ff "$BRANCH" -m "ship: merge $BRANCH into $DEPLOY_BRANCH"; then
  git merge --abort
  git checkout "$BRANCH"
  die "merge of '$BRANCH' into '$DEPLOY_BRANCH' hit conflicts — backed it out cleanly; you are back on '$BRANCH' and NOTHING was deployed. Resolve on your branch first, then re-ship:
       git rebase $DEPLOY_BRANCH    # replay your work onto $DEPLOY_BRANCH, fixing conflicts there
       npm run ship"
fi

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
