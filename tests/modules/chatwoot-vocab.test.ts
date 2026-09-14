import { afterEach, describe, expect, test } from "bun:test";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import {
  __resetChatwootVocabCache,
  attributesForModel,
  loadChatwootLabels,
  loadChatwootVocab,
} from "@/modules/chatwoot/vocab";

afterEach(() => __resetChatwootVocabCache());

function fakeClient(counter: { labels: number; defs: number }): ChatwootClient {
  return {
    listLabels: async () => {
      counter.labels++;
      return ["lead", "vip"];
    },
    listCustomAttributeDefinitions: async () => {
      counter.defs++;
      return [
        {
          key: "lead_stage",
          displayName: "Lead stage",
          model: "conversation_attribute",
          displayType: "list",
          values: ["new", "qualified"],
        },
        {
          key: "plano",
          displayName: "Plano",
          model: "contact_attribute",
          displayType: "list",
          values: ["Free", "Pro"],
        },
      ];
    },
  } as unknown as ChatwootClient;
}

describe("loadChatwootVocab", () => {
  test("fetches labels + attribute definitions and caches per key (TTL)", async () => {
    const counter = { labels: 0, defs: 0 };
    const client = fakeClient(counter);
    const a = await loadChatwootVocab(client, "1:2", 1_000);
    expect(a.labels).toEqual(["lead", "vip"]);
    expect(a.attributes).toHaveLength(2);
    // Within the TTL window → served from cache (no second fetch).
    await loadChatwootVocab(client, "1:2", 1_000 + 30_000);
    expect(counter.labels).toBe(1);
    expect(counter.defs).toBe(1);
    // Past the TTL → refetch.
    await loadChatwootVocab(client, "1:2", 1_000 + 120_000);
    expect(counter.labels).toBe(2);
  });

  test("attributesForModel filters by attribute_model", () => {
    const vocab = {
      labels: [],
      attributes: [
        {
          key: "a",
          displayName: "A",
          model: "conversation_attribute",
          displayType: "text",
          values: [],
        },
        {
          key: "b",
          displayName: "B",
          model: "contact_attribute",
          displayType: "text",
          values: [],
        },
      ],
    };
    expect(
      attributesForModel(vocab, "contact_attribute").map((d) => d.key),
    ).toEqual(["b"]);
    expect(attributesForModel(undefined, "contact_attribute")).toEqual([]);
  });
});

// ISSUE #642, ROUND 9. The combined read is two requests under one `Promise.all`, so an attribute
// endpoint that stays down means the caller that needs ONLY the labels re-asks forever: a failed
// combined read caches nothing.
describe("the labels on their own", () => {
  test("a failing attribute endpoint costs one label read, not one per call", async () => {
    const counter = { labels: 0, defs: 0 };
    const client = {
      listLabels: async () => {
        counter.labels++;
        return ["lead", "vip"];
      },
      listCustomAttributeDefinitions: async () => {
        counter.defs++;
        throw new Error("definitions are down");
      },
    } as unknown as ChatwootClient;
    for (let i = 0; i < 3; i++) {
      await loadChatwootVocab(client, "t:i").catch(() => null);
      expect(await loadChatwootLabels(client, "t:i")).toEqual(["lead", "vip"]);
    }
    // Two: the combined read's own first attempt, and the labels-only read that cached. From then
    // on both answer from that entry, including the combined one (round 12).
    expect(counter.labels).toBe(2);
  });

  // ROUND 12: the sharing goes both ways. The tick reads the labels alone and `buildToolset` asks
  // for the pair moments later, so without this the same catalog is fetched twice per TTL,
  // sequentially, inside one observation deadline.
  test("a warm labels-only entry answers the combined read's labels half", async () => {
    const counter = { labels: 0, defs: 0 };
    const client = fakeClient(counter);
    expect(await loadChatwootLabels(client, "t:i")).toEqual(["lead", "vip"]);
    await loadChatwootVocab(client, "t:i");
    expect(counter.labels).toBe(1);
    expect(counter.defs).toBe(1);
  });

  // ROUND 13: a catalog read most of a window ago does not become fresh by being copied into
  // another entry. Stamping a new TTL on it hides a label created in between for nearly two windows.
  test("borrowed labels keep the expiry they came with", async () => {
    const counter = { labels: 0, defs: 0 };
    const client = fakeClient(counter);
    await loadChatwootLabels(client, "t:i", 0);
    // 50s later the combined read borrows those labels; its entry may not outlive them.
    await loadChatwootVocab(client, "t:i", 50_000);
    expect(counter.labels).toBe(1);
    // At 61s both are out of date, so the next combined read asks again.
    await loadChatwootVocab(client, "t:i", 61_000);
    expect(counter.labels).toBe(2);
  });

  test("a warm combined entry answers without a read of its own", async () => {
    const counter = { labels: 0, defs: 0 };
    const client = fakeClient(counter);
    await loadChatwootVocab(client, "t:i");
    expect(await loadChatwootLabels(client, "t:i")).toEqual(["lead", "vip"]);
    expect(counter.labels).toBe(1);
  });
});
