// Comment blocks each file may still carry, as [provenance, over the line ceiling]. Written by
// `bun run comments:ledger`; see tests/lib/comment-sweep.test.ts for what counts.
import type { FileCounts } from "@/tests/utils/comment-blocks";

export const COMMENT_LEDGER: Record<string, FileCounts> = {
  "src/client/pages/agents/AgentEditorPage.tsx": [29, 12],
  "src/graph/prepare.ts": [42, 5],
  "src/graph/runtime.ts": [115, 64],
  "src/graph/tools/native.ts": [43, 19],
  "src/modules/chatwoot/channel-failure.ts": [2, 2],
  "src/modules/chatwoot/client.ts": [24, 13],
  "src/modules/chatwoot/constants.ts": [3, 3],
  "src/modules/chatwoot/normalize.ts": [24, 17],
  "src/modules/chatwoot/types.ts": [9, 3],
  "tests/client/cross-inbox-case-editor.test.ts": [3, 0],
  "tests/client/observer-tool-editor.test.tsx": [3, 0],
  "tests/client/pages/HandoffTargetMultiAccount.test.tsx": [1, 1],
  "tests/client/send-image-editor.test.tsx": [3, 0],
  "tests/graph/cross-inbox-case-wiring.test.ts": [8, 0],
  "tests/modules/channel-failure.test.ts": [3, 0],
  "tests/modules/chatwoot-client.test.ts": [10, 1],
  "tests/modules/cross-inbox-case.test.ts": [21, 0],
  "tests/modules/guardrail-handoff.test.ts": [1, 0],
  "tests/modules/mcp-tool-descriptions.test.ts": [5, 4],
  "tests/modules/split.test.ts": [17, 4],
  "tests/modules/toolpacks-google-drive.test.ts": [4, 0],
};
