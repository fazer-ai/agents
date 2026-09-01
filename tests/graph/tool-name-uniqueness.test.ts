import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { dropDuplicateToolNames } from "@/graph/tools/unique-names";

// Decision table for the one rule the assembly owns: which tool keeps a name two sources both claim.

function t(name: string, mark = ""): StructuredToolInterface {
  return { name, description: mark } as unknown as StructuredToolInterface;
}

const names = (tools: StructuredToolInterface[]) => tools.map((x) => x.name);

describe("dropDuplicateToolNames", () => {
  test("leaves a toolset with no repeats exactly as it was", () => {
    const tools = [t("send_image"), t("send_orcamento"), t("crm_lookup")];
    const r = dropDuplicateToolNames(tools);
    expect(names(r.tools)).toEqual([
      "send_image",
      "send_orcamento",
      "crm_lookup",
    ]);
    expect(r.dropped).toEqual([]);
  });

  // The precedence IS the build order, and the build order puts the native tools first. An operator
  // can rename their own HTTP tool; nobody can rename handoff_to_human.
  test("the earlier source keeps the name, the later one is dropped", () => {
    const r = dropDuplicateToolNames([
      t("handoff_to_human", "native"),
      t("handoff_to_human", "http"),
    ]);
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]?.description).toBe("native");
    expect(r.dropped).toEqual(["handoff_to_human"]);
  });

  // The case that made this necessary: a document template's tool name is derived from its slug, and
  // the tenant may already have an HTTP tool under that exact name. Both are operator-authored, so
  // neither is "wrong" — the point is that one deterministic tool answers, and the other is named.
  test("names a document tool colliding with an HTTP tool of the same name", () => {
    const r = dropDuplicateToolNames([
      t("send_image", "native"),
      t("send_orcamento", "document"),
      t("send_orcamento", "http"),
      t("crm_lookup", "http"),
    ]);
    expect(names(r.tools)).toEqual([
      "send_image",
      "send_orcamento",
      "crm_lookup",
    ]);
    expect(r.tools[1]?.description).toBe("document");
    expect(r.dropped).toEqual(["send_orcamento"]);
  });

  // Three claimants report two losses: a count that collapses repeats would understate how much of
  // the agent's toolset went missing.
  test("reports every dropped claim, not every duplicated name", () => {
    const r = dropDuplicateToolNames([
      t("lookup", "a"),
      t("lookup", "b"),
      t("lookup", "c"),
    ]);
    expect(r.tools).toHaveLength(1);
    expect(r.dropped).toEqual(["lookup", "lookup"]);
  });

  // A NATIVE NAME IS RESERVED EVEN WHEN NO NATIVE CLAIMS IT (issue #457, review round 5). Ordering
  // defends only the names actually built, and `buildNativeTools` drops the ones outside the agent's
  // allowlist — so on an agent with the transfer tool turned off, the name was simply free, and an
  // HTTP or toolpack tool could answer as `handoff_to_human`. The hand-back decision reads a result
  // under that name as a transfer that happened, and tool preconditions restrict rules to native
  // names on the same argument; both need the name reserved, not merely first.
  test("a reserved native name is refused to another source that claims it", () => {
    const r = dropDuplicateToolNames(
      [t("crm_lookup", "http"), t("handoff_to_human", "http")],
      ["handoff_to_human", "private_note"],
    );
    expect(names(r.tools)).toEqual(["crm_lookup"]);
    expect(r.dropped).toEqual(["handoff_to_human"]);
  });

  // And the reservation covers only what the natives did NOT build: a native that IS in the toolset
  // keeps its own name, which is the ordering rule doing its job.
  test("a native that was built keeps its name", () => {
    const r = dropDuplicateToolNames(
      [t("handoff_to_human", "native"), t("handoff_to_human", "http")],
      ["private_note"],
    );
    expect(r.tools).toHaveLength(1);
    expect(r.tools[0]?.description).toBe("native");
    expect(r.dropped).toEqual(["handoff_to_human"]);
  });

  test("an empty toolset is not a special case", () => {
    const r = dropDuplicateToolNames([]);
    expect(r.tools).toEqual([]);
    expect(r.dropped).toEqual([]);
  });
});
