import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { modelVisibleLabels } from "@/graph/tools/label-view";
import { buildNativeTools } from "@/graph/tools/native";
import type { ChatwootClient } from "@/modules/chatwoot/client";

// A client that answers a conversation's labels and records what is written back, which is the only
// way to tell a delta that was COMPUTED right from one that was merely reported right.
function labelClient(current: string[]) {
  const writes: string[][] = [];
  const client = {
    getConversationLabels: async () => [...current],
    setConversationLabels: async (_id: number, next: string[]) => {
      writes.push([...next]);
      return {};
    },
    getContactLabels: async () => [...current],
    setContactLabels: async (_id: number, next: string[]) => {
      writes.push([...next]);
      return {};
    },
  } as unknown as ChatwootClient;
  return { client, writes };
}

function byName(tools: StructuredToolInterface[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

describe("set_labels takes a delta, not a replacement (issue #695)", () => {
  // s2: the contract the model is handed.
  test("the schema offers add and remove, and no longer offers the complete list", () => {
    const { client } = labelClient([]);
    const tool = byName(
      buildNativeTools({ client, conversationId: 1 }),
      "set_labels",
    );
    const shape = (tool.schema as { shape: Record<string, unknown> }).shape;
    expect(Object.keys(shape).sort()).toEqual(["add", "remove", "scope"]);
  });

  // s4: what reaches Chatwoot is current - remove + add, and nothing else. The label nobody named
  // is untouched, which is the whole point: under the old contract `current` carried `outro` and a
  // call that did not repeat it deleted it.
  test("conversation scope writes current minus remove plus add", async () => {
    const { client, writes } = labelClient(["vip", "outro", "velho"]);
    const tool = byName(
      buildNativeTools({ client, conversationId: 7 }),
      "set_labels",
    );
    await tool.invoke({ add: ["novo"], remove: ["velho"] });
    expect(writes).toEqual([["vip", "outro", "novo"]]);
  });

  // s13: a label another writer added mid-turn survives, with no `shown` baseline involved. Under
  // the old contract this needed the shown-diff; here it is a property of the contract.
  test("a label the model never saw is not removed by a call that does not name it", async () => {
    const { client, writes } = labelClient(["vip", "posto-por-outro"]);
    const tool = byName(
      buildNativeTools({
        client,
        conversationId: 7,
        shownLabels: { conversation: ["vip"] },
      }),
      "set_labels",
    );
    await tool.invoke({ add: ["novo"] });
    expect(writes).toEqual([["vip", "posto-por-outro", "novo"]]);
  });

  // s16: and the other half of the same rule — what the model was NOT shown it may still remove,
  // when it names it. The 40-label ceiling stops being a correctness lever.
  test("a label past the shown ceiling is removable when named", async () => {
    const { client, writes } = labelClient(["a", "b", "c"]);
    const tool = byName(
      buildNativeTools({
        client,
        conversationId: 7,
        shownLabels: { conversation: ["a"] },
      }),
      "set_labels",
    );
    await tool.invoke({ remove: ["c"] });
    expect(writes).toEqual([["a", "b"]]);
  });

  // s7: nothing named is nothing written, and so is naming what changes nothing.
  test("a call that moves no label writes nothing", async () => {
    const { client, writes } = labelClient(["vip"]);
    const tool = byName(
      buildNativeTools({ client, conversationId: 7 }),
      "set_labels",
    );
    await tool.invoke({ add: ["vip"], remove: ["nao-esta-la"] });
    expect(writes).toEqual([]);
  });

  // s3: the old shape must not pass as a success. A tenant whose operator prose still says "pass
  // the complete list" will produce this call, and answering "already as requested" would tell the
  // model its classification landed when nothing was written.
  test("a call in the old shape is refused by name, not answered as a no-op", async () => {
    const { client, writes } = labelClient(["vip"]);
    const tool = byName(
      buildNativeTools({ client, conversationId: 7 }),
      "set_labels",
    );
    const out = String(await tool.invoke({ labels: ["vip", "novo"] }));
    expect(writes).toEqual([]);
    expect(out).toContain("add");
    expect(out).toContain("remove");
    expect(out).not.toContain("already as requested");
  });

  // s8: protected still refuses an ADD — the half the issue's first draft dropped, and the half a
  // production tenant relies on to keep one agent's taxonomy out of another agent's reach.
  test("protected refuses an add, and says so instead of staying silent", async () => {
    const { client, writes } = labelClient(["vip"]);
    const tool = byName(
      buildNativeTools({
        client,
        conversationId: 7,
        protectedLabels: ["cancelamento"],
      }),
      "set_labels",
    );
    const out = String(await tool.invoke({ add: ["cancelamento"] }));
    expect(writes).toEqual([]);
    expect(out).toContain("cancelamento");
    expect(out).not.toContain("already as requested");
  });

  // s9: and a REMOVE, including when the model names it deliberately — which it now can, because it
  // can see it.
  test("protected refuses a remove it can now see, and names it", async () => {
    const { client, writes } = labelClient(["vip", "agente-off"]);
    const tool = byName(
      buildNativeTools({
        client,
        conversationId: 7,
        protectedLabels: ["agente-off"],
      }),
      "set_labels",
    );
    const out = String(await tool.invoke({ remove: ["agente-off"] }));
    expect(writes).toEqual([]);
    expect(out).toContain("agente-off");
  });

  // s10 / s12: protecting stops meaning hiding. This is what closes the measured defect of
  // 2026-09-11, where a fenced agent could not see the canonical value and invented one.
  test("a protected label is shown to the model", () => {
    expect(modelVisibleLabels(["vip", "cancelamento"])).toEqual([
      "vip",
      "cancelamento",
    ]);
  });
});
