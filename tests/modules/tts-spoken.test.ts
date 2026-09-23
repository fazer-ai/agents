import { describe, expect, test } from "bun:test";
import { planSpokenReply } from "@/modules/tts/spoken";

// Issue #787: a URL or an e-mail address in an audio reply is either read aloud (bare) or lost
// (markdown link, whose URL prepareSpeechText drops). The plan moves every such item out of the
// speech and into the text message that follows the audio.
describe("planSpokenReply", () => {
  test("a reply with no URL and no e-mail is spoken exactly as written", () => {
    // Byte for byte: the spacing a cleanup would touch stays, so the synthesis request is unchanged.
    const text =
      "Seu pedido  4521 foi confirmado , ligue para (11) 4003-1234 se precisar";
    expect(planSpokenReply(text)).toEqual({
      speech: text,
      written: [],
      textOnly: false,
    });
  });

  const table: Array<{
    name: string;
    text: string;
    speech: string;
    written: string[];
    textOnly?: boolean;
  }> = [
    {
      name: "bare URL",
      text: "Acompanhe em https://x.com.br/pedidos/123 a qualquer momento, e ele chega em 2 dias",
      speech: "Acompanhe em a qualquer momento, e ele chega em 2 dias",
      written: ["https://x.com.br/pedidos/123"],
    },
    {
      name: "trailing punctuation stays in the sentence, not in the URL",
      text: "O site é https://x.com.br/troca. Depois é só confirmar a troca na tela",
      speech: "O site é. Depois é só confirmar a troca na tela",
      written: ["https://x.com.br/troca"],
    },
    {
      name: "markdown link keeps its label in the speech",
      text: "Para trocar, [acesse aqui](https://x.com.br/troca) e siga os passos da tela",
      speech: "Para trocar, acesse aqui e siga os passos da tela",
      written: ["https://x.com.br/troca"],
    },
    {
      name: "mailto link keeps its label and hands over the address",
      text: "Se preferir, [escreva para o time](mailto:sac@x.com.br) e respondemos em 2 dias",
      speech: "Se preferir, escreva para o time e respondemos em 2 dias",
      written: ["sac@x.com.br"],
    },
    {
      name: "e-mail address",
      text: "Envie os documentos para sac@x.com.br e respondemos em até 2 dias úteis",
      speech: "Envie os documentos para e respondemos em até 2 dias úteis",
      written: ["sac@x.com.br"],
    },
    {
      name: "www without a scheme is a URL",
      text: "Os ingressos ficam em www.x.com.br/pedidos depois da compra aprovada",
      speech: "Os ingressos ficam em depois da compra aprovada",
      written: ["www.x.com.br/pedidos"],
    },
    {
      name: "several items: order of first appearance, no repeats",
      text: "Veja https://x.com.br/e/88 e o [mapa do local](https://x.com.br/m/88). Dúvidas: sac@x.com.br, ou volte em https://x.com.br/e/88 quando quiser",
      speech: "Veja e o mapa do local. Dúvidas: ou volte em quando quiser",
      written: [
        "https://x.com.br/e/88",
        "https://x.com.br/m/88",
        "sac@x.com.br",
      ],
    },
    {
      name: "only the introduction of the link is left: the reply goes as text",
      text: "Segue o link: https://x.com.br/meus-ingressos",
      speech: "Segue o link:",
      written: ["https://x.com.br/meus-ingressos"],
      textOnly: true,
    },
    {
      name: "only the introduction of the e-mail is left: the reply goes as text",
      text: "O e-mail é: sac@x.com.br",
      speech: "O e-mail é:",
      written: ["sac@x.com.br"],
      textOnly: true,
    },
    {
      name: "nothing but the item: the reply goes as text",
      text: "https://x.com.br/troca",
      speech: "",
      written: ["https://x.com.br/troca"],
      textOnly: true,
    },
  ];

  for (const row of table) {
    test(row.name, () => {
      expect(planSpokenReply(row.text)).toEqual({
        speech: row.speech,
        written: row.written,
        textOnly: row.textOnly ?? false,
      });
    });
  }

  // Review round 1 of #788: the item written is the only copy of the destination the customer gets,
  // so it has to survive the characters around it.
  const exact: Array<{ name: string; text: string; written: string[] }> = [
    {
      name: "balanced parentheses belong to the URL",
      text: "Veja https://en.wikipedia.org/wiki/C_(programming_language) para detalhes",
      written: ["https://en.wikipedia.org/wiki/C_(programming_language)"],
    },
    {
      name: "a markdown target keeps its balanced parentheses",
      text: "Veja [o artigo](https://en.wikipedia.org/wiki/C_(programming_language)) para detalhes",
      written: ["https://en.wikipedia.org/wiki/C_(programming_language)"],
    },
    {
      name: "an unbalanced closing parenthesis is the sentence's",
      text: "Confira o site (https://x.com.br/troca) antes de comprar",
      written: ["https://x.com.br/troca"],
    },
    {
      name: "inline code around a URL is not part of it",
      text: "Abra `https://x.com.br/troca` e confirme a troca na tela",
      written: ["https://x.com.br/troca"],
    },
    {
      name: "bold around a URL is not part of it",
      text: "Abra **https://x.com.br/troca** e confirme a troca na tela",
      written: ["https://x.com.br/troca"],
    },
    {
      name: "a markdown autolink's brackets are not part of it",
      text: "Abra <https://x.com.br/troca> e confirme a troca na tela",
      written: ["https://x.com.br/troca"],
    },
    {
      name: "underscores around an address are italics, not part of it",
      text: "Escreva para _sac@x.com.br_ e respondemos em até 2 dias",
      written: ["sac@x.com.br"],
    },
    {
      name: "bold around an address is not part of it",
      text: "Escreva para **sac@x.com.br** e respondemos em até 2 dias",
      written: ["sac@x.com.br"],
    },
    {
      name: "an address used as its own link label is not spoken",
      text: "Escreva para [sac@x.com.br](mailto:sac@x.com.br) e respondemos em até 2 dias",
      written: ["sac@x.com.br"],
    },
    {
      name: "a URL used as its own link label is not spoken",
      text: "Os pedidos ficam em [https://x.com.br/pedidos](https://x.com.br/pedidos) depois da compra",
      written: ["https://x.com.br/pedidos"],
    },
    {
      name: "a trailing underscore with no opening one is the URL's",
      text: "O arquivo fica em https://x.com.br/arquivos/ingresso_ para baixar",
      written: ["https://x.com.br/arquivos/ingresso_"],
    },
    {
      name: "a www host inside an e-mail address stays the address",
      text: "Escreva para suporte@www.example.com e respondemos em até 2 dias",
      written: ["suporte@www.example.com"],
    },
    {
      name: "an address inside a URL's query stays the URL",
      text: "Use https://x.com.br/contato?para=sac@x.com.br e respondemos em até 2 dias",
      written: ["https://x.com.br/contato?para=sac@x.com.br"],
    },
  ];

  for (const row of exact) {
    test(row.name, () => {
      const plan = planSpokenReply(row.text);
      expect(plan.written).toEqual(row.written);
      for (const item of row.written) {
        expect(plan.speech).not.toContain(item);
      }
      expect(plan.speech).not.toMatch(/[`*@<>]|https?:|www\./);
    });
  }

  test("a markdown link with parentheses in its target still speaks only its label", () => {
    expect(
      planSpokenReply(
        "Veja [o artigo](https://en.wikipedia.org/wiki/C_(programming_language)) para detalhes",
      ).speech,
    ).toBe("Veja o artigo para detalhes");
  });

  test("an address with its own underscore keeps it", () => {
    expect(
      planSpokenReply(
        "Escreva para sac_vendas@x.com.br e respondemos em 2 dias",
      ).written,
    ).toEqual(["sac_vendas@x.com.br"]);
  });

  test("a link label keeps its words and loses only the address inside it", () => {
    expect(
      planSpokenReply(
        "Escreva para [o time em sac@x.com.br](mailto:sac@x.com.br) e respondemos em 2 dias",
      ).speech,
    ).toBe("Escreva para o time em e respondemos em 2 dias");
  });

  test("a leading underscore with no closing one is the address's", () => {
    expect(
      planSpokenReply("Escreva para _sac@x.com.br e respondemos em 2 dias")
        .written,
    ).toEqual(["_sac@x.com.br"]);
  });

  test("an item inside a link label is handed over along with the target", () => {
    expect(
      planSpokenReply(
        "Escreva para [o time em sac@x.com.br](https://x.com.br/contato) e respondemos em 2 dias",
      ),
    ).toEqual({
      speech: "Escreva para o time em e respondemos em 2 dias",
      written: ["https://x.com.br/contato", "sac@x.com.br"],
      textOnly: false,
    });
  });

  test("a decimal, a time and a file name are not URLs", () => {
    const text =
      "O valor é R$ 1.500,00 às 20.30 e o comprovante vai no arquivo recibo.pdf anexado";
    expect(planSpokenReply(text).written).toEqual([]);
  });
});
