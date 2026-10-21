import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { type CallReport, withFenceReporter } from "@/graph/tools/fence-report";
import { buildNativeTools, type ToolCtx } from "@/graph/tools/native";
import type { AttributeRefusal } from "@/modules/chatwoot/attribute-rules";
import {
  type CustomAttributeDef,
  createChatwootClient,
} from "@/modules/chatwoot/client";
import { decisionCallArgs } from "@/modules/decisions/config";
import { fakeChatwootAttributeStore } from "../utils/chatwoot-attribute-store";

// set_custom_attribute holds a value to the account's definition and to the agent's list BEFORE it
// writes: a refused call sends nothing to Chatwoot, so a precondition on the same key keeps reading
// what was there, and the model gets the rule back as a normal result.

const def = (over: Partial<CustomAttributeDef>): CustomAttributeDef => ({
  key: "k",
  displayName: "K",
  model: "conversation_attribute",
  displayType: "text",
  values: [],
  regexPattern: null,
  regexCue: null,
  ...over,
});

const DEFS: CustomAttributeDef[] = [
  def({
    key: "nome",
    displayName: "Nome",
    regexPattern: "/^(?!(oi|bom dia|tudo bem)$).{2,}$/i",
    regexCue: "o nome da pessoa",
  }),
  def({
    key: "serie",
    displayName: "Série",
    displayType: "list",
    values: ["Infantil", "Fundamental"],
  }),
  def({ key: "aceite", displayType: "checkbox" }),
  def({ key: "visita", displayType: "date" }),
];

function byName(tools: StructuredToolInterface[], name: string) {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool not found: ${name}`);
  return t;
}

// `liveDefs` answers the definitions endpoint (the store does not), for a tool that reads them itself.
async function setup(extra: Partial<ToolCtx> = {}, liveDefs?: unknown[]) {
  const cw = fakeChatwootAttributeStore(5, {
    conversations: { 7: { nome: "Maria" } },
  });
  const fetchImpl = (async (url: string, init?: RequestInit) =>
    liveDefs && String(url).endsWith("/custom_attribute_definitions")
      ? new Response(JSON.stringify(liveDefs), {
          headers: { "Content-Type": "application/json" },
        })
      : cw.fetchImpl(url, init)) as typeof fetch;
  const client = await createChatwootClient(
    {
      baseUrl: "https://chat.example.com",
      accountId: 5,
      adminToken: "ADMIN_TOK",
      botToken: "BOT_TOK",
    },
    { fetchImpl, assertSafe: async (u: string) => new URL(u) },
  );
  const refusals: AttributeRefusal[] = [];
  const noEffect: string[] = [];
  const tools = buildNativeTools({
    client,
    conversationId: 7,
    vocab: { labels: [], attributes: DEFS },
    onAttributeRefused: (r) => refusals.push(r),
    onNoEffect: (n) => noEffect.push(n),
    ...extra,
  });
  return {
    cw,
    tool: byName(tools, "set_custom_attribute"),
    refusals,
    noEffect,
  };
}

describe("set_custom_attribute holds a value to its definition", () => {
  test("a greeting refused by the pattern reaches neither Chatwoot nor the stored value", async () => {
    const { cw, tool, refusals, noEffect } = await setup();
    const reports: CallReport[] = [];
    const out = String(
      await tool.invoke(
        { key: "nome", value: "Oi" },
        withFenceReporter({}, (r) => reports.push(r)),
      ),
    );
    expect(out).toContain("Not written");
    expect(out).toContain("o nome da pessoa");
    expect(out).not.toContain('"Oi"');
    expect(cw.requests).toEqual([]);
    expect(cw.conversations.get(7)).toEqual({ nome: "Maria" });
    expect(refusals).toEqual([
      { scope: "conversation", rule: "pattern", key: "nome" },
    ]);
    expect(noEffect).toEqual(["set_custom_attribute"]);
    expect(reports).toEqual([{ noEffect: true }]);
  });

  test("a value the pattern accepts is written", async () => {
    const { cw, tool, refusals } = await setup();
    const out = String(await tool.invoke({ key: "nome", value: " Joana " }));
    expect(out).toBe("Conversation attribute nome set.");
    expect(cw.conversations.get(7)).toEqual({ nome: "Joana" });
    expect(refusals).toEqual([]);
  });

  test("a list value outside the options is refused and the options are named back", async () => {
    const { cw, tool, refusals } = await setup();
    const out = String(await tool.invoke({ key: "serie", value: "5º ano" }));
    expect(out).toContain("Infantil | Fundamental");
    expect(cw.requests).toEqual([]);
    expect(refusals).toEqual([
      { scope: "conversation", rule: "list", key: "serie" },
    ]);
  });

  test("a checkbox is written as the spelling the dashboard reads", async () => {
    const { cw, tool } = await setup();
    await tool.invoke({ key: "aceite", value: "True" });
    expect(cw.conversations.get(7)).toEqual({ nome: "Maria", aceite: "true" });
  });

  test("a date in another format is refused with the format to use", async () => {
    const { tool, refusals } = await setup();
    const out = String(await tool.invoke({ key: "visita", value: "20/10" }));
    expect(out).toContain("YYYY-MM-DD");
    expect(refusals[0]?.rule).toBe("date");
  });

  test("an empty value is refused unless the call is an explicit clear", async () => {
    const { cw, tool, refusals } = await setup();
    const out = String(await tool.invoke({ key: "nome", value: "" }));
    expect(out).toContain("clear=true");
    expect(cw.requests).toEqual([]);
    expect(refusals).toEqual([
      { scope: "conversation", rule: "empty", key: "nome" },
    ]);
    const cleared = String(
      await tool.invoke({ key: "nome", value: "", clear: true }),
    );
    expect(cleared).toBe("Conversation attribute nome cleared.");
    expect(cw.conversations.get(7)).toEqual({ nome: "" });
  });

  test("a clear that also carries a value writes nothing", async () => {
    const { cw, tool, refusals } = await setup();
    await tool.invoke({ key: "nome", value: "Ana", clear: true });
    expect(cw.requests).toEqual([]);
    expect(refusals[0]?.rule).toBe("clear_with_value");
  });

  test("an invented key with no list is written, and a refusal of it does not name it", async () => {
    const { cw, tool, refusals } = await setup();
    await tool.invoke({ key: "apelido", value: "Zé" });
    expect(cw.conversations.get(7)).toEqual({ nome: "Maria", apelido: "Zé" });
    // Slug-shaped or not, a key outside the vocabulary is the model's text: a number, a name.
    await tool.invoke({ key: "qualquer", value: " " });
    await tool.invoke({ key: "11987654321", value: " " });
    await tool.invoke({ key: "Maria Silva", value: " " });
    expect(refusals).toEqual([
      { scope: "conversation", rule: "empty" },
      { scope: "conversation", rule: "empty" },
      { scope: "conversation", rule: "empty" },
    ]);
  });
});

describe("the agent's list of attributes it may write", () => {
  const writableAttributes = [
    { scope: "conversation" as const, key: "serie" },
    { scope: "contact" as const, key: "nome" },
  ];

  test("a key outside the list is refused, named against the list, and nothing is written", async () => {
    const { cw, tool, refusals } = await setup({ writableAttributes });
    const out = String(await tool.invoke({ key: "nome", value: "Joana" }));
    expect(out).toContain("may not write");
    expect(out).toContain("serie (conversation), nome (contact)");
    expect(cw.requests).toEqual([]);
    expect(refusals).toEqual([
      { scope: "conversation", rule: "not_allowed", key: "nome" },
    ]);
  });

  test("a key the model invented is refused without being named on the trail", async () => {
    const { refusals, tool } = await setup({ writableAttributes });
    await tool.invoke({ key: "Inventado por mim", value: "x" });
    expect(refusals).toEqual([{ scope: "conversation", rule: "not_allowed" }]);
  });

  test("a listed key is still held to its definition", async () => {
    const { cw, tool, refusals } = await setup({ writableAttributes });
    await tool.invoke({ key: "serie", value: "nono" });
    expect(cw.requests).toEqual([]);
    expect(refusals[0]?.rule).toBe("list");
    await tool.invoke({ key: "serie", value: "Infantil" });
    expect(cw.conversations.get(7)).toEqual({
      nome: "Maria",
      serie: "Infantil",
    });
  });

  test("the description shows only the listed keys, with the rule of each", async () => {
    const { tool } = await setup({ writableAttributes });
    const desc = tool.description ?? "";
    expect(desc).toContain(
      '<attribute key="serie" values="Infantil|Fundamental"/>',
    );
    // NOTE: the listed `nome` is the CONTACT's, which has no definition; the conversation's is not listed.
    expect(desc).toContain(
      '<contact>\n    <attribute key="nome"/>\n  </contact>',
    );
    expect(desc).not.toContain('rule="o nome da pessoa"');
    expect(desc).not.toContain('key="aceite"');
  });

  test("without a list the description names each typed rule", async () => {
    const { tool } = await setup();
    const desc = tool.description ?? "";
    expect(desc).toContain('<attribute key="nome" rule="o nome da pessoa"/>');
    expect(desc).toContain('<attribute key="aceite" format="true or false"/>');
    expect(desc).toContain(
      '<attribute key="visita" format="a date as YYYY-MM-DD"/>',
    );
  });
});

describe("when turn prep could not read the definitions", () => {
  test("the tool reads them itself and still holds the value to them", async () => {
    const { cw, tool, refusals } = await setup(
      { vocab: undefined, vocabUnavailable: true },
      [
        {
          attribute_key: "serie",
          attribute_display_name: "Série",
          attribute_model: "conversation_attribute",
          attribute_display_type: "list",
          attribute_values: ["Infantil", "Fundamental"],
        },
      ],
    );
    await tool.invoke({ key: "serie", value: "5º ano" });
    expect(refusals).toEqual([
      { scope: "conversation", rule: "list", key: "serie" },
    ]);
    expect(cw.conversations.get(7)).toEqual({ nome: "Maria" });
  });

  test("and refuses when that read fails too, writing nothing", async () => {
    const { cw, tool, refusals } = await setup({
      vocab: undefined,
      vocabUnavailable: true,
    });
    const out = String(await tool.invoke({ key: "serie", value: "Infantil" }));
    expect(out).toContain("could not be read");
    expect(refusals).toEqual([
      { scope: "conversation", rule: "definitions_unavailable" },
    ]);
    expect(cw.conversations.get(7)).toEqual({ nome: "Maria" });
  });
});

describe("a decisions rule names its value as the operator wrote it", () => {
  test("an empty value is the rule's clear, and the tool clears", async () => {
    const { cw, tool, refusals } = await setup();
    await tool.invoke(
      decisionCallArgs("set_custom_attribute", { key: "nome", value: "" }),
    );
    expect(refusals).toEqual([]);
    expect(cw.conversations.get(7)).toEqual({ nome: "" });
  });

  test("a value is passed on as is, and other tools are untouched", () => {
    expect(
      decisionCallArgs("set_custom_attribute", { key: "k", value: "v" }),
    ).toEqual({ key: "k", value: "v" });
    expect(decisionCallArgs("private_note", { content: "" })).toEqual({
      content: "",
    });
  });
});

describe("a listed key the account has no definition for", () => {
  test("is shown in the description, as the list says the model may write it", async () => {
    const { tool } = await setup({
      writableAttributes: [{ scope: "contact", key: "lead_code" }],
    });
    expect(tool.description ?? "").toContain(
      '<contact>\n    <attribute key="lead_code"/>\n  </contact>',
    );
  });

  test("and so is the whole list when the catalog could not be read", async () => {
    const { tool } = await setup({
      vocab: undefined,
      vocabUnavailable: true,
      writableAttributes: [{ scope: "conversation", key: "serie" }],
    });
    expect(tool.description ?? "").toContain('<attribute key="serie"/>');
  });
});

describe("calls made together", () => {
  // The pattern check waits on a thread, so a set and the clear after it would otherwise queue in
  // whichever order their checks finished.
  test("queue their writes in the order they were made, so a set then a clear leaves it cleared", async () => {
    const { cw, tool } = await setup();
    await Promise.all([
      tool.invoke({ key: "nome", value: "Alice" }),
      tool.invoke({ key: "nome", value: "", clear: true }),
    ]);
    expect(cw.conversations.get(7)).toEqual({ nome: "" });
  });
});
