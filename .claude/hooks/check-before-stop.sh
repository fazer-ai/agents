#!/bin/bash
# End-of-turn check for coding agents: runs the fast part of `bun check` before letting the agent
# stop, but only when an uncommitted change touches a file the check reads. Claude Code calls it from
# the Stop hook in .claude/settings.json.
#
# The contract of a command Stop hook: exit 0 with exactly one JSON object on stdout,
# {"decision": "block", "reason": "..."}, keeps the agent working; any other text on stdout turns that
# object into a parse failure and the stop goes through (https://code.claude.com/docs/en/hooks,
# "Stop decision control" and "Exit code 0"). So the check's own output goes into the reason, never to
# stdout, and a passing check prints nothing. `{"ok": ...}` is the prompt-hook schema, and a command
# hook's answer in that shape is ignored.
#
# The fast part is the Biome lint of the changed files (the whole tree when the lint rules change),
# the domain vocabulary check and the type-checks. The test suite is left to the pre-commit hook
# (`scripts/test-staged.sh`) and to CI: it needs a database, and on a machine that runs several
# sessions at once a whole `bun check` on every stop was the heaviest thing on the box.

input=$(cat)

# NOTE: stop_hook_active is set when the turn is already continuing because of a Stop hook. Blocking
# again would loop, so the second stop in a row goes through.
stop_hook_active=$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)
if [ "$stop_hook_active" = "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}" || exit 0

changed_files=$(
  {
    git diff --name-only HEAD 2>/dev/null
    git diff --name-only --cached 2>/dev/null
    git ls-files --others --exclude-standard 2>/dev/null
  } | sort -u
)
relevant=$(printf '%s\n' "$changed_files" | grep -E '\.(ts|tsx|js|jsx|json|jsonc|css|prisma|grit)$' || true)
if [ -z "$relevant" ]; then
  exit 0
fi

# NOTE: the working tree is hashed through a scratch index (tracked edits and untracked files alike,
# never the real index), and the last tree that passed lives in the git directory, so a stop on the
# same tree goes through at once. Only a pass is remembered: a tree that failed is checked again.
index=$(mktemp "${TMPDIR:-/tmp}/check-before-stop-index.XXXXXX") || exit 0
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree HEAD 2>/dev/null || exit 0
GIT_INDEX_FILE="$index" git add -A 2>/dev/null || exit 0
tree=$(GIT_INDEX_FILE="$index" git write-tree 2>/dev/null) || exit 0
green="$(git rev-parse --git-path check-before-stop-green)"
if [ "$tree" = "$(cat "$green" 2>/dev/null)" ]; then
  exit 0
fi

mkdir -p tmp
log="$PWD/tmp/check-before-stop.log"
: > "$log"

fast_tier() {
  if printf '%s\n' "$changed_files" | grep -qE '^(biome\.jsonc|biome-plugins/)'; then
    bun biome check --error-on-warnings || return 1
  else
    # NOTE: a deleted file is in the list too; Biome skips a path that is gone only with
    # --no-errors-on-unmatched, so the existing ones are passed.
    lint_files=$(printf '%s\n' "$changed_files" | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done)
    if [ -n "$lint_files" ]; then
      printf '%s\n' "$lint_files" | tr '\n' '\0' |
        xargs -0 bun biome check --error-on-warnings --no-errors-on-unmatched --files-ignore-unknown=true || return 1
    fi
  fi
  bun scripts/check-domain-vocabulary.ts &&
    bun run build-check || return 1
  if printf '%s\n' "$changed_files" | grep -q '^workers/'; then
    bun run build-check:worker || return 1
  fi
}

if fast_tier >> "$log" 2>&1; then
  printf '%s\n' "$tree" > "$green"
  exit 0
fi

errors=$(grep -E 'error|✗|×' "$log" | head -n 40)
tail=$(tail -n 30 "$log")
jq -n --arg errors "$errors" --arg tail "$tail" --arg log "$log" '{
  decision: "block",
  reason: ("The end-of-turn check failed (lint of the changed files, domain vocabulary or type-check). Fix it before stopping. Full output: " + $log + "\n\nLines that look like errors:\n" + $errors + "\n\nLast lines:\n" + $tail)
}'
