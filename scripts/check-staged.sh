#!/bin/sh
# The static half of the pre-commit hook: the steps of `check:static`, in its order, with one change.
# Biome checks the staged files instead of the whole tree. The whole-tree lint costs about 35 s of CPU
# per commit, and every file the commit does not touch was checked by the commit that last did. A
# change to the lint configuration (biome.jsonc, a GritQL plugin) can change the verdict on any file,
# so it lints everything. CI runs the full `check:static`.
#
# What is linted is the index, not the disk: a file staged in part is judged on the hunks the commit
# carries. The staged files, biome.jsonc and the plugins are checked out of the index into a scratch
# directory and linted there, so the hook never touches the index or the working tree.
#
# CHECK_STAGED_LIST prints what would be linted; CHECK_STAGED_LINT_ONLY runs the lint step alone.
set -e

# Paths travel NUL-separated from git to Biome: with git's default core.quotePath, a newline-separated
# list quotes a name with non-ASCII bytes, and Biome would look for that quoted name and find nothing.
work=$(mktemp -d "${TMPDIR:-/tmp}/check-staged.XXXXXX")
trap 'rm -rf "$work"' EXIT
list="$work/staged"
git diff --cached --name-only -z --diff-filter=ACMR >"$list"
lint_all=$(tr '\0' '\n' <"$list" | grep -E '^(biome\.jsonc|biome-plugins/)' || true)

if [ -n "$CHECK_STAGED_LIST" ]; then
  if [ -n "$lint_all" ]; then echo "lint: all"; else tr '\0' '\n' <"$list" | sed '/^$/d; s/^/lint: /'; fi
  exit 0
fi

[ -z "$CHECK_STAGED_LINT_ONLY" ] && bun run i18n:extract
if [ -n "$lint_all" ]; then
  echo "[check-staged] $(printf '%s' "$lint_all" | head -1) changes the lint rules: linting the whole tree"
  bun run lint
elif [ -s "$list" ]; then
  root=$(pwd)
  { cat "$list"; printf 'biome.jsonc\0'; git ls-files -z biome-plugins; } |
    git checkout-index -z --prefix="$work/tree/" --stdin
  (cd "$work/tree" && xargs -0 "$root/node_modules/.bin/biome" check --vcs-enabled=false \
    --error-on-warnings --no-errors-on-unmatched --files-ignore-unknown=true <"$list")
fi
[ -n "$CHECK_STAGED_LINT_ONLY" ] && exit 0
bun run build-check
bun run build-check:worker
bun run openapi:check
