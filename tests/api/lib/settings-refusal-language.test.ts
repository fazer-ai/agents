import { describe, expect, test } from "bun:test";
import { refusalBody } from "@/api/lib/refusal";
import type { AppError } from "@/lib/errors";
import {
  assertSettingsClosedValues,
  InvalidSignatureChoiceError,
  InvalidSignatureSwitchError,
} from "@/modules/agents/service";

// A settings refusal reads in ONE language, the caller's: the sentence and every phrase it quotes
// (`a number of at least 0`, `one of ...`, a type name). A pt-BR console must never read
// "espera a number of at least 0, não -1".

const ENGLISH = [
  "expects",
  "a number",
  "at least",
  "greater than",
  " not ",
  "got",
  "one of",
  "a value",
  "matching",
];
const PORTUGUESE = [
  "espera",
  "não",
  "pelo menos",
  "maior que",
  "número",
  "agente",
  "gravado",
  "um de",
  "um valor",
];

// Identifiers in backticks are the server's vocabulary, the same in every language.
const prose = (s: string) => s.replace(/`[^`]*`/g, "``").toLowerCase();

function refusalOf(settings: unknown, stored: unknown = {}): AppError {
  try {
    assertSettingsClosedValues(settings, stored);
  } catch (e) {
    return e as AppError;
  }
  throw new Error("expected a refusal");
}

interface Row {
  name: string;
  error: () => AppError;
  // What the sentence must name in either language.
  mentions: string[];
  // What the sentence must say in each language, beyond the shared mentions.
  says?: { "pt-BR": string[]; en: string[] };
}

const ROWS: Row[] = [
  {
    name: "a number below an inclusive minimum (the observer's burst window)",
    error: () => refusalOf({ monitoring: { debounce: { windowSeconds: -1 } } }),
    mentions: ["monitoring.debounce.windowSeconds", "0", "-1"],
  },
  {
    name: "a number at an exclusive minimum (the contact authorization's handoff team)",
    error: () => refusalOf({ contactAuth: { handoffTeamId: 0 } }),
    mentions: ["contactAuth.handoffTeamId", "0"],
    says: { "pt-BR": ["maior que 0"], en: ["greater than 0"] },
  },
  {
    name: "a value outside a closed list",
    error: () => refusalOf({ monitoring: { engine: "nope" } }),
    mentions: ["monitoring.engine", '"nope"'],
  },
  {
    name: "a value of the wrong type",
    error: () =>
      refusalOf({ monitoring: { debounce: { windowSeconds: "ten" } } }),
    mentions: ["monitoring.debounce.windowSeconds", '"ten"'],
  },
  {
    name: "a value outside a pattern",
    error: () => refusalOf({ stt: { language: "portuguese" } }),
    mentions: ["stt.language", '"portuguese"'],
  },
  {
    name: "the signature switch",
    error: () => new InvalidSignatureSwitchError("string"),
    mentions: ["signature.enabled", "string"],
  },
  {
    name: "a signature choice",
    error: () =>
      new InvalidSignatureChoiceError(
        "position",
        ["top", "bottom"],
        '"middle"',
      ),
    mentions: ["signature.position", '"top"', '"middle"'],
  },
];

describe("a settings refusal reads in one language", () => {
  for (const row of ROWS) {
    test(`pt-BR: ${row.name}`, () => {
      const { error } = refusalBody(row.error(), "pt-BR");
      for (const frag of ENGLISH) expect(prose(error)).not.toContain(frag);
      for (const m of row.mentions) expect(error).toContain(m);
      for (const m of row.says?.["pt-BR"] ?? []) expect(error).toContain(m);
    });
    test(`en: ${row.name}`, () => {
      const { error } = refusalBody(row.error(), "en");
      for (const frag of PORTUGUESE) expect(prose(error)).not.toContain(frag);
      for (const m of row.mentions) expect(error).toContain(m);
      for (const m of row.says?.en ?? []) expect(error).toContain(m);
    });
  }

  test("an exclusive minimum says greater than, an inclusive one does not", () => {
    const exclusive = refusalBody(
      refusalOf({ contactAuth: { handoffTeamId: 0 } }),
      "pt-BR",
    ).error;
    const inclusive = refusalBody(
      refusalOf({ monitoring: { debounce: { windowSeconds: -1 } } }),
      "pt-BR",
    ).error;
    expect(exclusive).toContain("maior que 0");
    expect(inclusive).not.toContain("maior que 0");
  });
});
