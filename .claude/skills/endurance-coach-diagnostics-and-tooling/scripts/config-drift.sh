#!/usr/bin/env bash
# config-drift.sh — find env-var drift between the code and its catalog `.env.example`.
#
# WHY: `.env.example` is the documented catalog of every knob. The definition-of-done says a new flag lands
# in `config.ts` AND `.env.example` in the SAME commit. This flags both leaks:
#   (a) vars READ in code (src/ or scripts/) but MISSING from `.env.example`  -> undocumented flag.
#   (b) vars named in `.env.example` but NEVER read in code                   -> stale doc / removed flag.
# A prior config scan wrongly flagged COACH_DEPLOY_BRANCH as "dead" because it only grepped src/*.ts —
# it IS read by scripts/ship.sh:17. So this scans BOTH src/ AND scripts/. READ-ONLY.
#
# Usage:  bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/config-drift.sh
# Exit:   0 = no drift; 1 = at least one var is undocumented or stale.
#
# Cross-ref: the full env catalog + "how to add a flag" checklist live in `endurance-coach-config-and-flags`.

set -u

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || pwd)"
ENV_EXAMPLE="${ROOT}/.env.example"
[ -f "${ENV_EXAMPLE}" ] || { echo "✗ .env.example not found at ${ENV_EXAMPLE}"; exit 1; }

# --- vars READ in code -----------------------------------------------------------------------------
# TypeScript/JS: process.env.FOO   (config.ts is the main parser, but server/serverAuth/health/llm read a
# few directly by design — so scan all of src/).
CODE_TS="$(grep -rhoE "process\.env\.[A-Z0-9_]+" "${ROOT}/src" 2>/dev/null | sed 's/process\.env\.//')"
# Shell scripts: ${FOO} or $FOO for the project's own namespaces (COACH_/AIE_/GARMIN_/ANTHROPIC_/LOCAL_).
CODE_SH="$(grep -rhoE "\\\$\{?(COACH|AIE|GARMIN|ANTHROPIC|LOCAL)_[A-Z0-9_]+" "${ROOT}/scripts" 2>/dev/null | tr -d '${')"
CODE_VARS="$(printf '%s\n%s\n' "${CODE_TS}" "${CODE_SH}" | grep -E '^[A-Z]' | sort -u)"

# --- vars NAMED in .env.example --------------------------------------------------------------------
# Match both `FOO=` and commented `# FOO=` (optional leading spaces, optional '#', spaces, then KEY=).
EXAMPLE_VARS="$(sed -nE 's/^[[:space:]]*#?[[:space:]]*([A-Z][A-Z0-9_]+)=.*/\1/p' "${ENV_EXAMPLE}" | sort -u)"

echo "=== (a) READ in code but ABSENT from .env.example (undocumented flag) ==="
UNDOCUMENTED="$(comm -23 <(printf '%s\n' "${CODE_VARS}") <(printf '%s\n' "${EXAMPLE_VARS}"))"
if [ -n "${UNDOCUMENTED}" ]; then
  printf '  ✗ %s\n' ${UNDOCUMENTED}
else
  echo "  ✓ none — every env var read in code is documented in .env.example"
fi

echo
echo "=== (b) in .env.example but NEVER read in code (stale doc) ==="
STALE="$(comm -13 <(printf '%s\n' "${CODE_VARS}") <(printf '%s\n' "${EXAMPLE_VARS}"))"
if [ -n "${STALE}" ]; then
  printf '  ✗ %s\n' ${STALE}
else
  echo "  ✓ none — every documented var is read somewhere in src/ or scripts/"
fi

echo
if [ -z "${UNDOCUMENTED}" ] && [ -z "${STALE}" ]; then
  echo "✓ No config drift."
  exit 0
else
  echo "✗ Config drift found. Undocumented → add a commented entry to .env.example (definition of done)."
  echo "  Stale → the flag was removed but the doc wasn't; delete the .env.example line (or restore the reader)."
  echo "  NOTE: a couple of names may be false positives if a var is read only via a computed key — eyeball before editing."
  exit 1
fi
