#!/bin/sh
# Runs the tests closest to a commit, not the whole suite, which is the CI gate. Selected: the staged
# test files; the test files that import or `mock.module` a staged module (source, script or test
# helper) directly; the ones that name a staged path as text (docs, fixtures, a source file read with
# Bun.file); and, when src/ or tests/ is staged, the ones that walk a tree (a Glob or readdir sweep
# reads every file without naming it, itself or through a helper under tests/).
#
# `bun test --changed` follows the whole import graph instead, and src/ is coupled enough that it
# picks most of the suite for a central module: 547 of about 950 files for
# src/modules/split/service.ts, where this picks 79 (76 of them the sweeps).
#
# What no test file imports runs everything: the preloads, bunfig.toml, the dependencies and the
# Prisma schema change every test file at once.
set -e

staged=${TEST_STAGED_FILES:-$(git diff --cached --name-only --diff-filter=ACMRD)}
[ -z "$staged" ] && exit 0

full=$(printf '%s\n' "$staged" | grep -E '^(tests/(setup|dom-setup|db-gate|db-name)\.ts|bunfig\.toml|package\.json|bun\.lock|tsconfig\.json|prisma/)' || true)
if [ -n "$full" ]; then
  echo "[test-staged] $(printf '%s' "$full" | head -1) changes every test file: running the whole suite"
  [ -n "$TEST_STAGED_LIST" ] && exit 0
  exec bun test
fi

picked=""
add() {
  for f in "$@"; do
    [ -f "$f" ] || continue
    case " $picked " in *" $f "*) ;; *) picked="$picked $f" ;; esac
  done
}
grep_tests() {
  grep -rl --include='*.test.ts' --include='*.test.tsx' "$@" tests 2>/dev/null || true
}

# The files that import a staged module, by any spelling of the import: `@/modules/split/service`,
# `../utils/poll`, `../../scripts/set-admin` all end in the parent directory and the name, with or
# without the extension, and a file directly under src/ is imported as `@/config`. An `index` file is also imported by its directory. A sibling import
# (`./behaviorTabProps`) names no directory, so it is searched only next to the staged file.
importers() {
  file=$1
  name=$(basename "$file")
  name=${name%.*}
  parent=$(basename "$(dirname "$file")")
  grep_tests -E "[/'\"]$parent/$name(\.tsx?)?['\"]"
  if [ "$name" = index ]; then
    grand=$(basename "$(dirname "$(dirname "$file")")")
    grep_tests -E "[/'\"]$grand/$parent['\"]"
  fi
  grep -l -E "['\"]\./$name(\.tsx?)?['\"]" "$(dirname "$file")"/*.test.ts "$(dirname "$file")"/*.test.tsx 2>/dev/null || true
  case "$file" in
    src/*)
      spec="@/${file#src/}"
      spec="${spec%.*}"
      grep_tests -F -e "\"$spec\"" -e "'$spec'"
      ;;
  esac
}

for file in $staged; do
  case "$file" in
    tests/*.test.ts | tests/*.test.tsx) add "$file" ;;
    *.ts | *.tsx)
      # shellcheck disable=SC2046
      add $(importers "$file")
      # shellcheck disable=SC2046
      add $(grep_tests -F -- "$file")
      ;;
    tests/*)
      # shellcheck disable=SC2046
      add $(grep_tests -F -- "${file#tests/}")
      ;;
    *)
      # shellcheck disable=SC2046
      add $(grep_tests -F -- "$file")
      ;;
  esac
done

# A sweep reads a whole tree (src/ or tests/) without naming the file it trips on, so a staged file in
# either runs every test that walks one, itself or through a helper under tests/.
if printf '%s\n' "$staged" | grep -qE '^(src|tests)/'; then
  walks='Glob\(|readdirSync|readdir\('
  # shellcheck disable=SC2046
  add $(grep_tests -E "$walks")
  for helper in $(grep -rlE --exclude='*.test.ts' --exclude='*.test.tsx' "$walks" tests 2>/dev/null || true); do
    case "$helper" in *.ts | *.tsx) ;; *) continue ;; esac
    # shellcheck disable=SC2046
    add $(importers "$helper")
  done
fi

if [ -z "$picked" ]; then
  echo "[test-staged] no test file reaches the staged change"
  exit 0
fi
if [ -n "$TEST_STAGED_LIST" ]; then printf '%s\n' $picked; exit 0; fi
echo "[test-staged] $(printf '%s\n' $picked | wc -l | tr -d ' ') test files"
# shellcheck disable=SC2086
exec bun test $picked
