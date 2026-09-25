import { describe, expect, test } from "bun:test";
import { readTtsConfig } from "@/modules/tts/settings";
import { SPEAKABLE_DEFAULTS } from "@/modules/tts/settings-shared";
import { planAudioReply, unspeakable } from "@/modules/tts/speakable";

// Issue #856: a reply built to be read goes as text even when the customer would get audio.

// The switch on, as an operator who turned it on without touching the limits.
const LIMITS = { textInstead: true, ...SPEAKABLE_DEFAULTS };
const OFF = {
  textInstead: true,
  textOverChars: null,
  textOverListItems: null,
  textOverNumbers: null,
};

// The shape the issue reports, invented numbers: two seats in four sectors, half and full price,
// per person and total.
const PRICE_TABLE = `Pelo que consta, os valores de 2 lugares ficam assim:

- **Cadeira**: meia R$ 300,00 → R$ 600,00 o total
- **Bronze**: meia R$ 550,00 → R$ 1.100,00 o total
- **Ouro**: meia R$ 770,00 → R$ 1.540,00
- **Diamante**: inteira R$ 1.800,00 → R$ 3.600,00`;

describe("unspeakable", () => {
  test("a short conversational reply is speakable", () => {
    expect(
      unspeakable(
        "Oi! Seu ingresso fica em Meus Pedidos, e o QR Code aparece 12 horas antes do evento.",
        LIMITS,
      ),
    ).toBeNull();
  });

  test("past the length limit goes as text, and the verdict carries the numbers", () => {
    const text = "palavra ".repeat(80).trim(); // 639 characters
    expect(unspeakable(text, LIMITS)).toEqual({
      criterion: "length",
      value: 639,
      limit: 450,
    });
  });

  test("the length limit is strict: exactly at it stays speakable", () => {
    const text = "a".repeat(450);
    expect(unspeakable(text, LIMITS)).toBeNull();
    expect(unspeakable(`${text}b`, LIMITS)?.criterion).toBe("length");
  });

  test("three list items, bulleted or numbered, go as text; two do not", () => {
    expect(unspeakable("Faça assim:\n- um\n- dois", LIMITS)).toBeNull();
    expect(unspeakable("Faça assim:\n- um\n- dois\n- três", LIMITS)).toEqual({
      criterion: "list",
      value: 3,
      limit: 3,
    });
    expect(
      unspeakable(
        "Passos:\n1) entre\n2. abra o pedido\n3) toque em transferir",
        LIMITS,
      ),
    ).toEqual({ criterion: "list", value: 3, limit: 3 });
    expect(
      unspeakable("**1.** Entre\n**2)** Abra o pedido\n_3._ Transfira", LIMITS),
    ).toEqual({ criterion: "list", value: 3, limit: 3 });
    expect(unspeakable("• um\n• dois\n  • três", LIMITS)?.criterion).toBe(
      "list",
    );
  });

  test("a markdown table counts its rows, not its separator", () => {
    const table = "| setor | preço |\n|---|---:|\n| pista | 100 |";
    expect(unspeakable(table, { ...OFF, textOverListItems: 3 })).toBeNull();
    expect(
      unspeakable(`${table}\n| camarote | 200 |`, {
        ...OFF,
        textOverListItems: 3,
      }),
    ).toEqual({ criterion: "list", value: 3, limit: 3 });
  });

  test("a table without outer pipes counts its rows too", () => {
    const table = "Setor | Lugares\n--- | ---\nPista | 2\nCamarote | 4";
    expect(unspeakable(table, { ...OFF, textOverListItems: 3 })).toEqual({
      criterion: "list",
      value: 3,
      limit: 3,
    });
    // Without a delimiter row a line with a pipe is prose, not a row...
    expect(
      unspeakable("A pista | o camarote\nA cadeira | o setor", {
        ...OFF,
        textOverListItems: 2,
      }),
    ).toBeNull();
    // ...unless it is fenced by pipes, or it is a list item that happens to hold one.
    expect(
      unspeakable("| Pista | 2 |\n| Camarote | 4 |\n| Cadeira | 1 |", LIMITS),
    ).toEqual({ criterion: "list", value: 3, limit: 3 });
    expect(
      unspeakable("- Pista | 2\n- Camarote | 4\n- Cadeira | 1", LIMITS),
    ).toEqual({ criterion: "list", value: 3, limit: 3 });
  });

  test("a horizontal rule is not a table separator and takes no item away", () => {
    expect(unspeakable("- um\n- dois\n- três\n\n---\n\nFim.", LIMITS)).toEqual({
      criterion: "list",
      value: 3,
      limit: 3,
    });
  });

  test("a hyphen inside a sentence is not a list item", () => {
    expect(
      unspeakable(
        "Pode ser - se quiser - amanhã, ou hoje - você escolhe.",
        LIMITS,
      ),
    ).toBeNull();
  });

  test("three money values go as text, each counted once however it is written", () => {
    expect(
      unspeakable("A meia sai R$ 300,00 e a inteira R$ 600,00.", LIMITS),
    ).toBeNull();
    expect(
      unspeakable(
        "A meia sai R$ 300,00, a inteira R$ 600,00 e o camarote 1.200 reais.",
        LIMITS,
      ),
    ).toEqual({ criterion: "numbers", value: 3, limit: 3 });
    expect(unspeakable("$12.50, € 30 e US$ 1,000.00", LIMITS)?.value).toBe(3);
    // The sign or the code after the number, as much of the world writes it.
    expect(
      unspeakable("The options cost 10 €, 20 € and 30 €.", LIMITS)?.value,
    ).toBe(3);
    expect(unspeakable("10 USD, 20 EUR e 30 BRL", LIMITS)?.value).toBe(3);
    // A sign on both sides is still one value.
    expect(
      unspeakable("R$ 10 reais e R$ 20 reais", {
        ...LIMITS,
        textOverNumbers: 3,
      }),
    ).toBeNull();
    // Inline markdown around the value is layout, prefix or suffix sign alike.
    expect(
      unspeakable(
        "A meia custa R$ **30**, a inteira R$ **60** e o camarote R$ **90**.",
        LIMITS,
      ),
    ).toEqual({ criterion: "numbers", value: 3, limit: 3 });
    expect(unspeakable("_10_ €, **20** USD e `30` BRL", LIMITS)?.value).toBe(3);
    // A code glued to a word is not a code.
    expect(unspeakable("10 USDT, 20 EURO, 30 BRLX", LIMITS)).toBeNull();
  });

  test("long numbers count, short ones and times do not", () => {
    expect(
      unspeakable(
        "Seu pedido 123456 e o protocolo 98765 e o código 44321.",
        LIMITS,
      ),
    ).toEqual({ criterion: "numbers", value: 3, limit: 3 });
    expect(
      unspeakable(
        "Temos sessões às 08:00, 08:30 e 09:00, com 2 ou 3 lugares.",
        LIMITS,
      ),
    ).toBeNull();
  });

  test("a long number starts at four digits", () => {
    expect(
      unspeakable("Os setores 101, 205 e 310 estão abertos.", LIMITS),
    ).toBeNull();
    expect(
      unspeakable("Os pedidos 1012, 2050 e 3100 estão pagos.", LIMITS),
    ).toEqual({ criterion: "numbers", value: 3, limit: 3 });
  });

  test("the first limit reached is the one reported, in the order length, list, numbers", () => {
    expect(unspeakable(PRICE_TABLE, LIMITS)?.criterion).toBe("list");
    expect(
      unspeakable(PRICE_TABLE, { ...LIMITS, textOverListItems: null })
        ?.criterion,
    ).toBe("numbers");
  });

  test("a limit set to null is off, and all off never sends text", () => {
    expect(unspeakable(PRICE_TABLE, OFF)).toBeNull();
    expect(unspeakable("x".repeat(5000), OFF)).toBeNull();
  });

  test("with the switch off nothing is measured, whatever the limits say", () => {
    const off = { ...LIMITS, textInstead: false };
    expect(unspeakable(PRICE_TABLE, off)).toBeNull();
    expect(unspeakable("x".repeat(5000), off)).toBeNull();
    expect(planAudioReply(PRICE_TABLE, off).textOnly).toBe(false);
  });
});

describe("planAudioReply", () => {
  test("a speakable reply keeps the #787 plan and no reason", () => {
    const plan = planAudioReply(
      "Pode deixar, já está tudo certo com seu pedido.",
      LIMITS,
    );
    expect(plan.textOnly).toBe(false);
    expect(plan.textReason).toBeNull();
    expect(plan.written).toEqual([]);
  });

  test("the #787 introduction case keeps its own reason", () => {
    const plan = planAudioReply(
      "Segue o link: https://x.com.br/pedidos",
      LIMITS,
    );
    expect(plan.textOnly).toBe(true);
    expect(plan.textReason).toBe("introduction");
  });

  test("the price table goes as text", () => {
    const plan = planAudioReply(PRICE_TABLE, LIMITS);
    expect(plan.textOnly).toBe(true);
    expect(plan.textReason).toEqual({ criterion: "list", value: 4, limit: 3 });
  });

  test("the URLs do not count toward the length: they go in writing either way", () => {
    const url = `https://x.com.br/${"a".repeat(400)}`;
    const text = `Você pode acompanhar seu pedido aqui: ${url} a qualquer momento.`;
    const plan = planAudioReply(text, LIMITS);
    expect(text.length).toBeGreaterThan(450);
    expect(plan.textOnly).toBe(false);
    expect(plan.written).toEqual([url]);
  });
});

describe("the limits in the agent's settings", () => {
  test("an agent saved before the switch existed keeps speaking, and turning it on brings the defaults", () => {
    const before = readTtsConfig({ tts: { mode: "mirror" } });
    expect(before.textInstead).toBe(false);
    expect(readTtsConfig({}).textInstead).toBe(false);
    expect(readTtsConfig({ tts: { textInstead: "true" } }).textInstead).toBe(
      false,
    );
    expect(planAudioReply(PRICE_TABLE, before).textOnly).toBe(false);
    const cfg = readTtsConfig({ tts: { mode: "mirror", textInstead: true } });
    expect(cfg.textInstead).toBe(true);
    expect([
      cfg.textOverChars,
      cfg.textOverListItems,
      cfg.textOverNumbers,
    ]).toEqual([450, 3, 3]);
    expect(readTtsConfig({}).textOverChars).toBe(450);
  });

  test("null turns a criterion off, and stays off", () => {
    const cfg = readTtsConfig({
      tts: { textOverChars: null, textOverListItems: 5, textOverNumbers: null },
    });
    expect([
      cfg.textOverChars,
      cfg.textOverListItems,
      cfg.textOverNumbers,
    ]).toEqual([null, 5, null]);
  });

  test("a value outside the band is clamped, and garbage reads as the default", () => {
    const cfg = readTtsConfig({
      tts: { textOverChars: 5, textOverListItems: 999, textOverNumbers: "x" },
    });
    expect([
      cfg.textOverChars,
      cfg.textOverListItems,
      cfg.textOverNumbers,
    ]).toEqual([80, 50, 3]);
  });
});
