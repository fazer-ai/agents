import { describe, expect, test } from "bun:test";
import { mergeBehaviorSettings } from "@/modules/agents/behavior-settings";
import { invalidToolPreconditions } from "@/modules/agents/tool-preconditions";

// ROUND 1 OF PR #404. The five blocks reached MCP, and two of them broke a rule the other eighteen
// cannot break, because of a difference in their READERS.
//
// The eighteen older blocks read into DEFAULTS: an unrecognized value becomes the default, and the
// normalized write-back that follows the merge stores exactly what the reader produced. Nothing is
// lost, because there was nothing the reader could not represent.
//
// `toolGuidance` and `toolPreconditions` are FILTERS. Their readers DROP what they do not recognize —
// a key outside the native catalog, a condition of a kind added later, an entry written by an import.
// Run those through the same normalized write-back and "normalize" means DELETE, silently, in a bag
// the caller may not even have been editing.
//
// All three cases below were measured on this branch before the fix.
const VALID = {
  kind: "attribute",
  scope: "conversation",
  key: "article_url",
} as const;

describe("a tool-keyed block survives the merge", () => {
  test("an invalid entry REPLACES rather than erases, so the operator can still see it", () => {
    // MEASURED before the fix: `{}` — both the bad entry and the good one it replaced were gone,
    // because the write-back stored the reader's filtered output. The merge is not where this is
    // refused (that is assertSettingsToolPreconditions, on the patch, before the merge — see the
    // e2e that pins it); what the merge must not do is DELETE. A bad entry that is stored is one the
    // operator can see and fix; a deleted one is a guard that vanished.
    const merged = mergeBehaviorSettings(
      { toolPreconditions: { handoff_to_human: VALID } },
      {
        toolPreconditions: {
          handoff_to_human: { ...VALID, key: " " },
        },
      } as never,
    );
    expect(
      (merged as Record<string, Record<string, unknown>>).toolPreconditions
        ?.handoff_to_human,
    ).toEqual({ ...VALID, key: " " });
  });

  test("an untouched unparseable entry survives an unrelated update", () => {
    // MEASURED: `{}` — a debounce change deleted a precondition it never mentioned. The write
    // boundary's own rule is that a bad entry already stored is left alone, precisely because the
    // field the operator would have to fix is not the field they came to edit.
    const merged = mergeBehaviorSettings(
      { toolPreconditions: { legacy_tool: { kind: "future-kind" } } },
      { debounce: { enabled: false } } as never,
    );
    expect(
      (merged as Record<string, Record<string, unknown>>).toolPreconditions,
    ).toEqual({ legacy_tool: { kind: "future-kind" } });
  });

  test("the same holds for toolGuidance", () => {
    const merged = mergeBehaviorSettings(
      { toolGuidance: { mcp__crm__deal: "written by an import" } },
      { debounce: { enabled: false } } as never,
    );
    expect(
      (merged as Record<string, Record<string, unknown>>).toolGuidance,
    ).toEqual({ mcp__crm__deal: "written by an import" });
  });

  test("omitting equals CLEARS it, because each tool's value is replaced whole", () => {
    // MEASURED: `equals: "yes"` survived. The generic deep merge kept it, so a caller following the
    // schema's own instruction ("omit to require any non-blank value") silently kept a
    // value-specific rule — the opposite of what they asked for, on a guard.
    const merged = mergeBehaviorSettings(
      { toolPreconditions: { handoff_to_human: { ...VALID, equals: "yes" } } },
      { toolPreconditions: { handoff_to_human: VALID } } as never,
    );
    expect(
      (merged as Record<string, Record<string, unknown>>).toolPreconditions
        ?.handoff_to_human,
    ).toEqual(VALID);
  });

  test("null removes one tool's entry, and leaves its siblings", () => {
    // There was no way to REMOVE a rule over MCP at all: an empty object deep-merged into the old
    // one and changed nothing.
    const merged = mergeBehaviorSettings(
      {
        toolPreconditions: {
          handoff_to_human: VALID,
          private_note: VALID,
        },
      },
      { toolPreconditions: { handoff_to_human: null } } as never,
    );
    expect(
      (merged as Record<string, Record<string, unknown>>).toolPreconditions,
    ).toEqual({ private_note: VALID });
  });

  test("a patch that does not mention the block leaves it byte-identical", () => {
    const stored = {
      toolPreconditions: { handoff_to_human: VALID },
      toolGuidance: { private_note: "keep" },
    };
    const merged = mergeBehaviorSettings(stored, {
      debounce: { enabled: true },
    } as never);
    expect((merged as Record<string, unknown>).toolPreconditions).toEqual(
      stored.toolPreconditions,
    );
    expect((merged as Record<string, unknown>).toolGuidance).toEqual(
      stored.toolGuidance,
    );
  });
});

// ROUND 3 OF PR #404. A stored block that is an ARRAY — legacy, or written around the API — reached
// the by-key merge, and `Object.entries` on an array yields its INDICES. The merge produced keys
// "0" and "1", the dry run passed because only the patch is validated, and the apply then failed
// with `settings.toolPreconditions.0 is not a valid precondition`: a refusal naming a field the
// operator never wrote, and no way for MCP to repair the block.
describe("a stored block of the wrong SHAPE does not become keys", () => {
  const VALID = {
    kind: "attribute",
    scope: "conversation",
    key: "article_url",
  } as const;

  test("an array prior is treated as no map at all, not enumerated", () => {
    const merged = mergeBehaviorSettings(
      { toolPreconditions: [{ kind: "attribute" }] } as never,
      { toolPreconditions: { handoff_to_human: VALID } } as never,
    );
    expect(
      (merged as Record<string, Record<string, unknown>>).toolPreconditions,
    ).toEqual({ handoff_to_human: VALID });
  });

  test("so the patch REPAIRS the block instead of being blocked by it", () => {
    // The point is not tidiness: an array was never valid configuration (the reader ignores it
    // whole), so the only question is whether MCP can write over it. Before this it could not —
    // every apply refused on names the merge had invented.
    const merged = mergeBehaviorSettings(
      { toolPreconditions: ["nonsense"] } as never,
      { toolPreconditions: { handoff_to_human: VALID } } as never,
    );
    expect(invalidToolPreconditions(merged)).toEqual([]);
  });

  test("the same for toolGuidance", () => {
    const merged = mergeBehaviorSettings(
      { toolGuidance: ["nonsense"] } as never,
      { toolGuidance: { handoff_to_human: "note" } } as never,
    );
    expect(
      (merged as Record<string, Record<string, unknown>>).toolGuidance,
    ).toEqual({ handoff_to_human: "note" });
  });
});
