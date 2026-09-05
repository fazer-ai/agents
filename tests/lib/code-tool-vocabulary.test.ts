import { describe, expect, test } from "bun:test";
import {
  CODE_TOOL_CONTEXT_NAMES,
  CODE_TOOL_CONTEXT_VARS,
} from "@/lib/code-tool-vocabulary";
import { CONTEXT_VAR_NAMES } from "@/modules/tool-definitions/normalize";

// The vocabulary is DATA so three surfaces cannot disagree about it (issue #538). What keeps it
// honest is this file: the list has to match the runtime's own allowlist, name for name, or a
// variable added to `CONTEXT_VAR_NAMES` reaches a body that nothing offers to complete and nothing
// documents.

describe("the code tool vocabulary answers for what the runtime builds", () => {
  test("every interpolated name is described, and nothing is described twice", () => {
    const described = CODE_TOOL_CONTEXT_NAMES.filter((n) =>
      (CONTEXT_VAR_NAMES as readonly string[]).includes(n),
    );
    expect([...described].sort()).toEqual([...CONTEXT_VAR_NAMES].sort());
    expect(new Set(CODE_TOOL_CONTEXT_NAMES).size).toBe(
      CODE_TOOL_CONTEXT_NAMES.length,
    );
  });

  // The two bags are NOT in `CONTEXT_VAR_NAMES` (they are not interpolated into an HTTP tool's
  // templates) and they ARE in `context`, so the list is the allowlist plus exactly these two. A
  // third name appearing here without a runtime that supplies it is the failure this catches.
  test("the bags are the only names beyond the allowlist", () => {
    const extra = CODE_TOOL_CONTEXT_NAMES.filter(
      (n) => !(CONTEXT_VAR_NAMES as readonly string[]).includes(n),
    );
    expect(extra.sort()).toEqual([
      "contactAttributes",
      "conversationAttributes",
    ]);
  });

  // `always` is the field an operator acts on: it decides whether the body needs a `??`. It is
  // wrong by default if nobody checks, because "the value exists" is what a reader assumes. Only
  // `agent_name` is unconditional in `httpToolContext`, and the two bags are always objects.
  test("only the three unconditional values are marked always", () => {
    const always = CODE_TOOL_CONTEXT_VARS.filter((v) => v.always).map(
      (v) => v.name,
    );
    expect(always.sort()).toEqual([
      "agent_name",
      "contactAttributes",
      "conversationAttributes",
    ]);
  });

  test("the bags are objects and every interpolated value is a string", () => {
    for (const v of CODE_TOOL_CONTEXT_VARS) {
      const expected = v.name.endsWith("Attributes") ? "object" : "string";
      expect([v.name, v.type]).toEqual([v.name, expected]);
    }
  });

  // A description that says nothing is worse than none: it fills the completion popup with noise
  // and reads as documented. Each one has to be a sentence, and the optional ones have to say when
  // the value is missing, because that is the whole point of `always: false`.
  test("each description is a sentence, and an optional one says when it is absent", () => {
    for (const v of CODE_TOOL_CONTEXT_VARS) {
      expect([v.name, v.description.length > 20]).toEqual([v.name, true]);
      expect([v.name, v.description.trim().endsWith(".")]).toEqual([
        v.name,
        true,
      ]);
      if (!v.always) {
        expect([v.name, /absent/i.test(v.description)]).toEqual([v.name, true]);
      }
    }
  });
});
