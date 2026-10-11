import { describe, expect, test } from "bun:test";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { agentExportSchema } from "@/modules/agents/transfer";

// WHY A TOOL RULE CANNOT BE NAMED `__proto__`. `agent_settings_set` ignores a `{"__proto__": null}`
// tombstone, so a stored entry could never be deleted; two halves keep it from being stored. Here:
// the key does not survive any zod object rebuild, so no write surface carries it. In
// ./agent-transfer.test.ts: an agent import copies the settings bag verbatim past both, and Prisma
// rebuilds the JSON so the value never reaches Postgres. If either changes, re-derive the conclusion.
const CANDIDATES = [
  "__proto__",
  "constructor",
  "toString",
  "valueOf",
  "hasOwnProperty",
  "prototype",
  "__defineGetter__",
  "handoff_to_human",
];

function ownKeysAfter(parse: (v: unknown) => unknown): string[] {
  const input = JSON.parse(
    `{${CANDIDATES.map((k) => `"${k}":"a note"`).join(",")}}`,
  );
  return Object.keys(parse(input) as object);
}

describe("which tool names a write surface can carry", () => {
  // MOST prototype-flavoured names are fine, and that is the useful half of this result: they arrive
  // as ordinary own properties and both runtime maps are null-prototype, so they never resolve
  // to anything inherited. `__proto__` is the single name where the surfaces disagree with storage.
  test("zod drops `__proto__` on rebuild and keeps every other prototype-ish name", () => {
    // The two real write surfaces: the MCP tool-keyed block and an agent bundle's `settings`.
    const mcpBlock = ownKeysAfter((v) =>
      BEHAVIOR_PATCH_SHAPE.toolGuidance.unwrap().parse(v),
    );
    const bundleSettings = ownKeysAfter(
      (v) => agentExportSchema.shape.agent.shape.settings.parse(v) as object,
    );
    expect(CANDIDATES.filter((k) => !mcpBlock.includes(k))).toEqual([
      "__proto__",
    ]);
    expect(CANDIDATES.filter((k) => !bundleSettings.includes(k))).toEqual([
      "__proto__",
    ]);
  });
});
