import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { z } from "zod";
import {
  invalidCaseAttributeKey,
  readCrossInboxCaseState,
  serializeCrossInboxCase,
} from "@/client/pages/agents/CrossInboxCaseFields";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import { readCrossInboxCaseConfig } from "@/modules/cross-inbox-case/settings";

// Issue #700: `crossInboxCase` is config OF the open_case_in_inbox tool, so it is edited on the
// tool's card and written by the Tools tab's save, the way `handoff` is. Two saves write the same
// settings column, and each one resends the whole bag, so the ownership has to be exact on both
// sides: the Tools save writes the block and keeps the shared bag in step, and the Behavior save
// never names it, so its `...settings` spread carries the stored value through.

describe("the form round-trips what is stored", () => {
  test("every field the reader honors survives a load and a save", () => {
    const stored = {
      targetInboxId: 40,
      targetInstanceId: 3,
      originLabel: "caso-aberto",
      caseAttributeKey: "protocolo",
      mergeContacts: true,
      resolveOrigin: true,
    };
    const saved = serializeCrossInboxCase(readCrossInboxCaseState(stored));
    expect(readCrossInboxCaseConfig({ crossInboxCase: saved })).toEqual(stored);
  });

  test("clearing the inbox clears the instance too, and an empty key falls back to the default", () => {
    const state = readCrossInboxCaseState({
      targetInboxId: 40,
      targetInstanceId: 3,
      caseAttributeKey: "protocolo",
    });
    const saved = serializeCrossInboxCase({
      ...state,
      targetInboxId: "",
      caseAttributeKey: " ",
    });
    expect(saved.targetInboxId).toBeNull();
    expect(saved.targetInstanceId).toBeNull();
    expect(
      readCrossInboxCaseConfig({ crossInboxCase: saved }).caseAttributeKey,
    ).toBe("case_conversation_id");
  });
});

describe("which save owns the block (source)", () => {
  const src = readFileSync(
    "src/client/pages/agents/AgentEditorPage.tsx",
    "utf8",
  );
  const slice = (from: string, to: string) => {
    const start = src.indexOf(from);
    expect(start, `anchor not found: ${from}`).toBeGreaterThan(-1);
    const end = src.indexOf(to, start + from.length);
    expect(end, `closing anchor not found: ${to}`).toBeGreaterThan(-1);
    return src.slice(start, end);
  };

  test("the Tools save writes it and keeps the shared bag in step", () => {
    const body = slice("async function saveTools(", "\n  }\n");
    expect(body).toContain(
      "const crossInboxCaseJson = serializeCrossInboxCase(crossInboxCase);",
    );
    expect(
      body.match(/crossInboxCase: crossInboxCaseJson,/g)?.length ?? 0,
    ).toBe(2);
  });

  test("the Behavior save does not name it, so it cannot write a stale form over it", () => {
    const body = slice("function buildSettings(", "\n  }\n");
    expect(body).toContain("...settings,");
    expect(body).not.toContain("crossInboxCase");
  });

  test("it is re-read with the other tool config, not by a Behavior save", () => {
    const body = slice("const syncToolConfig = useCallback(", "}, []);");
    expect(body).toContain("setCrossInboxCase(b.crossInboxCase);");
    expect(src.match(/setCrossInboxCase\(b\.crossInboxCase\)/g)?.length).toBe(
      1,
    );
  });

  test("it lights the Tools tab's unsaved dot, not Behavior's", () => {
    expect(slice("tools: JSON.stringify({", "}),")).toContain(
      "crossInboxCase,",
    );
    expect(slice("behavior: JSON.stringify({", "}),")).not.toContain(
      "crossInboxCase",
    );
  });
});

// Review round 7 of #881: the reader replaces a key outside lowercase snake_case with the default, so
// a key like that is refused where it is written instead of saved and silently ignored.
describe("the attribute key is checked where it is written", () => {
  const patch = z.object(BEHAVIOR_PATCH_SHAPE);
  const accepts = (caseAttributeKey: string) =>
    patch.safeParse({ crossInboxCase: { caseAttributeKey } }).success;
  test("a key the reader would replace is refused", () => {
    expect(accepts("Ticket-ID")).toBe(false);
    expect(accepts("1protocolo")).toBe(false);
    expect(accepts("a".repeat(65))).toBe(false);
  });
  test("a key the reader honors, or none, is accepted", () => {
    expect(accepts("protocolo_caso")).toBe(true);
    expect(accepts(" protocolo ")).toBe(true);
    expect(accepts("")).toBe(true);
  });
  test("the editor flags the same keys before the save", () => {
    const at = (caseAttributeKey: string) =>
      invalidCaseAttributeKey({
        ...readCrossInboxCaseState({}),
        caseAttributeKey,
      });
    expect(at("Ticket-ID")).toBe(true);
    expect(at("protocolo_caso")).toBe(false);
    expect(at(" protocolo ")).toBe(false);
    expect(at("")).toBe(false);
    const src = readFileSync(
      "src/client/pages/agents/CrossInboxCaseFields.tsx",
      "utf8",
    );
    expect(src).toContain("invalidCaseAttributeKey(value)");
  });
  test("the Tools save refuses a bad key before the grants PUT", () => {
    // Review round 10: the PUT went out, then the PATCH refused the key, leaving new grants beside
    // the old settings.
    const src = readFileSync(
      "src/client/pages/agents/AgentEditorPage.tsx",
      "utf8",
    );
    const start = src.indexOf("async function saveTools(");
    const body = src.slice(start, src.indexOf("\n  }\n", start));
    // The call itself is the condition of the refusal, chained after the other preflight errors.
    const check = body.indexOf("// Refused by the PATCH");
    expect(body).toContain(
      "(invalidCaseAttributeKey(crossInboxCase)\n          ? t(",
    );
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf('["tool-selections"].put('));
    expect(
      body.slice(check, body.indexOf('["tool-selections"].put(')),
    ).toContain('showToast(toolsText, "error");\n        return;');
  });
});
