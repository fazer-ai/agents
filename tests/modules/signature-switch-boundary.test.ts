import { describe, expect, test } from "bun:test";
import {
  assertSettingsSignature,
  InvalidSignatureChoiceError,
  InvalidSignatureSwitchError,
} from "@/modules/agents/service";
import { BEHAVIOR_PATCH_SHAPE } from "@/modules/agents/settings-schema";
import {
  SIGNATURE_CHOICES,
  SIGNATURE_FREQUENCIES,
  SIGNATURE_POSITIONS,
  SIGNATURE_SEPARATORS,
} from "@/modules/signature/domains";
import { readSignatureConfig } from "@/modules/signature/service";

// THE SWITCH IS REFUSED AT THE WRITE, not normalised in the reader (#612).
//
// The acceptance run measured what accepting-and-normalising costs: REST answered 200 to
// `enabled: "sim"` and GET echoed the string back, so a client reading the API saw one answer while
// the runtime signed on another. The switch's value is the only thing that says whether an agent is
// signing, so two answers to that question is one answer too many.
describe("assertSettingsSignature", () => {
  const ON = { signature: { enabled: true, text: "Alex" } };

  test("a boolean passes, both ways", () => {
    expect(() => assertSettingsSignature(ON, undefined)).not.toThrow();
    expect(() =>
      assertSettingsSignature({ signature: { enabled: false } }, undefined),
    ).not.toThrow();
  });

  // The pre-#612 bag: no flag at all, which the reader answers from the text. Not a bad value.
  test("an absent switch passes, because that is every bag written before it existed", () => {
    expect(() =>
      assertSettingsSignature({ signature: { text: "Alex" } }, undefined),
    ).not.toThrow();
    expect(() => assertSettingsSignature({}, undefined)).not.toThrow();
    expect(() => assertSettingsSignature(null, undefined)).not.toThrow();
  });

  test("a string is refused, naming the field", () => {
    let caught: unknown;
    try {
      assertSettingsSignature({ signature: { enabled: "sim" } }, undefined);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidSignatureSwitchError);
    const err = caught as InvalidSignatureSwitchError & {
      status?: number;
      field?: string;
    };
    expect(err.message).toContain("signature.enabled");
    expect(err.message).toContain("string");
  });

  test("a number and a null are refused too", () => {
    expect(() =>
      assertSettingsSignature({ signature: { enabled: 1 } }, undefined),
    ).toThrow(InvalidSignatureSwitchError);
    expect(() =>
      assertSettingsSignature({ signature: { enabled: null } }, undefined),
    ).toThrow(InvalidSignatureSwitchError);
  });

  // SCOPED TO WHAT THIS WRITE CHANGES, like every other rule in this family: a bad value already in
  // the row must not freeze a save that edits some other section, or one bad PATCH locks the agent
  // out of its own editor.
  test("a stored bad value does not block a save that leaves it alone", () => {
    const stored = { signature: { enabled: "sim" } };
    expect(() =>
      assertSettingsSignature({ signature: { enabled: "sim" } }, stored),
    ).not.toThrow();
  });

  test("but changing it to another bad value is still refused", () => {
    const stored = { signature: { enabled: "sim" } };
    expect(() =>
      assertSettingsSignature({ signature: { enabled: "nao" } }, stored),
    ).toThrow(InvalidSignatureSwitchError);
  });
});

// THE FREQUENCY IS REFUSED THE SAME WAY (#616), and the tie-breaker is what GET does rather than
// what the reader can cope with. `position` and `separator` normalise, so a wrong value there is
// harmless to the runtime — but the API echoes the settings bag AS STORED, so normalising leaves
// the operator's client reading "sempre" on a field the runtime answered as "all". #612 already
// settled that two answers to one question is one too many.
describe("assertSettingsSignature: the frequency", () => {
  test("both values pass", () => {
    for (const frequency of ["all", "once"]) {
      expect(() =>
        assertSettingsSignature({ signature: { frequency } }, undefined),
      ).not.toThrow();
    }
  });

  test("an absent frequency passes, because that is every bag written before it existed", () => {
    expect(() =>
      assertSettingsSignature({ signature: { text: "Alex" } }, undefined),
    ).not.toThrow();
  });

  test("a value outside the domain is refused, naming the field", () => {
    let caught: unknown;
    try {
      assertSettingsSignature(
        { signature: { frequency: "sempre" } },
        undefined,
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidSignatureChoiceError);
    const err = caught as InvalidSignatureChoiceError & {
      field?: string;
      statusCode?: number;
    };
    expect(err.field).toBe("signature.frequency");
    expect(err.statusCode).toBe(400);
    expect(err.message).toContain('"sempre"');
  });

  test("a number, a null and an object are refused too", () => {
    for (const bad of [1, null, {}, true]) {
      expect(() =>
        assertSettingsSignature({ signature: { frequency: bad } }, undefined),
      ).toThrow(InvalidSignatureChoiceError);
    }
  });

  // ONLY WHAT THIS WRITE INTRODUCES OR CHANGES, the scoping every rule in this family has: a bag
  // that already holds a bad value is re-sent untouched by every save that edits some other
  // section, and refusing those would freeze the agent on a field nobody is editing.
  test("a stored bad value re-sent unchanged does not block an unrelated save", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { frequency: "sempre", text: "Outro" } },
        { signature: { frequency: "sempre", text: "Alex" } },
      ),
    ).not.toThrow();
  });

  test("changing one bad value for another is still a change, and still refused", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { frequency: "toda" } },
        { signature: { frequency: "sempre" } },
      ),
    ).toThrow(InvalidSignatureChoiceError);
  });

  // The two guards are independent: a bad switch alongside a good frequency still throws the
  // switch's error, and a good switch does not excuse a bad frequency.
  test("the switch and the frequency are checked independently", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { enabled: "sim", frequency: "all" } },
        undefined,
      ),
    ).toThrow(InvalidSignatureSwitchError);
    expect(() =>
      assertSettingsSignature(
        { signature: { enabled: true, frequency: "sempre" } },
        undefined,
      ),
    ).toThrow(InvalidSignatureChoiceError);
  });
});

// THE TWO OLDER ENUMS, which #616 left un-guarded on purpose and filed as #618. Same hole as the
// frequency: the reader normalises `"esquerda"` to `"top"`, the runtime signs at the top, and GET
// echoes `"esquerda"`. Asked without naming an error class, so on the base (where nothing throws)
// these fail on the assertion rather than on an import.
describe("assertSettingsSignature: position and separator", () => {
  const refusal = (settings: unknown, stored: unknown) => {
    try {
      assertSettingsSignature(settings, stored);
    } catch (e) {
      return e as { field?: string; statusCode?: number; message: string };
    }
    return null;
  };

  test("every value the reader keeps passes", () => {
    for (const position of ["top", "bottom"]) {
      expect(refusal({ signature: { position } }, undefined)).toBeNull();
    }
    for (const separator of ["blank", "--"]) {
      expect(refusal({ signature: { separator } }, undefined)).toBeNull();
    }
  });

  test("an absent field passes: the reader answers it with the default", () => {
    expect(refusal({ signature: { text: "Alex" } }, undefined)).toBeNull();
  });

  test("a position outside the domain is refused, naming the field", () => {
    const err = refusal({ signature: { position: "esquerda" } }, undefined);
    expect(err?.statusCode).toBe(400);
    expect(err?.field).toBe("signature.position");
    expect(err?.message).toContain('"esquerda"');
  });

  test("a separator outside the domain is refused, naming the field", () => {
    const err = refusal({ signature: { separator: "~~" } }, undefined);
    expect(err?.statusCode).toBe(400);
    expect(err?.field).toBe("signature.separator");
  });

  test("a value of another type is refused too", () => {
    for (const bad of [42, null, {}, true, ["top"]]) {
      expect(refusal({ signature: { position: bad } }, undefined)?.field).toBe(
        "signature.position",
      );
      expect(refusal({ signature: { separator: bad } }, undefined)?.field).toBe(
        "signature.separator",
      );
    }
  });

  test("a stored bad value re-sent unchanged does not block an unrelated save", () => {
    const stored = { signature: { position: "esquerda", separator: "~~" } };
    expect(
      refusal(
        { signature: { position: "esquerda", separator: "~~", text: "Outro" } },
        stored,
      ),
    ).toBeNull();
  });

  // Per FIELD, not per block: fixing the separator of a legacy row does not require fixing its
  // position in the same save, and changing only one of them names only that one.
  test("changing one bad value for another is refused, and names only that field", () => {
    const stored = { signature: { position: "esquerda", separator: "~~" } };
    const err = refusal(
      { signature: { position: "direita", separator: "~~" } },
      stored,
    );
    expect(err?.field).toBe("signature.position");
  });

  test("correcting a stored bad value to a good one passes", () => {
    expect(
      refusal(
        { signature: { position: "bottom", separator: "~~" } },
        { signature: { position: "esquerda", separator: "~~" } },
      ),
    ).toBeNull();
  });
});

// THE DOMAIN IS THE READER'S, asked by execution rather than trusted from the constant. The boundary
// refuses what is not in `SIGNATURE_CHOICES`; that is only right if every value in it is one the
// reader KEEPS and a value outside it is one the reader REPLACES. A domain that grew on one side
// only would either refuse a value the runtime honours or accept one it ignores, the hole #618 was.
describe("the signature's domains are the reader's", () => {
  test("every allowed value round-trips through readSignatureConfig", () => {
    for (const [field, allowed] of Object.entries(SIGNATURE_CHOICES)) {
      for (const value of allowed) {
        const read = readSignatureConfig({ signature: { [field]: value } });
        expect({
          field,
          value,
          read: read[field as keyof typeof read],
        }).toEqual({ field, value, read: value });
      }
    }
  });

  test("a value outside the domain is replaced by the reader, so the boundary must refuse it", () => {
    for (const field of Object.keys(SIGNATURE_CHOICES)) {
      const read = readSignatureConfig({ signature: { [field]: "__fora__" } });
      expect(read[field as keyof typeof read]).not.toBe("__fora__");
    }
  });

  test("the table names every closed field of the block and nothing else", () => {
    expect(Object.keys(SIGNATURE_CHOICES).sort()).toEqual([
      "frequency",
      "position",
      "separator",
    ]);
    expect([
      ...SIGNATURE_POSITIONS,
      ...SIGNATURE_SEPARATORS,
      ...SIGNATURE_FREQUENCIES,
    ]).toHaveLength(6);
  });
});

// The three edges the mutation battery found untested, each a way the family's scoping can go wrong.
describe("assertSettingsSignature: what the stored-value exemption compares", () => {
  // BY VALUE. A legacy non-primitive arrives through JSON as a new object on every save, so a
  // reference comparison refuses the very re-send the exemption exists for.
  test("a stored non-primitive bad value re-sent unchanged saves", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { position: { lado: "esquerdo" }, text: "Outro" } },
        { signature: { position: { lado: "esquerdo" }, text: "Alex" } },
      ),
    ).not.toThrow();
    expect(() =>
      assertSettingsSignature(
        { signature: { enabled: { sim: true }, text: "Outro" } },
        { signature: { enabled: { sim: true }, text: "Alex" } },
      ),
    ).not.toThrow();
  });

  // ABSENT is not a value. A bag that stops naming the field over a stored bad value leaves it to the
  // reader's default; refusing would report "got undefined" about a field the caller never sent.
  test("a bag that omits the field over a stored bad value saves", () => {
    expect(() =>
      assertSettingsSignature(
        { signature: { text: "Alex" } },
        { signature: { position: "esquerda", separator: "~~" } },
      ),
    ).not.toThrow();
  });

  test("an array is reported as an array, not as an object", () => {
    let caught: unknown;
    try {
      assertSettingsSignature({ signature: { separator: ["--"] } }, undefined);
    } catch (e) {
      caught = e;
    }
    expect((caught as Error).message).toContain("got array");
  });
});

// THE MCP SCHEMA ASKS THE SAME DOMAINS. It already refused these on the base; what this pins is that it
// reads them from `domains.ts` rather than from a fourth copy that could drift.
describe("the MCP patch schema's signature enums are the domains", () => {
  const shape = BEHAVIOR_PATCH_SHAPE.signature;
  test("every allowed value parses and an outside value does not", () => {
    for (const [field, allowed] of Object.entries(SIGNATURE_CHOICES)) {
      for (const value of allowed) {
        expect(shape.safeParse({ [field]: value }).success).toBe(true);
      }
      for (const other of Object.values(SIGNATURE_CHOICES).flat()) {
        if ((allowed as readonly string[]).includes(other)) continue;
        expect({
          field,
          other,
          ok: shape.safeParse({ [field]: other }).success,
        }).toEqual({
          field,
          other,
          ok: false,
        });
      }
    }
  });
});
