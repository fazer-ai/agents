import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  parseToolPreconditionRows,
  serializeToolPreconditions,
} from "@/client/pages/agents/ToolPreconditionsEditor";
import { NATIVE_TOOL_NAMES } from "@/graph/tools/catalog";
import { assertSettingsToolPreconditions } from "@/modules/agents/service";
import {
  invalidToolPreconditions,
  readToolPreconditions,
} from "@/modules/agents/tool-preconditions";

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
    // Real native names: the parser only renders tools the editor can OFFER, so a placeholder name
    // would exercise the passthrough instead of the round trip.
    const rows = [
      {
        tool: "handoff_to_human",
        scope: "conversation" as const,
        key: "k",
        equals: "",
      },
      {
        tool: "resolve_conversation",
        scope: "contact" as const,
        key: "j",
        equals: "v",
      },
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
        handoff_to_human: { kind: "somethingElse", host: "x.com" },
        assign_label: { kind: "attribute", scope: "contact", key: "k" },
      }),
    ).toEqual([
      { tool: "assign_label", scope: "contact", key: "k", equals: "" },
    ]);
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
      handoff_to_human: { kind: "attribute", scope: "contact", key: "k" },
      assign_label: { kind: "attribute", scope: "contact", key: "j" },
    };
    const out = serializeToolPreconditions(
      [{ tool: "assign_label", scope: "contact", key: "j", equals: "" }],
      stored,
    );
    expect(Object.keys(out)).toEqual(["assign_label"]);
  });

  test("a malformed entry is NOT rewritten into a working rule by a save", () => {
    const stored = { t: { kind: "attribute", scope: "moon", key: "k" } };
    const out = serializeToolPreconditions([], stored);
    expect(out.t).toEqual({ kind: "attribute", scope: "moon", key: "k" });
    // And the runtime still ignores it, which is the state the operator asked for by never fixing it.
    expect(readToolPreconditions({ toolPreconditions: out })).toEqual({});
  });
});

// Round 2 of PR #378. Three of the seven findings were the same question asked of a different value,
// and round 1 had already asked it once: what does a save do to a stored entry the operator did not
// touch? A patch per value class was the wrong answer. This is the property, asserted per class.
//
// SAVING WITHOUT CHANGING A ROW MUST NOT CHANGE WHAT THE RUNTIME ACCEPTS. Both directions:
// an entry the runtime refuses must stay refused (a save must not promote it into a live rule), and
// an entry it accepts must survive byte-identical (a save must not drop or rewrite it).
describe("round 2: parse → serialize is a fixed point for the runtime", () => {
  const RUNTIME_ACCEPTS = [
    [
      "a plain presence rule",
      { kind: "attribute", scope: "conversation", key: "url" },
    ],
    [
      "a rule with equals",
      { kind: "attribute", scope: "contact", key: "plan", equals: "gold" },
    ],
  ] as const;

  const RUNTIME_REFUSES = [
    ["an unknown kind", { kind: "somethingElse", host: "x.com" }],
    ["an unknown scope", { kind: "attribute", scope: "moon", key: "k" }],
    ["a missing key", { kind: "attribute", scope: "contact" }],
    ["a blank key", { kind: "attribute", scope: "contact", key: "   " }],
    [
      "a blank equals",
      { kind: "attribute", scope: "contact", key: "k", equals: "" },
    ],
    [
      "a whitespace equals",
      { kind: "attribute", scope: "contact", key: "k", equals: "  " },
    ],
    [
      "a numeric equals",
      { kind: "attribute", scope: "contact", key: "k", equals: 42 },
    ],
    ["a null entry", null],
    ["a string entry", "cpf"],
    ["an array entry", []],
  ] as const;

  // A save that changes nothing: the rows come straight back out of the stored bag.
  const resave = (stored: Record<string, unknown>) =>
    serializeToolPreconditions(parseToolPreconditionRows(stored), stored);

  test.each(RUNTIME_ACCEPTS)(
    "keeps %s enforceable and identical",
    (_l, entry) => {
      const stored = { handoff_to_human: entry } as Record<string, unknown>;
      const after = resave(stored);
      expect(readToolPreconditions({ toolPreconditions: after })).toEqual(
        readToolPreconditions({ toolPreconditions: stored }),
      );
    },
  );

  test.each(RUNTIME_REFUSES)(
    "does not promote %s into a live rule",
    (_l, entry) => {
      const stored = { handoff_to_human: entry } as Record<string, unknown>;
      expect(readToolPreconditions({ toolPreconditions: stored })).toEqual({});
      expect(
        readToolPreconditions({ toolPreconditions: resave(stored) }),
      ).toEqual({});
    },
  );

  test.each(RUNTIME_REFUSES)(
    "carries %s through instead of deleting it",
    (_l, entry) => {
      const stored = { handoff_to_human: entry } as Record<string, unknown>;
      expect(resave(stored).handoff_to_human).toEqual(entry);
    },
  );

  test("a condition on a tool this editor cannot offer survives a save", () => {
    // Configured over REST on an HTTP/MCP/integration tool. Rendering it would produce a row with a
    // blank selector, and the only sensible reaction to a blank row is to delete it.
    const stored = {
      create_invoice: { kind: "attribute", scope: "contact", key: "cpf" },
    };
    expect(parseToolPreconditionRows(stored)).toEqual([]);
    expect(resave(stored)).toEqual(stored);
    expect(
      readToolPreconditions({ toolPreconditions: resave(stored) }),
    ).toEqual(readToolPreconditions({ toolPreconditions: stored }));
  });

  test("a tool named `__proto__` survives serialization as an entry", () => {
    const rows = [
      { tool: "__proto__", scope: "contact" as const, key: "k", equals: "" },
    ];
    const out = serializeToolPreconditions(rows);
    // On an ordinary object this assignment changes the prototype and the key vanishes from JSON.
    expect(JSON.parse(JSON.stringify(out))).toHaveProperty("__proto__");
  });

  test("two rows on one tool keep the FIRST, not the last", () => {
    const out = serializeToolPreconditions([
      {
        tool: "handoff_to_human",
        scope: "conversation",
        key: "first",
        equals: "",
      },
      { tool: "handoff_to_human", scope: "contact", key: "second", equals: "" },
    ]) as Record<string, Record<string, unknown>>;
    expect(out.handoff_to_human?.key).toBe("first");
  });

  test("a row the operator ADDED overwrites an unrenderable entry of the same name", () => {
    const stored = { handoff_to_human: { kind: "somethingElse" } };
    const out = serializeToolPreconditions(
      [{ tool: "handoff_to_human", scope: "contact", key: "k", equals: "" }],
      stored,
    ) as Record<string, Record<string, unknown>>;
    expect(out.handoff_to_human?.kind).toBe("attribute");
  });
});

// Round 2, the P1: the Tools save wrote `toolPreconditions` to the server and did NOT put it back
// into the shared settings bag, so the next Behavior save spread the pre-save map over the rules that
// had just been stored — with this tab still showing them as saved.
//
// Read from the source, like the other AgentEditorPage guards in this suite: rendering the editor
// pulls auth, theme, toast and a live catalog, and what is being asserted is which keys the handler
// names. Written as a FENCE rather than as a check for this one key, because the defect is
// structural: every key the save PATCHes has to come back into the shared state, and the next block
// added to this tab inherits the same hole otherwise.
describe("round 2: the Tools save puts back everything it wrote", () => {
  const SRC = readFileSync(
    "src/client/pages/agents/AgentEditorPage.tsx",
    "utf8",
  );

  function keysOfObjectLiteral(src: string, start: number): string[] {
    let depth = 0;
    const keys: string[] = [];
    for (let i = start; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) break;
      } else if (depth === 1) {
        const m = /^\n\s{6,}([A-Za-z_$][\w$]*):/.exec(src.slice(i, i + 60));
        if (m?.[1]) keys.push(m[1]);
      }
    }
    return keys;
  }

  test("every key sent in toolsSettings is written back to the settings state", () => {
    const sentAt = SRC.indexOf("const toolsSettings = {");
    expect(sentAt).toBeGreaterThan(-1);
    const sent = keysOfObjectLiteral(SRC, SRC.indexOf("{", sentAt));

    // The setSettings that belongs to this handler is the first one AFTER the send.
    const backAt = SRC.indexOf("setSettings((s) => ({", sentAt);
    expect(backAt).toBeGreaterThan(sentAt);
    const back = keysOfObjectLiteral(SRC, SRC.indexOf("{", backAt + 18));

    // Positive control: the parse has to actually find keys, or this passes on an empty set.
    expect(sent).toContain("toolGuidance");
    expect(sent.length).toBeGreaterThanOrEqual(4);
    expect(sent.filter((k) => !back.includes(k))).toEqual([]);
  });
});

// Round 5 of PR #378 closed the write boundary to non-native tool names. That created a THIRD party
// to keep in agreement — the console, the runtime reader, and now the API — and two of the three
// disagreeing is invisible from inside any one of them: a console offering a name the API refuses
// makes the save fail on a row the operator just filled in, and a console hiding a name the API
// accepts invites them to delete a guard they cannot see.
describe("the console offers exactly what the API accepts", () => {
  test("every native name round-trips through the editor and the write boundary", () => {
    const rows = NATIVE_TOOL_NAMES.map((tool) => ({
      tool,
      scope: "conversation" as const,
      key: "article_url",
      equals: "",
    }));
    const stored = serializeToolPreconditions(rows);
    expect(Object.keys(stored).sort()).toEqual([...NATIVE_TOOL_NAMES].sort());
    // Accepted by the API...
    expect(invalidToolPreconditions({ toolPreconditions: stored })).toEqual([]);
    // ...enforced by the runtime...
    expect(
      Object.keys(readToolPreconditions({ toolPreconditions: stored })).sort(),
    ).toEqual([...NATIVE_TOOL_NAMES].sort());
    // ...and shown back on the next load, every one of them.
    expect(
      parseToolPreconditionRows(stored)
        .map((r) => r.tool)
        .sort(),
    ).toEqual([...NATIVE_TOOL_NAMES].sort());
  });

  test("a name the API refuses is one the editor never renders", () => {
    for (const tool of [
      "create_invoice",
      "mcp__crm__deal",
      " handoff_to_human ",
    ]) {
      const bag = {
        [tool]: { kind: "attribute", scope: "conversation", key: "k" },
      };
      expect(invalidToolPreconditions({ toolPreconditions: bag })).toEqual([
        tool,
      ]);
      expect(parseToolPreconditionRows(bag)).toEqual([]);
    }
  });

  // The fixed point again, now against the write boundary rather than the reader: an entry the
  // console cannot render is carried through verbatim, and a save that changed nothing must not be
  // the moment the API starts refusing a rule the operator never opened.
  test("saving an untouched tab does not turn a carried-through entry into a 400", () => {
    const legacy = {
      mcp__crm__create_deal: {
        kind: "attribute",
        scope: "conversation",
        key: "cpf",
      },
    };
    const stored = { toolPreconditions: legacy };
    const rows = parseToolPreconditionRows(legacy);
    expect(rows).toEqual([]);
    const next = {
      toolPreconditions: serializeToolPreconditions(rows, legacy),
    };
    expect(next.toolPreconditions).toEqual(legacy);
    expect(() => assertSettingsToolPreconditions(next, stored)).not.toThrow();
  });

  test("but ADDING a refused name in the same save is still refused", () => {
    // The exemption above is for what was already there, not a hole to write new rules through.
    const stored = { toolPreconditions: {} };
    const next = {
      toolPreconditions: {
        mcp__crm__create_deal: {
          kind: "attribute",
          scope: "conversation",
          key: "cpf",
        },
      },
    };
    expect(() => assertSettingsToolPreconditions(next, stored)).toThrow();
  });
});
