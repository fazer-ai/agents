import { describe, expect, test } from "bun:test";
import {
  rehypeHighlightVars,
  wrapPreviewVar,
} from "@/client/lib/promptPreview";

// Minimal hast shape, mirroring the plugin's internal type.
type Node = {
  type: string;
  value?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
};

function runPlugin(tree: Node): Node {
  rehypeHighlightVars()(tree);
  return tree;
}

describe("wrapPreviewVar", () => {
  test("leaves an empty value bare (no stray highlight)", () => {
    expect(wrapPreviewVar("")).toBe("");
  });
});

describe("rehypeHighlightVars", () => {
  test("splits a wrapped run into a prompt-var span between plain text", () => {
    const root: Node = {
      type: "root",
      children: [
        {
          type: "element",
          tagName: "p",
          children: [
            {
              type: "text",
              value: `Olá ${wrapPreviewVar("Maria")}, tudo bem?`,
            },
          ],
        },
      ],
    };
    const p = runPlugin(root).children?.[0] as Node;
    expect(p.children).toHaveLength(3);
    expect(p.children?.[0]).toMatchObject({ type: "text", value: "Olá " });
    expect(p.children?.[1]).toMatchObject({
      type: "element",
      tagName: "span",
      properties: { className: ["prompt-var"] },
      children: [{ type: "text", value: "Maria" }],
    });
    expect(p.children?.[2]).toMatchObject({
      type: "text",
      value: ", tudo bem?",
    });
  });

  test("leaves text without sentinels untouched", () => {
    const root: Node = {
      type: "root",
      children: [{ type: "text", value: "no variables here" }],
    };
    const out = runPlugin(root);
    expect(out.children).toHaveLength(1);
    expect(out.children?.[0]).toMatchObject({
      type: "text",
      value: "no variables here",
    });
  });

  test("highlights multiple wrapped values in one text node", () => {
    const root: Node = {
      type: "root",
      children: [
        {
          type: "text",
          value: `${wrapPreviewVar("A")} e ${wrapPreviewVar("B")}`,
        },
      ],
    };
    const spans = (runPlugin(root).children ?? []).filter(
      (n) => n.type === "element" && n.tagName === "span",
    );
    expect(spans).toHaveLength(2);
    expect(spans[0]?.children?.[0]).toMatchObject({ value: "A" });
    expect(spans[1]?.children?.[0]).toMatchObject({ value: "B" });
  });
});
