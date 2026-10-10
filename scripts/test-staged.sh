#!/bin/sh
# Runs the tests closest to a commit, not the whole suite, which is the CI gate. Selected: the staged
# test files; the test files that import or `mock.module` a staged module (source, script or test
# helper) directly; the ones that name a staged path as text (docs, fixtures, a source file read with
# Bun.file); the tree sweeps, for any change that is not only prose; and tests/lint/ when the Biome
# config or a GritQL plugin changes.
#
# `bun test --changed` follows the whole import graph instead, and src/ is coupled enough that it
# picks most of the suite for a central module: 547 of about 950 files for
# src/modules/split/service.ts, where this picks 97, most of them the sweeps.
#
# What no test file imports runs everything: the preloads, bunfig.toml, the dependencies and the
# Prisma schema change every test file at once.
set -e

staged=${TEST_STAGED_FILES:-$(git diff --cached --name-only --no-renames --diff-filter=ACMD)}
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
# without the extension (a JSON module keeps it), and a file directly under src/ is imported as
# `@/config`. A rename counts as its old path deleted and its new one added, so a test that still
# names the old path is selected. An `index` file is also imported by its directory. A sibling import
# (`./behaviorTabProps`) names no directory, so it is searched only next to the staged file.
importers() {
  file=$1
  name=$(basename "$file")
  name=${name%.*}
  parent=$(basename "$(dirname "$file")")
  grep_tests -E "[/'\"]$parent/$name(\.[A-Za-z]+)?['\"]"
  if [ "$name" = index ]; then
    grand=$(basename "$(dirname "$(dirname "$file")")")
    grep_tests -E "[/'\"]$grand/$parent['\"]"
  fi
  grep -l -E "['\"]\./$name(\.[A-Za-z]+)?['\"]" "$(dirname "$file")"/*.test.ts "$(dirname "$file")"/*.test.tsx 2>/dev/null || true
  case "$file" in
    src/*)
      spec="@/${file#src/}"
      spec="${spec%.*}"
      grep_tests -F -e "\"$spec\"" -e "'$spec'" -e "\"@/${file#src/}\"" -e "'@/${file#src/}'"
      ;;
  esac
}

for file in $staged; do
  # A file under tests/ that is not a test is a helper or a fixture, and a fixture is often loaded by
  # its bare name (`fixture("worker-hangs.ts")`), so the quoted name selects too.
  case "$file" in
    tests/*.test.ts | tests/*.test.tsx) ;;
    tests/*)
      # shellcheck disable=SC2046
      add $(grep_tests -E "['\"\`/]$(basename "$file" | sed 's/[.[\*^$]/\\&/g')['\"\`]")
      ;;
  esac
  case "$file" in
    tests/*.test.ts | tests/*.test.tsx) add "$file" ;;
    *.ts | *.tsx | *.json)
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

# A sweep reads whole trees (src/, tests/, scripts/, workers/) without naming the file it trips on:
# a Glob or readdir, or a read by a computed path (an import-graph walk). Any staged change other than
# prose runs every test that does either, itself or through a helper under tests/.
if printf '%s\n' "$staged" | grep -qvE '\.md$'; then
  walks='Glob\(|readdirSync|readdir\(|Bun\.file\([a-z]|readFileSync\([a-z]|readFile\([a-z]'
  # shellcheck disable=SC2046
  add $(grep_tests -E "$walks")
  for helper in $(grep -rlE --exclude='*.test.ts' --exclude='*.test.tsx' "$walks" tests 2>/dev/null || true); do
    case "$helper" in *.ts | *.tsx) ;; *) continue ;; esac
    # shellcheck disable=SC2046
    add $(importers "$helper")
  done
fi

# Biome loads its config and the GritQL plugins rather than importing them; tests/lint/ runs them.
if printf '%s\n' "$staged" | grep -qE '^(biome\.jsonc?|biome-plugins/)'; then
  # shellcheck disable=SC2046
  add $(find tests/lint -name '*.test.ts' 2>/dev/null)
fi

if [ -z "$picked" ]; then
  echo "[test-staged] no test file reaches the staged change"
  exit 0
fi
if [ -n "$TEST_STAGED_LIST" ]; then printf '%s\n' $picked; exit 0; fi
echo "[test-staged] $(printf '%s\n' $picked | wc -l | tr -d ' ') test files"
# shellcheck disable=SC2086
exec bun test $picked
