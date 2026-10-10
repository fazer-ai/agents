import { expect, test } from "bun:test";
import { grantsToSave } from "@/client/pages/agents/hiddenGrants";
import type { GrantState } from "@/client/pages/agents/types";

// On questions and rules a Tools save writes the drawn natives from the form and every other grant
// as stored; on the language model it writes the form whole.
const RULE = ["set_labels", "private_note"] as const;
const CATALOG = ["set_labels", "private_note", "skip_reply", "calculator"];
const native = (g: GrantState[] | undefined) =>
  [...(g?.find((x) => x.source === "NATIVE")?.enabledTools ?? [])].sort();

test("the language model writes the form", () => {
  const form: GrantState[] = [
    { source: "NATIVE", enabledTools: ["private_note"] },
  ];
  expect(grantsToSave(form, null, RULE, CATALOG)).toBe(form);
});

test("a rule's tool comes from the form, the rest and the other sources as stored", () => {
  const stored: GrantState[] = [
    { source: "NATIVE", enabledTools: ["set_labels", "skip_reply"] },
    { source: "HTTP", toolDefinitionId: "7" },
  ];
  const form: GrantState[] = [
    { source: "NATIVE", enabledTools: ["private_note", "calculator"] },
  ];
  const saved = grantsToSave(form, stored, RULE, CATALOG);
  expect(native(saved)).toEqual(["private_note", "skip_reply"]);
  expect(saved.some((g) => g.source === "HTTP")).toBe(true);
});

test("no stored native row means every native, so the hidden ones stay granted", () => {
  const form: GrantState[] = [
    { source: "NATIVE", enabledTools: ["set_labels"] },
  ];
  expect(native(grantsToSave(form, [], RULE, CATALOG))).toEqual([
    "calculator",
    "set_labels",
    "skip_reply",
  ]);
});
