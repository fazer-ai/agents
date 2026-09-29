import { describe, expect, test } from "bun:test";
import { mergeBehaviorSettings } from "@/modules/agents/behavior-settings";
import { invalidToolPreconditions } from "@/modules/agents/tool-preconditions";

// `toolGuidance` and `toolPreconditions` are FILTERS, unlike the older blocks, which read into
// DEFAULTS (an unrecognized value becomes the default, and the normalized write-back stores exactly
// what the reader produced, so nothing is lost). A filter's reader DROPS what it does not recognize
// (a key outside the native catalog, a condition of a kind added later, an entry written by an
// import), so the same normalized write-back would DELETE it, silently, in a bag the caller may not
// even have been editing.
const VALID = {
  kind: "attribute",
  scope: "conversation",
  key: "article_url",
} as const;

describe("a tool-keyed block survives the merge", () => {
  test("an invalid entry REPLACES rather than erases, so the operator can still see it", () => {
    // NOTE: A write-back of the reader's filtered output would leave `{}`, the bad entry and the good one it
    // replaced both gone. The merge is not where this is refused (that is assertSettingsToolPreconditions,
    // on the patch, before the merge; see the e2e that pins it); what the merge must not do is DELETE. A
    // stored bad entry is one the operator can see and fix; a deleted one is a guard that vanished.
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
    // NOTE: A debounce change must not delete a precondition it never mentioned. The write boundary leaves a
    // bad entry already stored alone, precisely because the field the operator would have to fix is not
    // the field they came to edit.
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
    // NOTE: A generic deep merge would keep `equals: "yes"`, so a caller following the schema's own
    // instruction ("omit to require any non-blank value") would silently keep a value-specific rule, the
    // opposite of what they asked for, on a guard.
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
    // NOTE: Removing a rule needs its own spelling: an empty object deep-merged into the old one changes
    // nothing.
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

// A stored block that is an ARRAY (legacy, or written around the API) must not reach the by-key
// merge: `Object.entries` on an array yields its INDICES, so the merge would produce keys "0" and
// "1", the dry run would pass (only the patch is validated), and the apply would fail with
// `settings.toolPreconditions.0 is not a valid precondition`, a field the operator never wrote, with
// no way for MCP to repair the block.
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
    // NOTE: The point is not tidiness: an array was never valid configuration (the reader ignores it whole),
    // so the only question is whether MCP can write over it.
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
