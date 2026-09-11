import { describe, expect, test } from "bun:test";
import { SIGNATURE_MAX } from "@/modules/agents/text-caps";
import {
  alreadySigned,
  attachSignature,
  readSignatureConfig,
  SIGNATURE_DEFAULTS,
  signatureFor,
} from "@/modules/signature/service";
import {
  deliverReply,
  SPLIT_DEFAULTS,
  splitReplyParts,
} from "@/modules/split/service";

// Issue #599. A signature is operator policy, not content, and asking the model for it in the prompt
// produced it unevenly: measured over three rounds of the same twelve real customer emails,
// gpt-5.6-luna glued the closing to the last sentence in 2 of 10 replies and left it out of 3 of 3
// handoffs, because `handoff_to_human`'s schema asks for "a brief reply to the customer" and the
// schema wins over the system prompt.
//
// THE VOCABULARY IS CHATWOOT'S, and so are the bytes: `position` (top|bottom), `separator`
// (blank|--) and the delimiters `\n\n` and `\n\n--\n\n` are what `appendSignature` in the fork's
// reply box uses, so an operator who configures both meets the same thing twice.

const SIG = "— Gi, Guichê Web";

describe("attachSignature: it attaches to a CHUNK, never to the text", () => {
  test("the last balloon carries it, and only that one", () => {
    expect(
      attachSignature(["um", "dois", "três"], SIG, "bottom", "blank"),
    ).toEqual(["um", "dois", `três\n\n${SIG}`]);
  });

  test("with position top it is the FIRST balloon", () => {
    expect(attachSignature(["um", "dois"], SIG, "top", "blank")).toEqual([
      `${SIG}\n\num`,
      "dois",
    ]);
  });

  test("the separator is byte-identical to Chatwoot's", () => {
    // `appendSignature` builds `{ blank: '\n\n', '--': '\n\n--\n\n' }`. An operator who configures
    // the same separator in both places has to get the same bytes out of both.
    expect(attachSignature(["corpo"], SIG, "bottom", "blank")).toEqual([
      `corpo\n\n${SIG}`,
    ]);
    expect(attachSignature(["corpo"], SIG, "bottom", "--")).toEqual([
      `corpo\n\n--\n\n${SIG}`,
    ]);
  });

  test("THE REASON IT IS A CHUNK: no balloon is ever just the separator", () => {
    // Concatenated onto the reply BEFORE the cut, `--` produces a balloon whose entire body is `--`
    // and `blank` gives the signature a balloon of its own — with its own typing indicator and its
    // own pacing delay. This is that failure, reproduced through the real splitter.
    for (const separator of ["blank", "--"] as const) {
      const naive = `Primeiro parágrafo.\n\nSegundo parágrafo.${
        separator === "blank" ? "\n\n" : "\n\n--\n\n"
      }${SIG}`;
      const { chunks: wrong } = splitReplyParts(naive, SPLIT_DEFAULTS);
      expect(wrong.some((c) => c.trim() === "--" || c.trim() === SIG)).toBe(
        true,
      );

      const { chunks } = splitReplyParts(
        "Primeiro parágrafo.\n\nSegundo parágrafo.",
        SPLIT_DEFAULTS,
      );
      const right = attachSignature(chunks, SIG, "bottom", separator);
      expect(right).toHaveLength(chunks.length);
      expect(right.some((c) => c.trim() === "--" || c.trim() === SIG)).toBe(
        false,
      );
    }
  });

  test("THE OTHER REASON: at the maxChunks ceiling it does not change shape", () => {
    // The ceiling merges the overflow into the LAST chunk, so a signature concatenated upstream is
    // glued to the last paragraph on a long reply and stands alone on a short one — one
    // configuration rendering two ways depending on how long the answer happened to be.
    const cfg = { ...SPLIT_DEFAULTS, maxChunks: 3 };
    const long = Array.from({ length: 8 }, (_, i) => `Parágrafo ${i}.`).join(
      "\n\n",
    );
    const short = "Parágrafo único.";
    for (const body of [long, short]) {
      const { chunks } = splitReplyParts(body, cfg);
      const out = attachSignature(chunks, SIG, "bottom", "blank");
      expect(out[out.length - 1]?.endsWith(`\n\n${SIG}`)).toBe(true);
      expect(out).toHaveLength(chunks.length);
    }
  });

  test("a turn that said nothing is not signed", () => {
    // `reply = "   "` is truthy, so it passes the runtime's `if (!reply)` gate, and the splitter
    // trims it to ZERO chunks: nothing is sent today. Appended to the text instead of attached to a
    // chunk, the signature would be a lone message in a turn where the agent said nothing.
    const { chunks } = splitReplyParts("   ", SPLIT_DEFAULTS);
    expect(chunks).toHaveLength(0);
    expect(attachSignature(chunks, SIG, "bottom", "blank")).toEqual([]);
    // And the split-OFF path, which reaches the same function as one blank chunk, has to agree.
    expect(attachSignature(["   "], SIG, "bottom", "blank")).toEqual(["   "]);
    expect(attachSignature([""], SIG, "top", "--")).toEqual([""]);
  });

  test("no signature changes nothing at all", () => {
    for (const chunks of [["a"], ["a", "b"], []]) {
      expect(attachSignature(chunks, null, "bottom", "blank")).toEqual(chunks);
      expect(attachSignature(chunks, "", "top", "--")).toEqual(chunks);
    }
  });
});

describe("alreadySigned: a tail check across the whole reply, not containment", () => {
  test("an exact repetition at the end is not doubled", () => {
    expect(
      attachSignature([`corpo\n\n${SIG}`], SIG, "bottom", "blank"),
    ).toEqual([`corpo\n\n${SIG}`]);
  });

  test("a signature that merely APPEARS in the prose is still added", () => {
    // Containment — "does the body contain the signature" — silently drops the signature whenever
    // the text happens to mention it. Chatwoot asks `trimmedBody.endsWith(...)` for this reason.
    const body = `Como a ${SIG} já explicou, o prazo é de 7 dias.`;
    expect(attachSignature([body], SIG, "bottom", "blank")).toEqual([
      `${body}\n\n${SIG}`,
    ]);
  });

  test("BOTH ends are asked, across the whole reply", () => {
    // With `position: "top"` the signature goes on the FIRST chunk, and a model that signed itself
    // at the end put its copy on the LAST one. A check scoped to chunk zero finds nothing, prepends,
    // and the customer reads two closings.
    const chunks = ["primeiro", `último\n\n${SIG}`];
    expect(attachSignature(chunks, SIG, "top", "blank")).toEqual(chunks);
    expect(alreadySigned(chunks, SIG)).toBe(true);
    const atTop = [`${SIG}\n\nprimeiro`, "último"];
    expect(attachSignature(atTop, SIG, "bottom", "blank")).toEqual(atTop);
  });

  test("what it does NOT catch is a paraphrase, by design", () => {
    // Stated rather than implied: a model writing its own VARIANT of the closing still produces two,
    // and the fix for that is emptying the prompt, which is what this feature is for. Chatwoot has
    // the same limit.
    const paraphrase = "corpo\n\nAtenciosamente,\nGi";
    expect(attachSignature([paraphrase], SIG, "bottom", "blank")).toEqual([
      `${paraphrase}\n\n${SIG}`,
    ]);
  });

  test("trailing whitespace does not defeat it", () => {
    expect(
      attachSignature([`corpo\n\n${SIG}\n  \n`], SIG, "bottom", "blank"),
    ).toEqual([`corpo\n\n${SIG}\n  \n`]);
  });

  test("an empty signature is never 'already there'", () => {
    expect(alreadySigned(["qualquer coisa"], "")).toBe(false);
    expect(alreadySigned([], SIG)).toBe(false);
  });
});

describe("signatureFor: on or off, and the variables", () => {
  const cfg = { ...SIGNATURE_DEFAULTS, text: SIG };

  test("one text, on every channel: the config carries no channel at all", () => {
    // Deliberate, and the shape a later version would take is why. A channels ALLOWLIST answers only
    // half the operator's question, because the other half is that a closing written for e-mail is
    // not the closing they want on WhatsApp; the version that answers both is a signature PER
    // channel, and an allowlist is not a step toward it, it is a field that would be migrated away.
    expect(signatureFor(cfg)).toBe(SIG);
    expect(Object.keys(SIGNATURE_DEFAULTS).sort()).toEqual([
      "position",
      "separator",
      "text",
    ]);
  });

  test("empty text is the off switch, and the only one", () => {
    expect(signatureFor({ ...cfg, text: "" })).toBeNull();
  });

  test("the SAME placeholders the system prompt takes, through the same function", () => {
    expect(
      signatureFor(
        { ...cfg, text: "— {{nome_agente}}, {{nome_empresa}}" },
        {
          nome_agente: "Gi",
          nome_empresa: "Guichê Web",
        },
      ),
    ).toBe("— Gi, Guichê Web");
  });

  test("an unknown placeholder is LEFT STANDING, not blanked", () => {
    // What makes a typo visible on the customer's screen instead of silently deleting the
    // operator's text. `interpolatePromptVars`'s own rule, inherited rather than re-decided here.
    expect(
      signatureFor({ ...cfg, text: "— {{nome_agent}}" }, { nome_agente: "Gi" }),
    ).toBe("— {{nome_agent}}");
  });

  test("no vars at all leaves the text untouched", () => {
    expect(signatureFor({ ...cfg, text: "— {{nome_agente}}" })).toBe(
      "— {{nome_agente}}",
    );
  });
});

describe("readSignatureConfig", () => {
  test("the defaults are off, and top", () => {
    // `top` is Chatwoot's own default (the fork's `signature_position`), so an operator who
    // configures both meets the same default twice.
    expect(readSignatureConfig({})).toEqual(SIGNATURE_DEFAULTS);
    expect(readSignatureConfig(undefined)).toEqual(SIGNATURE_DEFAULTS);
    expect(SIGNATURE_DEFAULTS.position).toBe("top");
    expect(SIGNATURE_DEFAULTS.text).toBe("");
  });

  test("it reads what the operator wrote", () => {
    expect(
      readSignatureConfig({
        signature: { text: `  ${SIG}  `, position: "bottom", separator: "--" },
      }),
    ).toEqual({ text: SIG, position: "bottom", separator: "--" });
  });

  test("a value of another shape falls back instead of travelling", () => {
    // The bag is operator-editable through the REST API as well as the UI, so a wrong shape is a
    // thing that happens rather than a thing that cannot.
    expect(
      readSignatureConfig({
        signature: { text: 42, position: "middle", separator: "***" },
      }),
    ).toEqual(SIGNATURE_DEFAULTS);
  });

  test("a signature past the cap is clipped on the way OUT, not on the way in", () => {
    // Same rule every other operator-authored text in the bag follows: the row keeps what was
    // written and only the copy that reaches the customer is bounded (modules/agents/text-caps.ts).
    const long = "x".repeat(SIGNATURE_MAX + 50);
    expect(readSignatureConfig({ signature: { text: long } }).text.length).toBe(
      SIGNATURE_MAX,
    );
  });
});

describe("deliverReply: what the customer actually receives", () => {
  function stub(rec: { sent: string[] }) {
    return {
      sendMessage: async (_c: number, content: string) => {
        rec.sent.push(content);
        return {};
      },
      toggleTyping: async () => {},
    } as unknown as Parameters<typeof deliverReply>[0];
  }
  const noSleep = async () => {};
  const sig = {
    text: SIG,
    position: "bottom" as const,
    separator: "--" as const,
  };

  test("split ON: the last balloon is signed and no balloon is the separator", async () => {
    const rec = { sent: [] as string[] };
    await deliverReply(
      stub(rec),
      1,
      "Primeiro parágrafo.\n\nSegundo parágrafo.",
      SPLIT_DEFAULTS,
      noSleep,
      undefined,
      undefined,
      null,
      sig,
    );
    expect(rec.sent).toEqual([
      "Primeiro parágrafo.",
      `Segundo parágrafo.\n\n--\n\n${SIG}`,
    ]);
  });

  test("split OFF: the one message is signed, by the same function", async () => {
    const rec = { sent: [] as string[] };
    await deliverReply(
      stub(rec),
      1,
      "Mensagem única.",
      { ...SPLIT_DEFAULTS, enabled: false },
      noSleep,
      undefined,
      undefined,
      null,
      sig,
    );
    expect(rec.sent).toEqual([`Mensagem única.\n\n--\n\n${SIG}`]);
  });

  test("no signature: byte-identical to today, on both paths", async () => {
    for (const cfg of [SPLIT_DEFAULTS, { ...SPLIT_DEFAULTS, enabled: false }]) {
      const withNull = { sent: [] as string[] };
      const without = { sent: [] as string[] };
      const body = "Primeiro parágrafo.\n\nSegundo parágrafo.";
      await deliverReply(
        stub(withNull),
        1,
        body,
        cfg,
        noSleep,
        undefined,
        undefined,
        null,
        null,
      );
      await deliverReply(stub(without), 1, body, cfg, noSleep);
      expect(withNull.sent).toEqual(without.sent);
    }
  });

  test("a whitespace reply stays silent, signature and all", async () => {
    const rec = { sent: [] as string[] };
    await deliverReply(
      stub(rec),
      1,
      "   ",
      SPLIT_DEFAULTS,
      noSleep,
      undefined,
      undefined,
      null,
      sig,
    );
    expect(rec.sent).toEqual([]);
  });
});

describe("dedupe asks the whole reply, not the chunks (review of #599)", () => {
  const MULTI = "— Gi\n\nGuichê Web";

  // The split is LOSSY for this question in two independent ways, and each cost a review round.
  test("a model signature that SPANS chunks is still caught", () => {
    const reply = `Resposta.\n\n${MULTI}`;
    const { chunks } = splitReplyParts(reply, SPLIT_DEFAULTS);
    expect(chunks.length).toBeGreaterThan(2);
    expect(alreadySigned(chunks, MULTI, reply)).toBe(true);
    expect(attachSignature(chunks, MULTI, "bottom", "blank", reply)).toEqual(
      chunks,
    );
  });

  test("and at the top, for position top", () => {
    const reply = `${MULTI}\n\nResposta.`;
    const { chunks } = splitReplyParts(reply, SPLIT_DEFAULTS);
    expect(alreadySigned(chunks, MULTI, reply)).toBe(true);
    expect(attachSignature(chunks, MULTI, "top", "blank", reply)).toEqual(
      chunks,
    );
  });

  test("an INDENTED line inside the signature survives the comparison", () => {
    // The second loss: `splitReplyParts` trims every paragraph, so a signature whose second line is
    // indented comes back without the indentation. Reassembling from the separators recovered the
    // newlines and not this, which is why the caller passes the reply itself.
    const indented = "— Gi\n\n  Guichê Web";
    const reply = `Resposta.\n\n${indented}`;
    const { chunks } = splitReplyParts(reply, SPLIT_DEFAULTS);
    expect(chunks.join("\n\n")).not.toContain("  Guichê Web");
    expect(alreadySigned(chunks, indented, reply)).toBe(true);
    expect(attachSignature(chunks, indented, "bottom", "blank", reply)).toEqual(
      chunks,
    );
  });

  test("the same signature in the MIDDLE is not a match", () => {
    // Still a tail check over the whole reply, not containment: the rule did not get looser.
    const reply = `Resposta.\n\n${MULTI}\n\nMais uma coisa.`;
    const { chunks } = splitReplyParts(reply, SPLIT_DEFAULTS);
    expect(alreadySigned(chunks, MULTI, reply)).toBe(false);
  });

  test("a one-message caller needs no whole", () => {
    expect(alreadySigned([`corpo\n\n${MULTI}`], MULTI)).toBe(true);
  });
});

describe("the render options travel with the variables (review of #599)", () => {
  test("a schedule variable resolves, instead of going out literal on every message", async () => {
    // The map alone is half the answer: `interpolatePromptVars` reads the schedule and the instant
    // off `opts`, so a caller that passed only the vars rendered this literally to the customer.
    const cfg = {
      ...SIGNATURE_DEFAULTS,
      text: "— Gi · {{horario_atendimento}}",
    };
    const schedule = {
      timezone: "America/Sao_Paulo",
      windows: [{ day: 1, start: "09:00", end: "18:00" }],
    };
    const out = signatureFor(cfg, {}, {
      availability: { schedule },
      now: new Date("2026-09-14T13:00:00Z"),
    } as Parameters<typeof signatureFor>[2]);
    expect(out).not.toBeNull();
    expect(out).not.toContain("{{horario_atendimento}}");
  });

  test("without options the same name stays literal rather than blank", () => {
    // The failure this guards is silent deletion, not a literal placeholder: a name the caller
    // cannot answer must stay visible so the operator sees it, which is the prompt's own rule.
    expect(
      signatureFor(
        { ...SIGNATURE_DEFAULTS, text: "— {{horario_atendimento}}" },
        {},
      ),
    ).toBe("— {{horario_atendimento}}");
  });
});
