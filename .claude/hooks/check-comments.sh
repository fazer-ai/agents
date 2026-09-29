#!/bin/bash
# After an edit, checks the edited file's comments against the ledger (scripts/comment-check.ts), so
# the writer hears about a history citation or an over-long block on the write that made it.
file=$(jq -r '.tool_input.file_path // empty')
case "$file" in
  *.ts | *.tsx) ;;
  *) exit 0 ;;
esac
cd "$(git rev-parse --show-toplevel)" || exit 0
if ! out=$(bun scripts/comment-check.ts "$file" 2>&1); then
  echo "$out" >&2
  exit 2
fi
exit 0
