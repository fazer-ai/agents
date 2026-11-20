#!/bin/sh
# `bun test` with the suite's per-test deadline on the command line. bun applies the preload's
# `jest.setTimeout` (tests/setup.ts) to the first test file of a process only, and a `timeout` under
# `[test]` in bunfig.toml is ignored, so every later file of a multi-file run got bun's 5 s default.
# Only `--timeout` reaches every file. The number is read from tests/utils/timeouts.ts, the constant
# the preload sets, so the two cannot drift.
set -e
here=$(cd "$(dirname "$0")" && pwd)
ms=$(bun -e "console.log((await import('$here/../tests/utils/timeouts.ts')).TEST_TIMEOUT_MS)")
exec bun test --timeout "$ms" "$@"
