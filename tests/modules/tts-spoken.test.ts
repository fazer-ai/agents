import { describe, expect, test } from "bun:test";
import { prepareSpeechText } from "@/modules/tts/service";
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
      // GFM's autolink rule: `?!.,:*_~` at the end are not the link's, so a chat client would not
      // have linked the underscore either.
      name: "a trailing underscore is formatting, as in GFM autolinks",
      text: "O arquivo fica em https://x.com.br/arquivos/ingresso_ para baixar",
      written: ["https://x.com.br/arquivos/ingresso"],
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
    // Review round 3: a match that starts or ends inside a token writes someone else's destination.
    {
      name: "italics around a URL do not hide it",
      text: "Abra _https://x.com.br/pedidos_ e confirme o pedido na tela",
      written: ["https://x.com.br/pedidos"],
    },
    {
      name: "double underscores around a URL do not hide it",
      text: "Abra __https://x.com.br/pedidos__ e confirme o pedido na tela",
      written: ["https://x.com.br/pedidos"],
    },
    {
      name: "brackets in a URL's query belong to it",
      text: "Veja https://x.com.br/busca?ids[]=1&ids[]=2 para os dois pedidos",
      written: ["https://x.com.br/busca?ids[]=1&ids[]=2"],
    },
    {
      name: "an unbalanced closing bracket is the sentence's",
      text: "Confira o site [https://x.com.br/troca] antes de comprar",
      written: ["https://x.com.br/troca"],
    },
    {
      name: "an apostrophe in an address stays in it",
      text: "Escreva para d'angelo@x.com.br e respondemos em até 2 dias",
      written: ["d'angelo@x.com.br"],
    },
    {
      name: "a punycode top-level domain stays whole",
      text: "Escreva para equipe@exemplo.xn--p1ai e respondemos em até 2 dias",
      written: ["equipe@exemplo.xn--p1ai"],
    },
    {
      name: "an accented local part stays whole",
      text: "Escreva para joão@x.com.br e respondemos em até 2 dias",
      written: ["joão@x.com.br"],
    },
    {
      name: "an accented domain stays whole",
      text: "Escreva para sac@ingressos.bahía.com.br e respondemos em até 2 dias",
      written: ["sac@ingressos.bahía.com.br"],
    },
    {
      name: "a domain label that starts accented stays whole",
      text: "Escreva para sac@ágil.com.br e respondemos em até 2 dias",
      written: ["sac@ágil.com.br"],
    },
    // Review round 4: structure before text, and one boundary rule for both ends.
    {
      name: "adjacent markdown links are two links",
      text: "Veja [um](https://x.com.br/a),[outro](https://x.com.br/b) para resolver seu pedido",
      written: ["https://x.com.br/a", "https://x.com.br/b"],
    },
    {
      name: "a bare URL glued to a markdown link is its own item",
      text: "Veja https://x.com.br/a[outro](https://x.com.br/b) para resolver seu pedido",
      written: ["https://x.com.br/a", "https://x.com.br/b"],
    },
    {
      name: "quotes around an address are the sentence's",
      text: "Escreva para 'sac@x.com.br' e respondemos em até 2 dias",
      written: ["sac@x.com.br"],
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

  test("an address the pattern cannot hold whole is left alone, not cut", () => {
    // `a!b@` is a valid local part the class does not cover; `b@x.com.br` would write a stranger's.
    // A domain whose last label is not a name (`x.com.123`) is not cut back to `x.com` either.
    for (const text of [
      "Escreva para a!b@x.com.br e respondemos em 2 dias",
      "Escreva para sac@x.com.123 e respondemos em 2 dias",
      "Fale com ops~billing@x.com.br para resolver seu pedido",
      "Fale com ops*billing@x.com.br para resolver seu pedido",
    ]) {
      expect(planSpokenReply(text).written).toEqual([]);
    }
  });

  test("a URL glued to a word is not cut out of it", () => {
    expect(
      [
        "O campo abchttps://x.com.br/a veio assim do sistema",
        "O campo abc_https://x.com.br/a veio assim do sistema",
      ].flatMap((t) => planSpokenReply(t).written),
    ).toEqual([]);
  });

  test("bold around a phrase that ends in a URL stays out of it", () => {
    // The markers are the phrase's, so they stay with it and synthesis drops them, as it always did.
    const plan = planSpokenReply(
      "**Acompanhe seu pedido em https://x.com.br/pedido** e aguarde a confirmação",
    );
    expect(plan.written).toEqual(["https://x.com.br/pedido"]);
    expect(prepareSpeechText(plan.speech)).not.toMatch(/[*]|https?:/);
  });

  test("a mailto link with parameters hands over only its recipient", () => {
    expect(
      planSpokenReply(
        "Se preferir, [escreva para o suporte](mailto:suporte@x.com.br?subject=Pedido) e respondemos em 2 dias",
      ).written,
    ).toEqual(["suporte@x.com.br"]);
  });

  test("a language written without spaces counts its words, not its clauses", () => {
    const plan = planSpokenReply(
      "您的订单已经确认，我们会在两个工作日内安排发货，请通过以下链接查看物流进度：https://x.com.br/pedidos/123",
    );
    expect(plan.written).toEqual(["https://x.com.br/pedidos/123"]);
    expect(plan.textOnly).toBe(false);
  });

  // Review round 6.
  test("an autolink or inline code keeps the URL's own trailing characters", () => {
    for (const text of [
      "Redefina em <https://x.com.br/reset?token=abc_> ainda hoje",
      "Redefina em `https://x.com.br/reset?token=abc_` ainda hoje",
    ]) {
      expect(planSpokenReply(text).written).toEqual([
        "https://x.com.br/reset?token=abc_",
      ]);
    }
  });

  test("CJK sentence punctuation ends a URL and the prose after it stays spoken", () => {
    const plan = planSpokenReply(
      "物流进度：https://x.com.br/pedidos。明天我们会发货。",
    );
    expect(plan.written).toEqual(["https://x.com.br/pedidos"]);
    expect(plan.speech).toContain("明天我们会发货");
  });

  test("an unpaired marker before an address leaves the address alone", () => {
    for (const text of [
      "Escreva para *sales@x.com.br e respondemos em 2 dias",
      "Escreva para ~sales@x.com.br e respondemos em 2 dias",
      "Escreva para *sales@x.com.br e responda * aqui mesmo",
    ]) {
      expect(planSpokenReply(text).written).toEqual([]);
    }
  });

  // Review round 7: the written item is the destination the link points to, not its markdown source.
  test("a markdown destination is handed over decoded", () => {
    expect(
      planSpokenReply(
        "Veja [o artigo](https://en.wikipedia.org/wiki/Function_\\(mathematics\\)) e [a busca](https://x.com.br/b?a=1&amp;c=2) quando puder",
      ).written,
    ).toEqual([
      "https://en.wikipedia.org/wiki/Function_(mathematics)",
      "https://x.com.br/b?a=1&c=2",
    ]);
  });

  test("a mailto recipient is handed over without its percent escapes", () => {
    expect(
      planSpokenReply(
        "Se preferir, [escreva para o suporte](mailto:foo%2Bbar@x.com.br) e respondemos em 2 dias",
      ).written,
    ).toEqual(["foo+bar@x.com.br"]);
  });

  // Review round 8: the rest of CommonMark's link destination.
  test("a titled or angle-bracketed markdown link is a link", () => {
    for (const text of [
      'Redefina [aqui](https://x.com.br/reset?token=abc_ "Redefinir senha") ainda hoje',
      "Redefina [aqui](https://x.com.br/reset?token=abc_ 'Redefinir senha') ainda hoje",
      "Redefina [aqui](https://x.com.br/reset?token=abc_ (Redefinir senha)) ainda hoje",
      "Redefina [aqui](<https://x.com.br/reset?token=abc_>) ainda hoje",
    ]) {
      const plan = planSpokenReply(text);
      expect(plan.written).toEqual(["https://x.com.br/reset?token=abc_"]);
      expect(plan.speech).toBe("Redefina aqui ainda hoje");
    }
  });

  test("numeric character references in a destination are decoded", () => {
    expect(
      planSpokenReply(
        "Veja [o pedido](https://x.com.br/b?a=1&#38;c=2) e [a nota](https://x.com.br/n?a=1&#x26;c=2) quando puder",
      ).written,
    ).toEqual(["https://x.com.br/b?a=1&c=2", "https://x.com.br/n?a=1&c=2"]);
  });

  test("an angle-bracketed mailto hands over its recipient", () => {
    expect(
      planSpokenReply(
        "Se preferir, [escreva para o suporte](<mailto:sac@x.com.br?subject=Pedido>) e respondemos em 2 dias",
      ).written,
    ).toEqual(["sac@x.com.br"]);
  });

  // Review round 9.
  test("an escaped parenthesis is the destination's, not the link's end", () => {
    const plan = planSpokenReply(
      "Abra [o pedido](https://x.com.br/a\\)) e confirme na tela",
    );
    expect(plan.written).toEqual(["https://x.com.br/a)"]);
    expect(plan.speech).toBe("Abra o pedido e confirme na tela");
  });

  test("a destination is decoded in one pass", () => {
    expect(
      planSpokenReply(
        "Veja [um](https://x.com.br/?q=&amp;#38;) e [outro](https://x.com.br/?r=\\&amp;) quando puder",
      ).written,
    ).toEqual(["https://x.com.br/?q=&#38;", "https://x.com.br/?r=&amp;"]);
  });

  test("an escaped angle bracket stays in an angle-bracketed destination", () => {
    expect(
      planSpokenReply(
        "Abra [o pedido](<https://x.com.br/a\\>b>) e confirme na tela",
      ).written,
    ).toEqual(["https://x.com.br/a>b"]);
  });

  // Review round 10.
  test("an address never restarts inside a local part it cannot hold", () => {
    expect(
      planSpokenReply(
        "Escreva para john!doe.smith@x.com.br e respondemos em 2 dias",
      ).written,
    ).toEqual([]);
  });

  test("letters in the CJK and fullwidth blocks belong to the URL", () => {
    expect(
      planSpokenReply(
        "Veja https://ja.wikipedia.org/wiki/佐々木 e https://x.com.br/ｗｗｗ para detalhes",
      ).written,
    ).toEqual([
      "https://ja.wikipedia.org/wiki/佐々木",
      "https://x.com.br/ｗｗｗ",
    ]);
  });

  test("a mailto autolink hands over its decoded recipient", () => {
    const plan = planSpokenReply(
      "Escreva para <mailto:foo%2Bbar@x.com.br> e respondemos em 2 dias",
    );
    expect(plan.written).toEqual(["foo+bar@x.com.br"]);
    expect(plan.speech).toBe("Escreva para e respondemos em 2 dias");
  });

  // Review round 11.
  test("a quote or marker the address may own leaves it alone", () => {
    for (const text of [
      "Escreva para a!b'finance@x.com.br e respondemos em 2 dias",
      "Escreva para a!b_finance@x.com.br e respondemos em 2 dias",
      "Escreva para a!b*finance@x.com.br e respondemos em 2 dias",
      "Escreva para 'sales@x.com.br e respondemos em 2 dias",
      'Escreva para "sales@x.com.br e respondemos em 2 dias',
    ]) {
      expect(planSpokenReply(text).written).toEqual([]);
    }
  });

  test("whitespace in a markdown destination is percent-encoded", () => {
    expect(
      planSpokenReply(
        "Baixe [o documento](<https://x.com.br/Meu Arquivo.pdf>) quando puder",
      ).written,
    ).toEqual(["https://x.com.br/Meu%20Arquivo.pdf"]);
  });

  // Review round 13.
  test("a closing typographic quote is the sentence's", () => {
    for (const text of [
      "O endereço ‘https://x.com.br/pedidos’ permite acompanhar seu pedido",
      "O endereço “https://x.com.br/pedidos” permite acompanhar seu pedido",
      "O endereço «https://x.com.br/pedidos» permite acompanhar seu pedido",
      "O endereço ‹https://x.com.br/pedidos› permite acompanhar seu pedido",
    ]) {
      expect(planSpokenReply(text).written).toEqual([
        "https://x.com.br/pedidos",
      ]);
    }
  });

  // Review round 14.
  test("inline code keeps its URL or address verbatim, punctuation included", () => {
    const plan = planSpokenReply(
      "Leia `https://ja.wikipedia.org/wiki/君の名は。` e escreva para `sac@x.com.br` depois",
    );
    expect(plan.written).toEqual([
      "https://ja.wikipedia.org/wiki/君の名は。",
      "sac@x.com.br",
    ]);
    expect(plan.speech).toBe("Leia e escreva para depois");
  });

  test("inline code inside a link label belongs to the link", () => {
    const plan = planSpokenReply(
      "Abra [o site `https://x.com.br/a`](https://x.com.br/b) quando puder",
    );
    expect(plan.written).toEqual(["https://x.com.br/b", "https://x.com.br/a"]);
    expect(plan.speech).toBe("Abra o site quando puder");
  });

  // Review round 15.
  test("a link label with brackets is still a link", () => {
    for (const text of [
      "Abra [o pedido [123]](https://x.com.br/reset?token=abc_) e confirme os dados",
      "Abra [o pedido \\[123](https://x.com.br/reset?token=abc_) e confirme os dados",
    ]) {
      const plan = planSpokenReply(text);
      expect(plan.written).toEqual(["https://x.com.br/reset?token=abc_"]);
      // The whole link left the speech, not only its last bracketed piece.
      expect(plan.speech.startsWith("Abra o pedido")).toBe(true);
    }
  });

  test("a www host never starts inside another host or an address", () => {
    for (const text of [
      "O portal fica em loja-www.x.com.br para acompanhar os pedidos",
      "Escreva para a!b@www.x.com.br e respondemos em 2 dias",
    ]) {
      expect(planSpokenReply(text).written).toEqual([]);
    }
  });

  // Review round 16.
  test("addresses inside a longer formatted phrase are extracted", () => {
    for (const text of [
      "Envie para **sac@x.com.br ou vendas@x.com.br** e respondemos em 2 dias",
      "Envie para _sac@x.com.br ou vendas@x.com.br_ e respondemos em 2 dias",
      "Envie para 'sac@x.com.br ou vendas@x.com.br' e respondemos em 2 dias",
    ]) {
      const plan = planSpokenReply(text);
      expect(plan.written).toEqual(["sac@x.com.br", "vendas@x.com.br"]);
      expect(plan.speech).not.toContain("@");
    }
  });

  test("a marker closed only on a later line does not pair", () => {
    expect(
      planSpokenReply(
        "Escreva para *sales@x.com.br e respondemos\nem 2 dias *mesmo*",
      ).written,
    ).toEqual([]);
  });

  // Review round 18: pairing later on the line does not make a mid-token marker a token start.
  test("a marker inside a local part stays the address's even when one closes later", () => {
    expect(
      planSpokenReply(
        "Fale com ops*billing@x.com.br e aguarde *dois dias* pela resposta",
      ).written,
    ).toEqual([]);
  });

  // Review round 19.
  test("an underscore inside a later word does not close a leading one", () => {
    expect(
      planSpokenReply(
        "Envie para _sac@x.com.br ou sac_vendas@x.com.br e aguarde nossa resposta",
      ).written,
    ).toEqual(["_sac@x.com.br", "sac_vendas@x.com.br"]);
  });

  test("a bare mailto URI hands over its decoded recipient", () => {
    const plan = planSpokenReply(
      "Escreva para mailto:foo%2Bbar@x.com.br?subject=Pedido. Respondemos em 2 dias",
    );
    expect(plan.written).toEqual(["foo+bar@x.com.br"]);
    expect(plan.speech).not.toMatch(/mailto|subject|@/);
  });

  // Review round 21.
  test("a Unicode ellipsis or terminator ends the sentence, not the URL", () => {
    for (const text of [
      "Acompanhe em https://x.com.br/pedido… Depois aguarde a confirmação",
      "Acompanhe em https://x.com.br/pedido‼ Depois aguarde a confirmação",
    ]) {
      expect(planSpokenReply(text).written).toEqual([
        "https://x.com.br/pedido",
      ]);
    }
    // Delimited, the destination stays verbatim.
    expect(
      planSpokenReply("Acompanhe em `https://x.com.br/pedido…` depois").written,
    ).toEqual(["https://x.com.br/pedido…"]);
  });

  test("a decimal, a time and a file name are not URLs", () => {
    const text =
      "O valor é R$ 1.500,00 às 20.30 e o comprovante vai no arquivo recibo.pdf anexado";
    expect(planSpokenReply(text).written).toEqual([]);
  });
});
