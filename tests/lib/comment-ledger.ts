// Comment blocks each file may still carry, as [provenance, over the line ceiling]. Written by
// `bun run comments:ledger`; see tests/lib/comment-sweep.test.ts for what counts.
import type { FileCounts } from "@/tests/utils/comment-blocks";

export const COMMENT_LEDGER: Record<string, FileCounts> = {
  "src/graph/runtime.ts": [115, 64],
};
