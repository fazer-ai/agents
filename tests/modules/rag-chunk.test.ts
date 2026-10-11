import { describe, expect, test } from "bun:test";
import { chunkText } from "@/modules/rag/chunk";

describe("chunkText", () => {
  test("empty/whitespace → []", async () => {
    expect(await chunkText("   ")).toEqual([]);
  });
  test("short text → single chunk", async () => {
    const out = await chunkText("Olá, tudo bem?");
    expect(out).toEqual(["Olá, tudo bem?"]);
  });
  test("long text → multiple overlapping chunks", async () => {
    // Distinct words, so an overlap is the same words and not a repeat that looks like one.
    const words = Array.from({ length: 300 }, (_, i) => `w${i}`);
    const out = await chunkText(words.join(" "), {
      chunkSize: 200,
      chunkOverlap: 40,
    });
    expect(out.length).toBeGreaterThan(1);
    expect(out.every((c) => c.length <= 200)).toBe(true);
    expect(out[0]?.startsWith("w0 ")).toBe(true);
    expect(out.at(-1)?.endsWith(" w299")).toBe(true);
    for (const [i, chunk] of out.entries()) {
      if (i === 0) continue;
      const prev = (out[i - 1] as string).split(" ");
      const head = chunk.split(" ");
      // Each chunk opens on the tail of the one before, and nothing between them is skipped.
      const shared = prev.slice(prev.indexOf(head[0] as string));
      expect(shared.length).toBeGreaterThan(1);
      expect(head.slice(0, shared.length)).toEqual(shared);
    }
  });
});
