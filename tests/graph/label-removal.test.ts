import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import type { LabelWrite } from "@/graph/tools/label-writes";
import { applyLabelDelta, buildNativeTools } from "@/graph/tools/native";
import { readLabelRemoval } from "@/modules/agents/tool-guidance";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { labelFenceVerdict } from "@/modules/decisions/try";

// Removal limited to the agent's own labels (`settings.setLabels.removal: "allowed"`): a label
// another system owns stays on the conversation without being listed in `protected`, the refusal is
// named back and counted, and the agent's own swap still lands in the same call.

function setLabels(
  current: string[],
  over: Partial<Parameters<typeof buildNativeTools>[0]> = {},
) {
  const writes: string[][] = [];
  const client = {
    getConversationLabels: async () => [...current],
    setConversationLabels: async (_id: number, next: string[]) => {
      writes.push([...next]);
      return {};
    },
  } as unknown as ChatwootClient;
  const trail: LabelWrite[] = [];
  const tool = buildNativeTools({
    client,
    conversationId: 7,
    onLabelsWritten: (w) => trail.push(w),
    ...over,
  }).find((t) => t.name === "set_labels") as StructuredToolInterface;
  return { tool, writes, trail };
}

const OWNED = ["compra-de-ingresso", "cancelamento", "reembolso"];
const limited = {
  labels: OWNED,
  mode: "refuse" as const,
  removal: "allowed" as const,
};

describe("the reader", () => {
  test("removal is any unless it says allowed", () => {
    expect(readLabelRemoval({ setLabels: { removal: "allowed" } })).toBe(
      "allowed",
    );
    expect(readLabelRemoval({ setLabels: { removal: "owned" } })).toBe("any");
    expect(readLabelRemoval({})).toBe("any");
  });
});

describe("applyLabelDelta with removal limited", () => {
  test("a label outside the list is not removed and is named back", () => {
    const out = applyLabelDelta(
      [],
      ["agente-off"],
      ["cancelamento", "agente-off"],
      [],
      limited,
    );
    expect(out.next).toEqual(["cancelamento", "agente-off"]);
    expect(out.refusedForeign).toEqual(["agente-off"]);
  });

  // A refused removal leaves the scope with MORE labels, never with none, so unlike a refused
  // addition it holds nothing: the agent's own swap lands beside it.
  test("the agent's own swap lands in the same call as a refused removal", () => {
    const out = applyLabelDelta(
      ["reembolso"],
      ["cancelamento", "agente-off", "vip"],
      ["cancelamento", "agente-off", "vip"],
      [],
      limited,
    );
    expect(out.next).toEqual(["agente-off", "vip", "reembolso"]);
    expect(out.refusedForeign).toEqual(["agente-off", "vip"]);
    expect(out.heldRemove).toEqual([]);
  });

  test("an empty list under removal limited removes nothing", () => {
    const out = applyLabelDelta([], ["agente-off"], ["agente-off"], [], {
      labels: [],
      mode: "refuse",
      removal: "allowed",
    });
    expect(out.next).toEqual(["agente-off"]);
    expect(out.refusedForeign).toEqual(["agente-off"]);
  });

  test("a protected label in the list is refused as protected only", () => {
    const out = applyLabelDelta(
      [],
      ["cancelamento"],
      ["cancelamento"],
      ["cancelamento"],
      limited,
    );
    expect(out.next).toEqual(["cancelamento"]);
    expect(out.refusedRemove).toEqual(["cancelamento"]);
    expect(out.refusedForeign).toEqual([]);
  });

  test("under removal any the list does not limit removal, and no key is added", () => {
    const out = applyLabelDelta([], ["agente-off"], ["agente-off"], [], {
      ...limited,
      removal: "any",
    });
    expect(out.next).toEqual([]);
    expect("refusedForeign" in out).toBe(false);
  });
});

describe("set_labels with removal limited", () => {
  test("a foreign label stays, the model is told, and the refusal leaves its line", async () => {
    const { tool, writes, trail } = setLabels(["cancelamento", "agente-off"], {
      allowedLabels: OWNED,
      labelRemoval: "allowed",
    });
    const out = String(await tool.invoke({ remove: ["agente-off"] }));
    expect(writes).toEqual([]);
    expect(out).toContain(
      'Not this agent\'s labels, so not removed: "agente-off"',
    );
    expect(trail).toHaveLength(1);
    expect(trail[0]).toMatchObject({
      scope: "conversation",
      added: 0,
      removed: 0,
      removalRefused: 1,
    });
  });

  test("a swap beside foreign removals writes the swap and counts the refusals", async () => {
    const { tool, writes, trail } = setLabels(
      ["cancelamento", "agente-off", "vip"],
      { allowedLabels: OWNED, labelRemoval: "allowed" },
    );
    await tool.invoke({
      add: ["reembolso"],
      remove: ["cancelamento", "agente-off", "vip"],
    });
    expect(writes).toEqual([["agente-off", "vip", "reembolso"]]);
    expect(trail[0]).toMatchObject({ added: 1, removed: 1, removalRefused: 2 });
  });

  test("an own swap alone carries no refusal count", async () => {
    const { tool, writes, trail } = setLabels(["cancelamento", "agente-off"], {
      allowedLabels: OWNED,
      labelRemoval: "allowed",
    });
    await tool.invoke({ add: ["reembolso"], remove: ["cancelamento"] });
    expect(writes).toEqual([["agente-off", "reembolso"]]);
    expect(trail[0]?.removalRefused).toBeUndefined();
  });

  test("with no list, removal limited removes nothing", async () => {
    const { tool, writes } = setLabels(["agente-off"], {
      labelRemoval: "allowed",
    });
    await tool.invoke({ remove: ["agente-off"] });
    expect(writes).toEqual([]);
  });

  test("off by default: a foreign label is removed as before", async () => {
    const { tool, writes, trail } = setLabels(["cancelamento", "agente-off"], {
      allowedLabels: OWNED,
    });
    await tool.invoke({ remove: ["agente-off"] });
    expect(writes).toEqual([["cancelamento"]]);
    expect(trail[0]?.removalRefused).toBeUndefined();
  });

  test("the description says which labels it may remove, per setting", () => {
    const describe = (over: Parameters<typeof setLabels>[1]) =>
      setLabels([], over).tool.description;
    expect(
      describe({ allowedLabels: OWNED, labelRemoval: "allowed" }),
    ).toContain("You may remove only the labels in that list");
    expect(describe({ labelRemoval: "allowed" })).toContain(
      "You may not remove any label",
    );
    expect(describe({ allowedLabels: OWNED })).toContain(
      "Removing any label is still allowed.",
    );
    expect(describe({})).not.toContain("remove only");
  });
});

describe("a dry run where the scope's labels are unknown", () => {
  // A card's labels are not read in a dry run: the action is judged by what it names. A title
  // refused for removal can still be added, so it runs in part rather than reading as refused.
  test("an addition the fences let through keeps the action running", () => {
    const o = applyLabelDelta(["vip"], ["vip"], [], [], {
      labels: ["reembolso"],
      mode: "accept",
      removal: "allowed",
    });
    expect(labelFenceVerdict(o, ["vip"], ["vip"], false)).toEqual({
      fence: "allowed_labels",
      partial: true,
    });
  });

  test("a call refused in both directions is refused", () => {
    const o = applyLabelDelta([], ["vip"], [], [], limited);
    expect(labelFenceVerdict(o, [], ["vip"], false)).toEqual({
      fence: "allowed_labels",
      partial: false,
    });
  });
});
