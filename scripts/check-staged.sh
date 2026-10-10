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

files=$(git diff --cached --name-only --diff-filter=ACMR)
lint_all=$(printf '%s\n' "$files" | grep -E '^(biome\.jsonc|biome-plugins/)' || true)

if [ -n "$CHECK_STAGED_LIST" ]; then
  if [ -n "$lint_all" ]; then echo "lint: all"; else printf '%s\n' "$files" | sed '/^$/d; s/^/lint: /'; fi
  exit 0
fi

[ -z "$CHECK_STAGED_LINT_ONLY" ] && bun run i18n:extract
if [ -n "$lint_all" ]; then
  echo "[check-staged] $(printf '%s' "$lint_all" | head -1) changes the lint rules: linting the whole tree"
  bun run lint
elif [ -n "$files" ]; then
  root=$(pwd)
  scratch=$(mktemp -d "${TMPDIR:-/tmp}/check-staged.XXXXXX")
  trap 'rm -rf "$scratch"' EXIT
  { printf '%s\n' "$files"; echo biome.jsonc; git ls-files biome-plugins; } |
    git checkout-index --prefix="$scratch/" --stdin
  (cd "$scratch" && printf '%s\n' "$files" | tr '\n' '\0' |
    xargs -0 "$root/node_modules/.bin/biome" check --vcs-enabled=false --error-on-warnings \
      --no-errors-on-unmatched --files-ignore-unknown=true)
fi
[ -n "$CHECK_STAGED_LINT_ONLY" ] && exit 0
bun run build-check
bun run build-check:worker
bun run openapi:check
