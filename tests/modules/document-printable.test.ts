import { describe, expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { DOCUMENT_STYLE_DEFAULTS } from "@/modules/documents/blocks";
import {
  unprintableCharacters,
  unprintableProblem,
} from "@/modules/documents/printable";
import { renderDocumentPdf } from "@/modules/documents/render";

// The rule this module states is pdfkit's, not ours: the standard 14 fonts are embedded with
// WinAnsiEncoding, and a code unit the encoder cannot map is written as its own hex — two bytes,
// drawn as two unrelated Latin-1 glyphs. A copy of someone else's predicate goes stale in silence,
// so it is checked against the RENDERER here, in BOTH directions: what we accept survives the round
// trip byte for byte, and what we refuse really is mangled. If a dependency bump changes the
// encoding, this fails instead of the rule quietly becoming wrong.

const base = {
  fields: [],
  style: DOCUMENT_STYLE_DEFAULTS,
  values: {},
  company: {
    name: "ACME",
    document: "",
    address: "",
    phone: "",
    email: "",
    website: "",
    logoKey: null,
    logoVersion: 0,
  },
  meta: { number: "N", date: "2026-08-20", title: "T" },
};

// The bytes the PDF actually draws, as hex, in order.
async function drawn(text: string): Promise<string> {
  const buf = await renderDocumentPdf({
    ...base,
    blocks: [{ id: "t", type: "text", text }],
  } as unknown as Parameters<typeof renderDocumentPdf>[0]);
  const raw = buf.toString("latin1");
  let inflated = "";
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = raw.indexOf("endstream", start);
    try {
      inflated += inflateSync(
        Buffer.from(raw.slice(start, end), "latin1"),
      ).toString("latin1");
    } catch {
      // Not every stream is deflated; the ones that are not carry no text.
    }
  }
  // EVERY hex chunk inside each TJ array, not just the first: a kern pair splits one drawn string
  // into `[<41> -20 <fc41>]`, and reading only the head of the array reports a character as missing
  // when it is merely kerned. (That is exactly how this harness first lied — it called `ü`
  // unprintable, which is a character the test itself expects to work.)
  return [...inflated.matchAll(/\[([^\]]*)\]\s*TJ/g)]
    .flatMap((arr) =>
      [...(arr[1] ?? "").matchAll(/<([0-9a-f]+)>/g)].map((x) => x[1]),
    )
    .join("");
}

describe("unprintableCharacters agrees with the renderer", () => {
  // Accepted: every one of these has to come back as ONE byte between the two "A"s (0x41).
  test("what it accepts is drawn as the character itself", async () => {
    for (const [ch, byte] of [
      ["á", "e1"],
      ["ç", "e7"],
      ["õ", "f5"],
      ["ü", "fc"],
      ["¿", "bf"],
      // The WinAnsi extras above Latin-1 — a euro sign and a curly quote are ordinary in a quote.
      ["€", "80"],
      ["—", "97"],
      ["…", "85"],
    ] as const) {
      expect(unprintableCharacters(ch)).toEqual([]);
      expect(await drawn(`A${ch}A`)).toBe(`41${byte}41`);
    }
  });

  // Refused: the renderer really does put a DIFFERENT character in the document — this is the whole
  // reason the rule exists, and it is why stripping would be no better.
  test("what it refuses is drawn as something else entirely", async () => {
    for (const ch of ["中", "😀", "Ж", "א", "→"]) {
      expect(unprintableCharacters(ch)).toEqual([ch]);
      const hex = await drawn(`A${ch}A`);
      // Not the character, and not nothing: extra bytes between the two A's.
      expect(hex.startsWith("41")).toBe(true);
      expect(hex).not.toBe("4141");
    }
  });

  test("reports each offender once, in the order it appears", () => {
    expect(unprintableCharacters("中文 中")).toEqual(["中", "文"]);
    expect(unprintableCharacters("Orçamento nº 12 — R$ 1.299,90")).toEqual([]);
  });

  test("the refusal names them, so it can be acted on", () => {
    expect(unprintableProblem("Olá", "name")).toBeNull();
    const problem = unprintableProblem("Olá 中", "name");
    expect(problem).toContain("name");
    expect(problem).toContain("中");
  });
});
