import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  describeLabelWrite,
  type LabelWrite,
} from "@/graph/tools/label-writes";
import { applyLabelDelta, buildNativeTools } from "@/graph/tools/native";
import {
  assertSettingsProtectedLabels,
  TooManyAllowedLabelsError,
} from "@/modules/agents/service";
import {
  ALLOWED_LABELS_MAX,
  readAllowedLabels,
  readOutsideAllowedLabels,
} from "@/modules/agents/tool-guidance";
import type { ChatwootClient } from "@/modules/chatwoot/client";

// Issue #638: an operator-declared list of the labels set_labels may ADD. Without it the model's
// array is the taxonomy and a title Chatwoot does not have is created; with it, a title outside the
// list is refused (or, under `accept`, written and counted), and the trail can name what moved.

function labelClient(current: string[]) {
  const writes: string[][] = [];
  const client = {
    getConversationLabels: async () => [...current],
    setConversationLabels: async (_id: number, next: string[]) => {
      writes.push([...next]);
      return {};
    },
  } as unknown as ChatwootClient;
  return { client, writes };
}

function setLabels(
  current: string[],
  over: Partial<Parameters<typeof buildNativeTools>[0]> = {},
) {
  const { client, writes } = labelClient(current);
  const trail: LabelWrite[] = [];
  const tool = buildNativeTools({
    client,
    conversationId: 7,
    onLabelsWritten: (w) => trail.push(w),
    ...over,
  }).find((t) => t.name === "set_labels") as StructuredToolInterface;
  return { tool, writes, trail };
}

describe("the readers", () => {
  test("allowed is cleaned like protected, and absent is empty", () => {
    expect(
      readAllowedLabels({
        setLabels: { allowed: ["vip", "", "  ", "vip", " suporte ", 3] },
      }),
    ).toEqual(["vip", "suporte"]);
    expect(readAllowedLabels({})).toEqual([]);
    expect(readAllowedLabels({ setLabels: { allowed: "vip" } })).toEqual([]);
  });

  test("outsideAllowed is refuse unless it says accept", () => {
    expect(readOutsideAllowedLabels({})).toBe("refuse");
    expect(
      readOutsideAllowedLabels({ setLabels: { outsideAllowed: "accept" } }),
    ).toBe("accept");
    expect(
      readOutsideAllowedLabels({ setLabels: { outsideAllowed: "whatever" } }),
    ).toBe("refuse");
  });

  test("a write past the ceiling is refused, the ceiling itself is not", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `t${i}`);
    expect(() =>
      assertSettingsProtectedLabels(
        { setLabels: { allowed: many(ALLOWED_LABELS_MAX + 1) } },
        undefined,
      ),
    ).toThrow(TooManyAllowedLabelsError);
    expect(() =>
      assertSettingsProtectedLabels(
        { setLabels: { allowed: many(ALLOWED_LABELS_MAX) } },
        undefined,
      ),
    ).not.toThrow();
    // An unrelated write carrying the stored over-cap list back is not the moment to refuse it.
    const over = { setLabels: { allowed: many(ALLOWED_LABELS_MAX + 3) } };
    expect(() => assertSettingsProtectedLabels(over, over)).not.toThrow();
  });
});

describe("applyLabelDelta with a list", () => {
  test("without a list the result is the object it always was", () => {
    expect(applyLabelDelta(["x"], [], [])).toEqual({
      next: ["x"],
      added: ["x"],
      removed: [],
      refusedAdd: [],
      refusedRemove: [],
      heldRemove: [],
    });
    // An empty list is no list.
    expect(
      applyLabelDelta(["x"], [], [], [], { labels: [], mode: "refuse" }),
    ).not.toHaveProperty("refusedOutside");
  });

  test("refuse drops the outside title, keeps the listed one, and holds the removal", () => {
    const out = applyLabelDelta(
      ["vip", "inventado"],
      ["suporte"],
      ["suporte"],
      [],
      {
        labels: ["vip", "suporte"],
        mode: "refuse",
      },
    );
    expect(out.next).toEqual(["suporte", "vip"]);
    expect(out.refusedOutside).toEqual(["inventado"]);
    expect(out.heldRemove).toEqual(["suporte"]);
  });

  test("a removal outside the list is not limited", () => {
    const out = applyLabelDelta([], ["legado"], ["legado", "vip"], [], {
      labels: ["vip"],
      mode: "refuse",
    });
    expect(out.next).toEqual(["vip"]);
    expect(out.refusedOutside).toEqual([]);
  });

  test("accept writes the outside title and names it for the count", () => {
    const out = applyLabelDelta(["vip", "inventado"], [], [], [], {
      labels: ["vip"],
      mode: "accept",
    });
    expect(out.next).toEqual(["vip", "inventado"]);
    expect(out.refusedOutside).toEqual([]);
    expect(out.acceptedOutside).toEqual(["inventado"]);
  });

  // Refused ONCE, under its own reason: a guarded label is someone else's, and reporting it again
  // as "not in the list" would tell the model two different things about one label.
  test("a protected label outside the list is refused as protected only", () => {
    const out = applyLabelDelta(["agente-off"], [], [], ["agente-off"], {
      labels: ["suporte"],
      mode: "refuse",
    });
    expect(out.refusedAdd).toEqual(["agente-off"]);
    expect(out.refusedOutside).toEqual([]);
  });

  test("a protected label stays refused even when the list names it", () => {
    const out = applyLabelDelta(["vip", "suporte"], [], [], ["vip"], {
      labels: ["vip", "suporte"],
      mode: "refuse",
    });
    expect(out.next).toEqual(["suporte"]);
    expect(out.refusedAdd).toEqual(["vip"]);
    expect(out.refusedOutside).toEqual([]);
  });
});

describe("set_labels with a list", () => {
  test("refuse: the outside title is not written and is named back", async () => {
    const { tool, writes } = setLabels([], {
      allowedLabels: ["vip", "suporte"],
    });
    const out = String(await tool.invoke({ add: ["vip", "inventado-638"] }));
    expect(writes).toEqual([["vip"]]);
    expect(out).toContain(
      'Not in this agent\'s list of labels, so not added: "inventado-638"',
    );
  });

  test("refuse: a swap whose new title is refused leaves the old one", async () => {
    const { tool, writes } = setLabels(["suporte"], {
      allowedLabels: ["vip", "suporte"],
    });
    const out = String(
      await tool.invoke({ add: ["inventado-638"], remove: ["suporte"] }),
    );
    expect(writes).toEqual([]);
    expect(out).toContain("inventado-638");
    expect(out).toContain('"suporte" stays');
  });

  test("accept: written as before, and the trail counts without the text", async () => {
    const { tool, writes, trail } = setLabels([], {
      allowedLabels: ["vip"],
      outsideAllowedLabels: "accept",
    });
    const out = String(
      await tool.invoke({ add: ["vip", "inventado-638", "outro-638"] }),
    );
    expect(writes).toEqual([["vip", "inventado-638", "outro-638"]]);
    expect(out).not.toContain("not added");
    expect(trail).toEqual([
      {
        scope: "conversation",
        added: 3,
        removed: 0,
        after: 3,
        addedTitles: ["vip"],
        removedTitles: [],
        outsideAllowed: 2,
      },
    ]);
    expect(JSON.stringify(trail)).not.toContain("638");
  });

  test("no list: the trail is the four counts it always was", async () => {
    const { tool, trail } = setLabels(["suporte"]);
    await tool.invoke({ add: ["vip"], remove: ["suporte"] });
    expect(trail).toEqual([
      { scope: "conversation", added: 1, removed: 1, after: 1 },
    ]);
  });

  test("the description names the list and the rule, per mode", () => {
    const labels = ["vip", "suporte", "financeiro"];
    const refuse = setLabels([], { allowedLabels: labels }).tool.description;
    const accept = setLabels([], {
      allowedLabels: labels,
      outsideAllowedLabels: "accept",
    }).tool.description;
    const none = setLabels([]).tool.description;
    for (const d of [refuse, accept])
      for (const l of labels) expect(d).toContain(`'${l}'`);
    expect(refuse).toContain("refused and not written");
    expect(accept).toContain("avoid it");
    expect(accept).not.toContain("refused and not written");
    expect(none).not.toContain("'financeiro'");
  });

  test("the whole list is named, past the ceiling the other lists are cut at", () => {
    const many = Array.from({ length: 50 }, (_, i) => `categoria-${i}`);
    const d = setLabels([], { allowedLabels: many }).tool.description;
    expect(d).toContain("'categoria-49'");
    expect(d).not.toContain("+10 more");
  });

  test("under refuse the description stops saying an unlisted label is created", () => {
    const vocab = { labels: ["vip", "suporte"] } as never;
    const refuse = setLabels([], { allowedLabels: ["vip"], vocab }).tool
      .description;
    const accept = setLabels([], {
      allowedLabels: ["vip"],
      outsideAllowedLabels: "accept",
      vocab,
    }).tool.description;
    expect(refuse).not.toContain("is created");
    expect(accept).toContain("is created");
  });
});

describe("describeLabelWrite", () => {
  test("names only what the list holds", () => {
    expect(
      describeLabelWrite(
        "conversation",
        ["vip", "x"],
        ["suporte", "y"],
        ["vip", "x"],
        {
          allowed: ["vip", "suporte"],
        },
      ),
    ).toEqual({
      scope: "conversation",
      added: 2,
      removed: 2,
      after: 2,
      addedTitles: ["vip"],
      removedTitles: ["suporte"],
    });
  });
});
