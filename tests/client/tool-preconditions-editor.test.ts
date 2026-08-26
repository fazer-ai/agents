import { describe, expect, test } from "bun:test";
import {
  parseToolPreconditionRows,
  serializeToolPreconditions,
} from "@/client/pages/agents/ToolPreconditionsEditor";
import { readToolPreconditions } from "@/modules/agents/tool-preconditions";

// The editor's two pure halves, tested against the RUNTIME reader rather than against themselves.
// The whole feature fails silently in one direction — a rule the console shows as saved and the turn
// does not enforce — so "the shape the editor writes is the shape the runtime reads" is the property
// worth holding, not the round trip on its own.
describe("serializeToolPreconditions", () => {
  test("writes a shape the runtime reader accepts", () => {
    const stored = serializeToolPreconditions([
      {
        tool: "handoff_to_human",
        scope: "conversation",
        key: "url",
        equals: "",
      },
      { tool: "create_invoice", scope: "contact", key: "plan", equals: "gold" },
    ]);
    expect(readToolPreconditions({ toolPreconditions: stored })).toEqual({
      handoff_to_human: {
        kind: "attribute",
        scope: "conversation",
        key: "url",
      },
      create_invoice: {
        kind: "attribute",
        scope: "contact",
        key: "plan",
        equals: "gold",
      },
    });
  });

  test("an empty `equals` means ANY value, and is not written as an empty string", () => {
    const stored = serializeToolPreconditions([
      { tool: "t", scope: "conversation", key: "k", equals: "" },
    ]) as Record<string, Record<string, unknown>>;
    expect("equals" in (stored.t ?? {})).toBe(false);
  });

  test.each([
    [
      "no tool picked yet",
      { tool: "", scope: "conversation", key: "k", equals: "" },
    ],
    [
      "no attribute key",
      { tool: "t", scope: "conversation", key: "", equals: "" },
    ],
    [
      "a whitespace key",
      { tool: "t", scope: "conversation", key: "  ", equals: "" },
    ],
  ])("drops a row with %s instead of saving it half-written", (_l, row) => {
    expect(
      serializeToolPreconditions([
        row as Parameters<typeof serializeToolPreconditions>[0][number],
      ]),
    ).toEqual({});
  });

  test("a half-written row does not block its finished siblings", () => {
    const stored = serializeToolPreconditions([
      { tool: "", scope: "conversation", key: "", equals: "" },
      { tool: "t", scope: "contact", key: "k", equals: "" },
    ]);
    expect(Object.keys(stored)).toEqual(["t"]);
  });

  test("trims what the operator typed, because a trailing space is invisible", () => {
    const stored = serializeToolPreconditions([
      { tool: " t ", scope: "contact", key: " k ", equals: " v " },
    ]) as Record<string, Record<string, unknown>>;
    expect(Object.keys(stored)).toEqual(["t"]);
    expect(stored.t).toEqual({
      kind: "attribute",
      scope: "contact",
      key: "k",
      equals: "v",
    });
  });
});

describe("parseToolPreconditionRows", () => {
  test("round-trips what the runtime stores", () => {
    const rows = [
      { tool: "a", scope: "conversation" as const, key: "k", equals: "" },
      { tool: "b", scope: "contact" as const, key: "j", equals: "v" },
    ];
    expect(parseToolPreconditionRows(serializeToolPreconditions(rows))).toEqual(
      rows,
    );
  });

  test.each([
    ["nothing stored", undefined],
    ["an array", []],
    ["a string", "x"],
  ])("reads %s as no rows", (_l, stored) => {
    expect(parseToolPreconditionRows(stored)).toEqual([]);
  });

  test("skips an entry of a kind this editor cannot render", () => {
    // A condition kind added later (or written over the API) must not be silently rewritten into an
    // attribute rule by an editor that does not understand it — the row is skipped, and the save
    // path only touches rows it produced.
    expect(
      parseToolPreconditionRows({
        legacy: { kind: "somethingElse", host: "x.com" },
        ok: { kind: "attribute", scope: "contact", key: "k" },
      }),
    ).toEqual([{ tool: "ok", scope: "contact", key: "k", equals: "" }]);
  });
});

// Round 1 of PR #378: the editor used to COERCE what it could not render, and the next save turned
// an entry the runtime ignores into a live rule.
describe("round 1: the editor renders exactly, or not at all", () => {
  test.each([
    ["an unknown scope", { kind: "attribute", scope: "moon", key: "k" }],
    ["a missing key", { kind: "attribute", scope: "contact" }],
    ["a blank key", { kind: "attribute", scope: "contact", key: "  " }],
    [
      "a non-string equals",
      { kind: "attribute", scope: "contact", key: "k", equals: 42 },
    ],
    ["a kind this editor does not know", { kind: "linkOnHost", host: "x.com" }],
  ])("does not render %s as a row", (_l, stored) => {
    expect(parseToolPreconditionRows({ t: stored })).toEqual([]);
  });

  test("an entry it cannot render survives a save of unrelated rows", () => {
    // Otherwise the first operator to save anything on the Tools tab deletes a rule written over
    // REST, from a console that never showed it to them.
    const stored = { legacy: { kind: "linkOnHost", host: "x.com" } };
    const out = serializeToolPreconditions(
      [{ tool: "t", scope: "contact", key: "k", equals: "" }],
      stored,
    );
    expect(out.legacy).toEqual({ kind: "linkOnHost", host: "x.com" });
    expect(out.t).toEqual({ kind: "attribute", scope: "contact", key: "k" });
  });

  test("a row the operator REMOVED is actually removed", () => {
    // The passthrough above must not resurrect a rule that was rendered and then deleted.
    const stored = {
      gone: { kind: "attribute", scope: "contact", key: "k" },
      kept: { kind: "attribute", scope: "contact", key: "j" },
    };
    const out = serializeToolPreconditions(
      [{ tool: "kept", scope: "contact", key: "j", equals: "" }],
      stored,
    );
    expect(Object.keys(out)).toEqual(["kept"]);
  });

  test("a malformed entry is NOT rewritten into a working rule by a save", () => {
    const stored = { t: { kind: "attribute", scope: "moon", key: "k" } };
    const out = serializeToolPreconditions([], stored);
    expect(out.t).toEqual({ kind: "attribute", scope: "moon", key: "k" });
    // And the runtime still ignores it, which is the state the operator asked for by never fixing it.
    expect(readToolPreconditions({ toolPreconditions: out })).toEqual({});
  });
});
