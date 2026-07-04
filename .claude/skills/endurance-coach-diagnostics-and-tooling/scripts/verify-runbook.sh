#!/usr/bin/env bash
# verify-runbook.sh — catch skill/runbook drift: every `npm run <x>` command referenced anywhere in the
# skill library must still exist as a script in package.json. A wrong runbook is worse than none.
#
# WHY: these skills hard-code copy-paste commands like `npm run doctor`. If someone renames or removes a
# package.json script, the skills silently rot. This greps every `npm run <script>` token out of the skill
# markdown and checks each name against the "scripts" block of package.json. READ-ONLY.
#
# Usage:  bash .claude/skills/endurance-coach-diagnostics-and-tooling/scripts/verify-runbook.sh
# Exit:   0 = every referenced script exists; 1 = at least one referenced script is missing (drift).
#
# Assumes it runs from anywhere inside the repo; it resolves the repo root via git.

set -u

ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || pwd)"
PKG="${ROOT}/package.json"
SKILLS_DIR="${ROOT}/.claude/skills"

[ -f "${PKG}" ] || { echo "✗ package.json not found at ${PKG}"; exit 1; }
[ -d "${SKILLS_DIR}" ] || { echo "✗ no .claude/skills directory at ${SKILLS_DIR}"; exit 1; }

# The set of defined script names — pull the "scripts" object, then keys. Node is guaranteed (engines>=20).
DEFINED="$(node -e 'const s=require(process.argv[1]).scripts||{};console.log(Object.keys(s).join("\n"))' "${PKG}" | sort -u)"

# Every `npm run <name>` referenced in the skill MARKDOWN (SKILL.md only — never the scripts/ dir, whose
# header comments contain illustrative `npm run <name>` placeholders that would be false positives). We
# take only the script token (word chars, ':' , '-'). Placeholder tokens (x, x:y, name, foo, bar) are
# filtered — they are teaching examples, not real command references.
REFERENCED="$(find "${SKILLS_DIR}" -name 'SKILL.md' -type f -print0 2>/dev/null \
  | xargs -0 grep -hoE "npm run [a-zA-Z0-9:_-]+" 2>/dev/null \
  | sed -E 's/^npm run //' \
  | grep -vxE "x|x:y|name|foo|bar|SCRIPT|<[a-z]+>|[0-9]+" \
  | sort -u)"
# ('[0-9]+' drops the redirect token in `npm run 2>/dev/null`, which lists all scripts — not a real name.)

if [ -z "${REFERENCED}" ]; then
  echo "· No 'npm run …' commands referenced in ${SKILLS_DIR} yet — nothing to verify."
  exit 0
fi

echo "=== npm run scripts referenced in skills vs package.json ==="
MISSING=0
while IFS= read -r name; do
  [ -z "${name}" ] && continue
  if printf '%s\n' "${DEFINED}" | grep -qxF "${name}"; then
    echo "  ✓ npm run ${name}"
  else
    echo "  ✗ npm run ${name}   <-- NOT in package.json scripts (runbook drift)"
    MISSING=$((MISSING + 1))
  fi
done <<EOF
${REFERENCED}
EOF

echo
if [ "${MISSING}" -eq 0 ]; then
  echo "✓ All referenced npm scripts exist. Runbook is in sync."
  exit 0
else
  echo "✗ ${MISSING} referenced script(s) missing from package.json — fix the skill text or restore the script."
  exit 1
fi
