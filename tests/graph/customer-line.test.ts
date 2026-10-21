import { describe, expect, test } from "bun:test";
import { customerLine } from "@/graph/tools/customer-line";

describe("customerLine", () => {
  const table: Array<[string | null | undefined, string]> = [
    [undefined, ""],
    [null, ""],
    ["", ""],
    ["   ", ""],
    ["EMPTY", ""],
    [" n/a ", ""],
    ["None", ""],
    ["Not applicable", ""],
    ["-", ""],
    ["  Um humano já te atende.  ", "Um humano já te atende."],
    [
      "Não se aplica a você, mas posso ajudar.",
      "Não se aplica a você, mas posso ajudar.",
    ],
    [
      "None of our plans fit? Talk to us.",
      "None of our plans fit? Talk to us.",
    ],
  ];
  for (const [raw, expected] of table)
    test(`${JSON.stringify(raw)} -> ${JSON.stringify(expected)}`, () => {
      expect(customerLine(raw)).toBe(expected);
    });
});
