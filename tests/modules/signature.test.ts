import { describe, expect, test } from "bun:test";
import { SIGNATURE_MAX } from "@/modules/agents/text-caps";
import {
  alreadySigned,
  attachSignature,
  readSignatureConfig,
  SIGNATURE_DEFAULTS,
  type SignaturePosition,
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
      attachSignature(["um", "dois", "três"], SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual(["um", "dois", `três\n\n${SIG}`]);
  });

  test("with position top it is the FIRST balloon", () => {
    expect(
      attachSignature(["um", "dois"], SIG, {
        position: "top",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual([`${SIG}\n\num`, "dois"]);
  });

  test("the separator is byte-identical to Chatwoot's", () => {
    // `appendSignature` builds `{ blank: '\n\n', '--': '\n\n--\n\n' }`. An operator who configures
    // the same separator in both places has to get the same bytes out of both.
    expect(
      attachSignature(["corpo"], SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual([`corpo\n\n${SIG}`]);
    expect(
      attachSignature(["corpo"], SIG, {
        position: "bottom",
        separator: "--",
        frequency: "once",
      }),
    ).toEqual([`corpo\n\n--\n\n${SIG}`]);
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
      const right = attachSignature(chunks, SIG, {
        position: "bottom",
        separator,
        frequency: "once",
      });
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
      const out = attachSignature(chunks, SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      });
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
    expect(
      attachSignature(chunks, SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual([]);
    // And the split-OFF path, which reaches the same function as one blank chunk, has to agree.
    expect(
      attachSignature(["   "], SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual(["   "]);
    expect(
      attachSignature([""], SIG, {
        position: "top",
        separator: "--",
        frequency: "once",
      }),
    ).toEqual([""]);
  });

  test("no signature changes nothing at all", () => {
    for (const chunks of [["a"], ["a", "b"], []]) {
      expect(
        attachSignature(chunks, null, {
          position: "bottom",
          separator: "blank",
          frequency: "once",
        }),
      ).toEqual(chunks);
      expect(
        attachSignature(chunks, "", {
          position: "top",
          separator: "--",
          frequency: "once",
        }),
      ).toEqual(chunks);
    }
  });
});

describe("alreadySigned: a tail check across the whole reply, not containment", () => {
  test("an exact repetition at the end is not doubled", () => {
    expect(
      attachSignature([`corpo\n\n${SIG}`], SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual([`corpo\n\n${SIG}`]);
  });

  test("a signature that merely APPEARS in the prose is still added", () => {
    // Containment — "does the body contain the signature" — silently drops the signature whenever
    // the text happens to mention it. Chatwoot asks `trimmedBody.endsWith(...)` for this reason.
    const body = `Como a ${SIG} já explicou, o prazo é de 7 dias.`;
    expect(
      attachSignature([body], SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual([`${body}\n\n${SIG}`]);
  });

  test("BOTH ends are asked, across the whole reply", () => {
    // With `position: "top"` the signature goes on the FIRST chunk, and a model that signed itself
    // at the end put its copy on the LAST one. A check scoped to chunk zero finds nothing, prepends,
    // and the customer reads two closings.
    const chunks = ["primeiro", `último\n\n${SIG}`];
    expect(
      attachSignature(chunks, SIG, {
        position: "top",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual(chunks);
    expect(alreadySigned(chunks, SIG)).toBe(true);
    const atTop = [`${SIG}\n\nprimeiro`, "último"];
    expect(
      attachSignature(atTop, SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual(atTop);
  });

  test("what it does NOT catch is a paraphrase, by design", () => {
    // Stated rather than implied: a model writing its own VARIANT of the closing still produces two,
    // and the fix for that is emptying the prompt, which is what this feature is for. Chatwoot has
    // the same limit.
    const paraphrase = "corpo\n\nAtenciosamente,\nGi";
    expect(
      attachSignature([paraphrase], SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual([`${paraphrase}\n\n${SIG}`]);
  });

  test("trailing whitespace does not defeat it", () => {
    expect(
      attachSignature([`corpo\n\n${SIG}\n  \n`], SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "once",
      }),
    ).toEqual([`corpo\n\n${SIG}\n  \n`]);
  });

  test("an empty signature is never 'already there'", () => {
    expect(alreadySigned(["qualquer coisa"], "")).toBe(false);
    expect(alreadySigned([], SIG)).toBe(false);
  });
});

describe("signatureFor: on or off, and the variables", () => {
  // `enabled: true` since #612: these cases are about what an ON signature renders.
  const cfg = { ...SIGNATURE_DEFAULTS, enabled: true, text: SIG };

  test("one text, on every channel: the config carries no channel at all", () => {
    // Deliberate, and the shape a later version would take is why. A channels ALLOWLIST answers only
    // half the operator's question, because the other half is that a closing written for e-mail is
    // not the closing they want on WhatsApp; the version that answers both is a signature PER
    // channel, and an allowlist is not a step toward it, it is a field that would be migrated away.
    expect(signatureFor(cfg)).toBe(SIG);
    expect(Object.keys(SIGNATURE_DEFAULTS).sort()).toEqual([
      "enabled",
      "frequency",
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
        signature: {
          enabled: true,
          text: `  ${SIG}  `,
          position: "bottom",
          separator: "--",
        },
      }),
    ).toEqual({
      enabled: true,
      text: SIG,
      position: "bottom",
      separator: "--",
      frequency: "once",
    });
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
    frequency: "once" as const,
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
    expect(
      attachSignature(
        chunks,
        MULTI,
        { position: "bottom", separator: "blank", frequency: "once" },
        reply,
      ),
    ).toEqual(chunks);
  });

  test("and at the top, for position top", () => {
    const reply = `${MULTI}\n\nResposta.`;
    const { chunks } = splitReplyParts(reply, SPLIT_DEFAULTS);
    expect(alreadySigned(chunks, MULTI, reply)).toBe(true);
    expect(
      attachSignature(
        chunks,
        MULTI,
        { position: "top", separator: "blank", frequency: "once" },
        reply,
      ),
    ).toEqual(chunks);
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
    expect(
      attachSignature(
        chunks,
        indented,
        { position: "bottom", separator: "blank", frequency: "once" },
        reply,
      ),
    ).toEqual(chunks);
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
      enabled: true,
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
        {
          ...SIGNATURE_DEFAULTS,
          enabled: true,
          text: "— {{horario_atendimento}}",
        },
        {},
      ),
    ).toBe("— {{horario_atendimento}}");
  });
});

// A SIGNATURE IS A LINE, NOT A PREFIX.
//
// Round 12 of the review: `startsWith`/`endsWith` on the raw string reads any reply whose first
// word merely BEGINS with the signature as already signed. "Ana" against "Analisei o seu pedido"
// matches, and the customer gets a reply with no closing at all — the exact failure this feature
// exists to prevent, caused by the guard meant to prevent its twin. A short signature is a first
// name, which is the common case, so this is not an exotic input.
describe("the dedupe asks for a whole line, not a prefix", () => {
  const sign = (text: string, signature: string, position: SignaturePosition) =>
    attachSignature([text], signature, {
      position,
      separator: "blank",
      frequency: "once",
    });

  test("a word that merely starts with the signature is not a signature", () => {
    expect(
      sign("Analisei o seu pedido e está tudo certo.", "Ana", "top"),
    ).toEqual(["Ana\n\nAnalisei o seu pedido e está tudo certo."]);
  });

  // The mirror case, and the one that reads most like real prose: the signature's own name is the
  // last word of a sentence that mentions the agent instead of signing off as one.
  test("the name mentioned mid-sentence at the end is not a signature", () => {
    expect(sign("Se precisar, é só chamar o Alex", "Alex", "bottom")).toEqual([
      "Se precisar, é só chamar o Alex\n\nAlex",
    ]);
  });

  // The other half stays true: a real repetition is still caught, at either end.
  test("the signature on its own line is still recognised at the top", () => {
    expect(sign("Ana\n\nAnalisei o seu pedido.", "Ana", "top")).toEqual([
      "Ana\n\nAnalisei o seu pedido.",
    ]);
  });

  test("the signature on its own line is still recognised at the bottom", () => {
    expect(sign("Analisei o seu pedido.\n\nAna", "Ana", "bottom")).toEqual([
      "Analisei o seu pedido.\n\nAna",
    ]);
  });

  // A single newline counts too: the model writing its own closing does not have to leave a blank
  // line, and the question is whether the line IS the signature, not how it was spaced.
  test("one newline is boundary enough", () => {
    expect(sign("Analisei o seu pedido.\nAna", "Ana", "bottom")).toEqual([
      "Analisei o seu pedido.\nAna",
    ]);
  });

  // And a reply that is nothing but the signature is signed, with no boundary to find.
  test("a reply that is only the signature is already signed", () => {
    expect(sign("Ana", "Ana", "bottom")).toEqual(["Ana"]);
  });
});

// ===== #612: THE SWITCH =====
//
// Written against the ISSUE, before the fix, and before reading the sealed scenarios in detail.
// Three properties the issue states, each of which loses operator data if it is wrong.
describe("turning the signature off without deleting it (#612)", () => {
  const SIG = "Atenciosamente,\nAlex | Minha Empresa";

  // THE POINT OF THE WHOLE ISSUE. Off has to be a state, not an erasure.
  test("off keeps the text, and on gives it back byte for byte", () => {
    const on = { ...SIGNATURE_DEFAULTS, enabled: true, text: SIG };
    const off = { ...on, enabled: false };
    expect(signatureFor(off)).toBeNull();
    expect(off.text).toBe(SIG);
    expect(signatureFor({ ...off, enabled: true })).toBe(SIG);
  });

  // An enabled block with nothing written signs nothing: an operator who has not finished, not an
  // error. Both answers are needed before a customer sees anything.
  test("on with an empty text still signs nothing", () => {
    expect(
      signatureFor({ ...SIGNATURE_DEFAULTS, enabled: true, text: "" }),
    ).toBeNull();
    expect(
      signatureFor({ ...SIGNATURE_DEFAULTS, enabled: true, text: "   " }),
    ).toBeNull();
  });

  // THE MIGRATION PROPERTY, and the one that silently destroys work if it is wrong. Every agent
  // configured under #599 has text and no flag, and meant ON. Reading the absence as off would
  // unsign all of them on the next load, with nobody touching anything.
  describe("a bag written before the switch existed", () => {
    test("text and no flag reads as on", () => {
      const cfg = readSignatureConfig({
        signature: { text: SIG, position: "bottom", separator: "--" },
      });
      expect(cfg.enabled).toBe(true);
      // and it still signs, which is the part the customer sees
      expect(signatureFor(cfg)).toBe(SIG);
    });

    test("no text and no flag reads as off", () => {
      expect(readSignatureConfig({ signature: { text: "" } }).enabled).toBe(
        false,
      );
      expect(
        readSignatureConfig({ signature: { text: "  \n " } }).enabled,
      ).toBe(false);
    });

    test("no signature block at all is off", () => {
      expect(readSignatureConfig({}).enabled).toBe(false);
      expect(readSignatureConfig(null).enabled).toBe(false);
    });
  });

  // An explicit flag is the operator's own answer and is never second-guessed from the text.
  test("an explicit flag wins over the text, in both directions", () => {
    expect(
      readSignatureConfig({ signature: { enabled: false, text: SIG } }).enabled,
    ).toBe(false);
    expect(
      readSignatureConfig({ signature: { enabled: true, text: "" } }).enabled,
    ).toBe(true);
  });

  // A non-boolean is not an answer: it falls back to the same reading as an absent flag, the way
  // every other field in this reader falls back rather than travelling.
  test("a flag of another shape falls back instead of travelling", () => {
    const cfg = readSignatureConfig({
      signature: { enabled: "yes", text: SIG },
    });
    expect(cfg.enabled).toBe(true);
    expect(
      readSignatureConfig({ signature: { enabled: 0, text: "" } }).enabled,
    ).toBe(false);
  });

  test("the defaults carry the switch, off", () => {
    expect(SIGNATURE_DEFAULTS.enabled).toBe(false);
    expect(Object.keys(SIGNATURE_DEFAULTS).sort()).toEqual([
      "enabled",
      "frequency",
      "position",
      "separator",
      "text",
    ]);
  });
});

// Issue #616. POSITION AND REPETITION ARE THE SAME DECISION SEEN FROM TWO SIDES, and #599 answered
// only one of them. A signature at the BOTTOM is a farewell, said once; a signature at the TOP is a
// badge, and the question it answers ("who is talking to me") comes back on every balloon, because
// on WhatsApp each balloon is an independent message with its own notification and its own preview.
// The first version offered `top` and then treated it as a farewell: on a three-balloon reply the
// customer read the agent's name once and got two anonymous messages after it.
//
// The fork's own human signature already repeats — `appendSignature` runs in the reply box at SEND
// time, so a human who sends three messages signs three — and an agent signing once per turn is
// inconsistent with the person sitting next to it in the same conversation.
describe("frequency: every message of the turn, or one of them", () => {
  const THREE = [
    "Boa tarde, verifiquei aqui.",
    "O seu pedido foi confirmado.",
    "Qualquer dúvida, é só chamar.",
  ];

  test("all + top: every balloon opens with the badge, and no balloon is added", () => {
    expect(
      attachSignature(THREE, SIG, {
        position: "top",
        separator: "--",
        frequency: "all",
      }),
    ).toEqual([
      `${SIG}\n\n--\n\nBoa tarde, verifiquei aqui.`,
      `${SIG}\n\n--\n\nO seu pedido foi confirmado.`,
      `${SIG}\n\n--\n\nQualquer dúvida, é só chamar.`,
    ]);
  });

  test("all + bottom: every balloon closes with it", () => {
    expect(
      attachSignature(THREE, SIG, {
        position: "bottom",
        separator: "blank",
        frequency: "all",
      }),
    ).toEqual([
      `Boa tarde, verifiquei aqui.\n\n${SIG}`,
      `O seu pedido foi confirmado.\n\n${SIG}`,
      `Qualquer dúvida, é só chamar.\n\n${SIG}`,
    ]);
  });

  // The whole point of keeping the old value: an operator who wants the farewell keeps what #599
  // shipped, byte for byte, and nothing about this change reaches them.
  test("once: byte-identical to what #599 delivers, in both positions", () => {
    expect(
      attachSignature(THREE, SIG, {
        position: "top",
        separator: "--",
        frequency: "once",
      }),
    ).toEqual([
      `${SIG}\n\n--\n\nBoa tarde, verifiquei aqui.`,
      "O seu pedido foi confirmado.",
      "Qualquer dúvida, é só chamar.",
    ]);
    expect(
      attachSignature(THREE, SIG, {
        position: "bottom",
        separator: "--",
        frequency: "once",
      }),
    ).toEqual([
      "Boa tarde, verifiquei aqui.",
      "O seu pedido foi confirmado.",
      `Qualquer dúvida, é só chamar.\n\n--\n\n${SIG}`,
    ]);
  });

  // THE DEDUPE BECOMES A PER-BALLOON QUESTION, and it has to. `alreadySigned` asks about the reply
  // as it AROSE, at both ends, which is the right question for `once` and the wrong shape for
  // `all`: a model that signed itself at the end would suppress the badge on the other three
  // balloons, which is the failure this feature exists to prevent, produced by the guard against
  // its twin. Same rule as #599 otherwise, including the line boundary.
  test("all: the balloon the model signed keeps ONE, and the others still get theirs", () => {
    const fim = [...THREE.slice(0, 2), SIG];
    const out = attachSignature(fim, SIG, {
      position: "top",
      separator: "blank",
      frequency: "all",
    });
    expect(out).toEqual([
      `${SIG}\n\nBoa tarde, verifiquei aqui.`,
      `${SIG}\n\nO seu pedido foi confirmado.`,
      SIG,
    ]);
    expect(out.join("\n\n").split(SIG).length - 1).toBe(3);
  });

  test("all: the model's copy at the START is left alone, bottom", () => {
    const inicio = [SIG, ...THREE.slice(0, 2)];
    const out = attachSignature(inicio, SIG, {
      position: "bottom",
      separator: "blank",
      frequency: "all",
    });
    expect(out).toEqual([
      SIG,
      `Boa tarde, verifiquei aqui.\n\n${SIG}`,
      `O seu pedido foi confirmado.\n\n${SIG}`,
    ]);
  });

  // The `once` rule still asks the WHOLE reply, because with `once` one copy anywhere is already
  // the one copy the customer should read.
  test("once: a reply the model signed at the end gets nothing added", () => {
    const fim = [...THREE.slice(0, 2), SIG];
    expect(
      attachSignature(
        fim,
        SIG,
        { position: "top", separator: "blank", frequency: "once" },
        fim.join("\n\n"),
      ),
    ).toEqual(fim);
  });

  test("a silent turn stays silent with all: no balloon is invented", () => {
    for (const chunks of [[], ["   "], ["  ", "\n "]]) {
      expect(
        attachSignature(chunks, SIG, {
          position: "top",
          separator: "--",
          frequency: "all",
        }),
      ).toEqual(chunks);
    }
  });

  // A SIGNATURE THAT SPANS A BLANK LINE is cut by the same paragraph rule the reply is, so the
  // model's own copy of it occupies SEVERAL balloons and no single one holds all of it. The
  // per-balloon check therefore recognises none of them, and every fragment would get a second
  // signature glued to it. This is #599's split-boundary defect, reintroduced by the loop that
  // replaced the index; review round 1 of #617 caught it. The whole-reply question still answers
  // WHETHER there is a copy, and matching its paragraphs against the edge balloons answers WHICH.
  test("all: the model's multi-paragraph copy is left whole, and the rest is signed", () => {
    const MULTI = "Alex\n\nMinha Empresa";
    const fim = ["Resposta.", "Alex", "Minha Empresa"];
    expect(
      attachSignature(
        fim,
        MULTI,
        { position: "bottom", separator: "blank", frequency: "all" },
        fim.join("\n\n"),
      ),
    ).toEqual([`Resposta.\n\n${MULTI}`, "Alex", "Minha Empresa"]);

    const inicio = ["Alex", "Minha Empresa", "Resposta."];
    expect(
      attachSignature(
        inicio,
        MULTI,
        { position: "top", separator: "blank", frequency: "all" },
        inicio.join("\n\n"),
      ),
    ).toEqual(["Alex", "Minha Empresa", `${MULTI}\n\nResposta.`]);
  });

  // The guard is scoped to a reply the whole-reply check says IS signed. A balloon that merely
  // repeats one paragraph of the signature somewhere in the middle is prose, and prose gets signed.
  test("all: a lone paragraph that looks like half the signature is still signed", () => {
    const MULTI = "Alex\n\nMinha Empresa";
    const chunks = ["Bom dia.", "Alex", "Até logo."];
    expect(
      attachSignature(
        chunks,
        MULTI,
        { position: "top", separator: "blank", frequency: "all" },
        chunks.join("\n\n"),
      ),
    ).toEqual([
      `${MULTI}\n\nBom dia.`,
      `${MULTI}\n\nAlex`,
      `${MULTI}\n\nAté logo.`,
    ]);
  });

  // A FRAGMENT DOES NOT HAVE TO OWN ITS WHOLE BALLOON. When the model glues its closing to the last
  // line of prose, one balloon holds content AND half the signature while the next holds the other
  // half alone. Requiring every fragment to be an entire balloon rejected the run and signed both;
  // review round 2 of #617. The balloon that is ENTIRELY a fragment is left alone, and the one that
  // carries content is still signed, because suppressing a signature on a balloon the customer
  // reads as content is the failure this feature exists to prevent.
  test("all: a balloon that is entirely a fragment is skipped, one with content is not", () => {
    const MULTI = "Alex\n\nMinha Empresa";
    const chunks = ["Resposta.\nAlex", "Minha Empresa"];
    const out = attachSignature(
      chunks,
      MULTI,
      { position: "bottom", separator: "blank", frequency: "all" },
      "Resposta.\nAlex\n\nMinha Empresa",
    );
    expect(out[1]).toBe("Minha Empresa");
    expect(out[0]).toBe(`Resposta.\nAlex\n\n${MULTI}`);
  });

  // A COPY AT EACH END is two copies, and the walk only ever reaches one of them: it stops the
  // moment the accumulation is the whole signature. The per-balloon question is what covers the
  // other, and it is not redundant with the walk for exactly this reason.
  test("all: a balloon that IS the signature is left alone wherever it sits", () => {
    const chunks = [SIG, "Resposta.", SIG];
    expect(
      attachSignature(
        chunks,
        SIG,
        { position: "top", separator: "blank", frequency: "all" },
        chunks.join("\n\n"),
      ),
    ).toEqual([SIG, `${SIG}\n\nResposta.`, SIG]);
  });

  // THE SPLITTER MANGLES THE MODEL'S COPY IN MORE WAYS THAN ONE, and chasing them one at a time is
  // how this module collected three near-identical defects. The rule below is one question asked of
  // the whole family: with the reply's own ends saying a copy EXISTS, walk in from that end over
  // balloons that are still a suffix (or prefix) of the signature with whitespace collapsed. Every
  // way the splitter can cut, trim, merge or rejoin is a whitespace difference, so every one of
  // them is the same question. Rounds 1, 3 and 4 of the review, in one place.
  test("all: a signature the splitter cut BY SENTENCE is recognised in both balloons", () => {
    const LONG =
      "Atenciosamente, Alex da Minha Empresa. Estamos aqui de segunda a sexta, das nove as seis.";
    // What `splitReplyParts` returns for this reply at maxChars 80, measured.
    const chunks = [
      "Atenciosamente, Alex da Minha Empresa.",
      "Estamos aqui de segunda a sexta, das nove as seis.",
    ];
    expect(
      attachSignature(
        chunks,
        LONG,
        { position: "bottom", separator: "blank", frequency: "all" },
        LONG,
      ),
    ).toEqual(chunks);
  });

  test("all: a separator run the merge kept is still the same copy", () => {
    const WIDE = "Alex\n\n\n  Minha Empresa";
    // Measured: the merge keeps the original "\n\n\n" and trims the indentation.
    const chunks = ["Bom dia.", "Alex\n\n\nMinha Empresa"];
    expect(
      attachSignature(
        chunks,
        WIDE,
        { position: "bottom", separator: "blank", frequency: "all" },
        `Bom dia.\n\n${WIDE}`,
      ),
    ).toEqual([`Bom dia.\n\n${WIDE}`, "Alex\n\n\nMinha Empresa"]);
  });

  // THE maxChunks CEILING MERGES the overflow into the last balloon, and the merge rejoins the
  // paragraphs with a plain "\n\n" after trimming each one — so a signature with an INDENTED line
  // comes back without the indentation and matches neither the signature nor its paragraphs. That
  // is the same trimming invariant #599 hit twice; `once` survives it because it asks the original,
  // and the per-balloon question cannot. Round 3 of the review.
  //
  // The answer is to compare like with like: the balloon holds what the splitter made of the
  // signature, so the check asks about the signature put through the same normalisation.
  test("all: a copy merged at the ceiling is recognised despite the lost indentation", () => {
    const INDENTED = "Alex\n\n  Minha Empresa";
    // What `splitReplyParts` returns for this reply at maxChunks 2, measured.
    const chunks = ["Bom dia.", "Alex\n\nMinha Empresa"];
    expect(
      attachSignature(
        chunks,
        INDENTED,
        { position: "bottom", separator: "blank", frequency: "all" },
        `Bom dia.\n\n${INDENTED}`,
      ),
    ).toEqual([`Bom dia.\n\n${INDENTED}`, "Alex\n\nMinha Empresa"]);
  });

  // THE ORIGINAL IS THE AUTHORITY, not the chunk array, which is the same rule the whole-reply
  // dedupe is built on (#599): the split TRIMS and throws the separators away, so an array can
  // reassemble into something the model never wrote. Balloons that merely look like the signature's
  // paragraphs, in a reply the original says was never signed, are prose — and prose gets signed.
  test("all: balloons that reassemble into the signature are not a copy if the reply is not", () => {
    const MULTI = "Alex\n\nMinha Empresa";
    const chunks = ["Bom dia.", "Alex", "Minha Empresa"];
    expect(
      attachSignature(
        chunks,
        MULTI,
        { position: "top", separator: "blank", frequency: "all" },
        // One paragraph, cut by the SENTENCE rule: the balloons above are what it produced, and
        // "\n\n" never appeared in what the model wrote.
        "Bom dia. Alex Minha Empresa",
      ),
    ).toEqual([
      `${MULTI}\n\nBom dia.`,
      `${MULTI}\n\nAlex`,
      `${MULTI}\n\nMinha Empresa`,
    ]);
  });

  // A BLANK BALLOON IS NOT SIGNED, which is the loop's version of the whole-array guard above.
  // `splitReplyParts` never emits a blank chunk, so this cannot arise from the delivery path today
  // — but `attachSignature` is a pure function other callers hand arrays to, and signing a blank
  // one produces a balloon whose entire body is the signature, which is the exact shape the
  // attach-to-a-chunk design exists to prevent.
  test("all: a blank balloon in a mixed array is left alone", () => {
    expect(
      attachSignature(["Tem texto.", "   "], SIG, {
        position: "top",
        separator: "--",
        frequency: "all",
      }),
    ).toEqual([`${SIG}\n\n--\n\nTem texto.`, "   "]);
  });

  // The three single-message sends — split off, the handoff's farewell on the proactive path, the
  // follow-up — all call this with a one-element array, so the two frequencies cannot diverge
  // there. If they ever do, a follow-up starts carrying two signatures.
  test("on a one-element array the two frequencies are indistinguishable", () => {
    for (const position of ["top", "bottom"] as SignaturePosition[]) {
      const all = attachSignature(["Mensagem única."], SIG, {
        position,
        separator: "--",
        frequency: "all",
      });
      const once = attachSignature(["Mensagem única."], SIG, {
        position,
        separator: "--",
        frequency: "once",
      });
      expect(all).toEqual(once);
      expect(all.join("").split(SIG).length - 1).toBe(1);
    }
  });
});

describe("readSignatureConfig: the frequency an old bag never wrote", () => {
  // THE MIGRATION, and it is a behaviour change stated out loud rather than discovered: a bag
  // written under #599/#612 with `position: "top"` starts signing every balloon on deploy. The
  // position is where the operator's intent is already visible, so the default reads it instead of
  // asking the same question twice.
  test("no frequency: top means all, bottom means once", () => {
    expect(
      readSignatureConfig({ signature: { text: "Alex", position: "top" } })
        .frequency,
    ).toBe("all");
    expect(
      readSignatureConfig({ signature: { text: "Alex", position: "bottom" } })
        .frequency,
    ).toBe("once");
  });

  test("a value of another shape falls back the same way every other field does", () => {
    for (const bad of ["sempre", 1, null, {}, true]) {
      expect(
        readSignatureConfig({
          signature: { text: "Alex", position: "bottom", frequency: bad },
        }).frequency,
      ).toBe("once");
    }
  });

  test("a written frequency wins over the position it disagrees with", () => {
    expect(
      readSignatureConfig({
        signature: { text: "Alex", position: "top", frequency: "once" },
      }).frequency,
    ).toBe("once");
    expect(
      readSignatureConfig({
        signature: { text: "Alex", position: "bottom", frequency: "all" },
      }).frequency,
    ).toBe("all");
  });

  test("the default matches the default position", () => {
    expect(SIGNATURE_DEFAULTS.frequency).toBe("all");
    expect(SIGNATURE_DEFAULTS.position).toBe("top");
  });
});

describe("deliverReply with frequency: what the customer actually receives", () => {
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
  const BODY =
    "Boa tarde, verifiquei aqui.\n\nO seu pedido foi confirmado.\n\nQualquer dúvida, é só chamar.";

  test("all + top: three balloons, three badges, through the real delivery path", async () => {
    const rec = { sent: [] as string[] };
    await deliverReply(
      stub(rec),
      1,
      BODY,
      SPLIT_DEFAULTS,
      noSleep,
      undefined,
      undefined,
      null,
      { text: SIG, position: "top", separator: "--", frequency: "all" },
    );
    expect(rec.sent).toEqual([
      `${SIG}\n\n--\n\nBoa tarde, verifiquei aqui.`,
      `${SIG}\n\n--\n\nO seu pedido foi confirmado.`,
      `${SIG}\n\n--\n\nQualquer dúvida, é só chamar.`,
    ]);
  });

  // The balloon COUNT is the invariant the repetition must not touch: `seps` stays aligned with
  // `chunks` because attaching never adds or merges one.
  test("all + bottom: same balloon count as the same reply unsigned", async () => {
    const signed = { sent: [] as string[] };
    const bare = { sent: [] as string[] };
    await deliverReply(
      stub(signed),
      1,
      BODY,
      SPLIT_DEFAULTS,
      noSleep,
      undefined,
      undefined,
      null,
      { text: SIG, position: "bottom", separator: "blank", frequency: "all" },
    );
    await deliverReply(stub(bare), 1, BODY, SPLIT_DEFAULTS, noSleep);
    expect(signed.sent.length).toBe(bare.sent.length);
    expect(signed.sent).toEqual([
      `Boa tarde, verifiquei aqui.\n\n${SIG}`,
      `O seu pedido foi confirmado.\n\n${SIG}`,
      `Qualquer dúvida, é só chamar.\n\n${SIG}`,
    ]);
  });

  test("split OFF with all: one message, one signature", async () => {
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
      { text: SIG, position: "top", separator: "--", frequency: "all" },
    );
    expect(rec.sent).toEqual([`${SIG}\n\n--\n\nMensagem única.`]);
  });

  test("a silent turn with all sends nothing, on both split paths", async () => {
    for (const cfg of [SPLIT_DEFAULTS, { ...SPLIT_DEFAULTS, enabled: false }]) {
      const signed = { sent: [] as string[] };
      const bare = { sent: [] as string[] };
      await deliverReply(
        stub(signed),
        1,
        "   \n\n  ",
        cfg,
        noSleep,
        undefined,
        undefined,
        null,
        { text: SIG, position: "top", separator: "--", frequency: "all" },
      );
      await deliverReply(stub(bare), 1, "   \n\n  ", cfg, noSleep);
      expect(signed.sent).toEqual(bare.sent);
      for (const s of signed.sent) expect(s).not.toContain(SIG);
    }
  });
});
