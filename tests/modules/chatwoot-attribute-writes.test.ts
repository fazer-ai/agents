import { describe, expect, test } from "bun:test";
import { createChatwootClient } from "@/modules/chatwoot/client";
import { fakeChatwootAttributeStore } from "../utils/chatwoot-attribute-store";

const client = (fetchImpl: typeof fetch) =>
  createChatwootClient(
    {
      baseUrl: "https://chat.example.com",
      accountId: 5,
      adminToken: "ADMIN_TOK",
      botToken: "BOT_TOK",
    },
    { fetchImpl, assertSafe: async (u: string) => new URL(u) },
  );

describe("custom attribute writes against endpoints that replace", () => {
  test("a conversation write keeps the keys already in the bag", async () => {
    // The deterministic half of issue #112, and the one no burst is needed to see: the tool sends
    // ONE key, the endpoint assigns the whole hash, so every other attribute on the conversation is
    // erased — including ones written turns earlier.
    const cw = fakeChatwootAttributeStore(5, {
      conversations: { 61: { origem: "Instagram" } },
    });
    const c = await client(cw.fetchImpl);
    await c.setConversationCustomAttributes(61, { produto: "cadeira" });
    expect(cw.conversations.get(61)).toEqual({
      origem: "Instagram",
      produto: "cadeira",
    });
  });

  test("concurrent conversation writes in one turn all survive", async () => {
    // How a burst actually arrives: LangGraph's ToolNode runs one response's tool calls with
    // Promise.all (tool_node: `await Promise.all(aiMessage.tool_calls...map(runTool))`).
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setConversationCustomAttributes(61, { produto: "cadeira" }),
      c.setConversationCustomAttributes(61, { medida: "90cm" }),
      c.setConversationCustomAttributes(61, { quantidade: "4" }),
    ]);
    expect(cw.conversations.get(61)).toEqual({
      produto: "cadeira",
      medida: "90cm",
      quantidade: "4",
    });
  });

  test("concurrent contact writes in one turn all survive", async () => {
    // The contact path already read-merge-writes, so this is the interleaving half: every call GETs
    // the same pre-write snapshot before any of them PUTs.
    const cw = fakeChatwootAttributeStore(5, {
      contacts: { 900: { cpf: "1" } },
    });
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setContactCustomAttributes(900, { empresa: "Acme" }),
      c.setContactCustomAttributes(900, { nome_cliente: "Maria" }),
      c.setContactCustomAttributes(900, { tipo_pessoa: "PJ" }),
    ]);
    expect(cw.contacts.get(900)).toEqual({
      cpf: "1",
      empresa: "Acme",
      nome_cliente: "Maria",
      tipo_pessoa: "PJ",
    });
  });

  test("the conversation reset still empties the bag", async () => {
    // The `/reset` command clears every attribute, and it is the one caller that WANTS the
    // replacing semantics. A merge-based setter turns `{}` into a no-op, so the clear has to stay a
    // separate, explicit operation rather than a special case of the setter.
    const cw = fakeChatwootAttributeStore(5, {
      conversations: { 61: { origem: "Instagram", produto: "cadeira" } },
    });
    const c = await client(cw.fetchImpl);
    await c.clearConversationCustomAttributes(61);
    expect(cw.conversations.get(61)).toEqual({});
  });

  test("the conversation read uses the admin token, the write the bot token", async () => {
    // `conversations#show` only became bot-accessible in Chatwoot on 2026-06-05 (upstream #14655),
    // so a bot-token read 401s on any older instance and takes the whole write down with it. The
    // write stays on the bot token: `custom_attributes` has always been in the bot allowlist, and
    // the attribute must be attributed to the persona.
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    await c.setConversationCustomAttributes(61, { produto: "cadeira" });
    expect(cw.requests).toEqual([
      { method: "GET", path: "/conversations/61", token: "ADMIN_TOK" },
      {
        method: "POST",
        path: "/conversations/61/custom_attributes",
        token: "BOT_TOK",
      },
    ]);
  });

  test("a non-object bag is merged as empty, never spread", async () => {
    // Spreading an array yields index keys ({...["a"]} -> {"0":"a"}), and this merge result is
    // written straight back, so a malformed bag would be PERSISTED as real attributes named 0,1,2.
    const cw = fakeChatwootAttributeStore(5);
    const weird = (async (url: string, init?: RequestInit) => {
      if (
        (init?.method ?? "GET") === "GET" &&
        url.endsWith("/conversations/61")
      ) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ custom_attributes: ["lixo"] }),
        } as unknown as Response;
      }
      return (
        cw.fetchImpl as (u: string, i?: RequestInit) => Promise<Response>
      )(url, init);
    }) as unknown as typeof fetch;
    const c = await client(weird);
    await c.setConversationCustomAttributes(61, { produto: "cadeira" });
    expect(cw.conversations.get(61)).toEqual({ produto: "cadeira" });
  });

  test("writes to different targets are not serialized against each other", async () => {
    // The serialization has to be keyed by target. A single global lock would also make these two
    // tests pass, and would throttle every unrelated conversation in the process.
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    let peakConcurrent = 0;
    let inFlight = 0;
    const counting = (async (url: string, init?: RequestInit) => {
      inFlight += 1;
      peakConcurrent = Math.max(peakConcurrent, inFlight);
      try {
        return await (cw.fetchImpl as (u: string, i?: RequestInit) => unknown)(
          url,
          init,
        );
      } finally {
        inFlight -= 1;
      }
    }) as unknown as typeof fetch;
    const c2 = await client(counting);
    void c;
    await Promise.all([
      c2.setConversationCustomAttributes(61, { a: "1" }),
      c2.setConversationCustomAttributes(62, { b: "2" }),
      c2.setConversationCustomAttributes(63, { c: "3" }),
    ]);
    expect(peakConcurrent).toBeGreaterThan(1);
    expect(cw.conversations.get(61)).toEqual({ a: "1" });
    expect(cw.conversations.get(62)).toEqual({ b: "2" });
    expect(cw.conversations.get(63)).toEqual({ c: "3" });
  });
});
