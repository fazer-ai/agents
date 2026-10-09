import { describe, expect, test } from "bun:test";
import {
  ChatwootCalledOffError,
  createChatwootClient,
} from "@/modules/chatwoot/client";
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
    // The deterministic half, visible without a burst: the tool sends ONE key and the
    // endpoint assigns the whole hash, so a plain write would erase every other attribute.
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

  test("conversation writes asked together go out as one read and one write", async () => {
    // Three rules of one decision, or three tool calls of one model response: each round trip is
    // time the conversation waits, and the endpoint takes the whole bag anyway.
    const cw = fakeChatwootAttributeStore(5, {
      conversations: { 61: { origem: "Instagram" } },
    });
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setConversationCustomAttributes(61, { produto: "cadeira" }),
      c.setConversationCustomAttributes(61, { medida: "90cm" }),
      c.setConversationCustomAttributes(61, { produto: "mesa" }),
    ]);
    expect(cw.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "GET /conversations/61",
      "POST /conversations/61/custom_attributes",
    ]);
    // In the order the calls were made: the later value for one key is the one that stays.
    expect(cw.conversations.get(61)).toEqual({
      origem: "Instagram",
      produto: "mesa",
      medida: "90cm",
    });
  });

  test("calls asked to go alone are one read and one write each, and nobody joins them", async () => {
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setConversationCustomAttributes(61, { produto: "cadeira" }),
      c.setConversationCustomAttributes(
        61,
        { medida: "90cm" },
        { alone: () => true },
      ),
      c.setConversationCustomAttributes(61, { produto: "mesa" }),
    ]);
    expect(cw.requests.map((r) => r.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    expect(cw.conversations.get(61)).toEqual({
      produto: "mesa",
      medida: "90cm",
    });
  });

  test("calls that joined before their fence asked them to go alone are split, in order", async () => {
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    let alone = false;
    let fences = 0;
    const opts = {
      alone: () => alone,
      stillWanted: async () => {
        fences++;
        alone = true;
        return true;
      },
    };
    await Promise.all([
      c.setConversationCustomAttributes(61, { produto: "cadeira" }, opts),
      c.setConversationCustomAttributes(61, { medida: "90cm" }, opts),
      c.setConversationCustomAttributes(61, { produto: "mesa" }, opts),
    ]);
    expect(cw.requests.map((r) => r.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    // Each of the two that were held back is asked again, after the write ahead of it.
    expect(fences).toBe(3);
    expect(cw.conversations.get(61)).toEqual({
      produto: "mesa",
      medida: "90cm",
    });
  });

  test("a writer queued while a joined write was read stays behind every call that write is split into", async () => {
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    const other = await client(cw.fetchImpl);
    let alone = false;
    let queued: Promise<unknown> | null = null;
    const opts = {
      alone: () => alone,
      stillWanted: async () => {
        // Another client's write arrives while the two joined calls are being decided.
        queued ??= other.setConversationCustomAttributes(61, {
          produto: "de-outro",
        });
        alone = true;
        return true;
      },
    };
    await Promise.all([
      c.setConversationCustomAttributes(61, { medida: "90cm" }, opts),
      c.setConversationCustomAttributes(61, { produto: "mesa" }, opts),
    ]);
    await queued;
    expect(cw.conversations.get(61)).toEqual({
      medida: "90cm",
      produto: "de-outro",
    });
  });

  test("a call that was called off is left out of the shared write and rejected alone", async () => {
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    const settled = await Promise.allSettled([
      c.setConversationCustomAttributes(61, { produto: "cadeira" }),
      c.setConversationCustomAttributes(
        61,
        { medida: "90cm" },
        { stillWanted: async () => false },
      ),
      c.setConversationCustomAttributes(
        61,
        { quantidade: "4" },
        { stillWanted: async () => true },
      ),
    ]);
    expect(settled.map((r) => r.status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
    expect((settled[1] as PromiseRejectedResult).reason).toBeInstanceOf(
      ChatwootCalledOffError,
    );
    expect(cw.conversations.get(61)).toEqual({
      produto: "cadeira",
      quantidade: "4",
    });
  });

  test("when every call was called off nothing is written", async () => {
    const cw = fakeChatwootAttributeStore(5, {
      conversations: { 61: { origem: "Instagram" } },
    });
    const c = await client(cw.fetchImpl);
    let asked = 0;
    const off = async () => {
      asked += 1;
      return false;
    };
    const settled = await Promise.allSettled([
      c.setConversationCustomAttributes(61, { a: "1" }, { stillWanted: off }),
      c.setConversationCustomAttributes(61, { b: "2" }, { stillWanted: off }),
    ]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    // One fence, asked once for the calls that share it.
    expect(asked).toBe(1);
    expect(cw.requests.filter((r) => r.method === "POST")).toEqual([]);
    expect(cw.conversations.get(61)).toEqual({ origem: "Instagram" });
  });

  test("a write Chatwoot refuses fails the calls that rode on it, and the next call is its own", async () => {
    const cw = fakeChatwootAttributeStore(5);
    let refuse = true;
    const flaky = (async (url: string, init?: RequestInit) => {
      if (refuse && init?.method === "POST") {
        return { ok: false, status: 500, text: async () => "" } as Response;
      }
      return (
        cw.fetchImpl as (u: string, i?: RequestInit) => Promise<Response>
      )(url, init);
    }) as unknown as typeof fetch;
    const c = await client(flaky);
    const settled = await Promise.allSettled([
      c.setConversationCustomAttributes(61, { a: "1" }),
      c.setConversationCustomAttributes(61, { b: "2" }),
    ]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    refuse = false;
    await c.setConversationCustomAttributes(61, { c: "3" });
    // Nothing of the failed calls is carried into a later write.
    expect(cw.conversations.get(61)).toEqual({ c: "3" });
  });

  test("a read Chatwoot refuses fails the calls waiting on it, and the next call is its own", async () => {
    const cw = fakeChatwootAttributeStore(5);
    let refuse = true;
    const flaky = (async (url: string, init?: RequestInit) => {
      if (refuse && (init?.method ?? "GET") === "GET") {
        return { ok: false, status: 500, text: async () => "" } as Response;
      }
      return (
        cw.fetchImpl as (u: string, i?: RequestInit) => Promise<Response>
      )(url, init);
    }) as unknown as typeof fetch;
    const c = await client(flaky);
    const settled = await Promise.allSettled([
      c.setConversationCustomAttributes(61, { a: "1" }),
      c.setConversationCustomAttributes(61, { b: "2" }),
    ]);
    expect(settled.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    refuse = false;
    await c.setConversationCustomAttributes(61, { c: "3" });
    expect(cw.conversations.get(61)).toEqual({ c: "3" });
  });

  test("a call that arrives once the bag was read gets a read and a write of its own", async () => {
    const cw = fakeChatwootAttributeStore(5);
    let posts = 0;
    let release!: () => void;
    const slow = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        posts += 1;
        // The first write is held, so the second call arrives after its read has come back.
        if (posts === 1) await new Promise<void>((r) => (release = r));
      }
      return (
        cw.fetchImpl as (u: string, i?: RequestInit) => Promise<Response>
      )(url, init);
    }) as unknown as typeof fetch;
    const c = await client(slow);
    const first = c.setConversationCustomAttributes(61, { a: "1" });
    while (posts === 0) await new Promise((r) => setTimeout(r, 1));
    const second = c.setConversationCustomAttributes(61, { b: "2" });
    await new Promise((r) => setTimeout(r, 5));
    release();
    await Promise.all([first, second]);
    expect(cw.requests.map((r) => r.method)).toEqual([
      "GET",
      "POST",
      "GET",
      "POST",
    ]);
    expect(cw.conversations.get(61)).toEqual({ a: "1", b: "2" });
  });

  // Only the entry at the tail of the queue can be joined. A call merged with an earlier entry
  // across something queued in between would be written ahead of it.
  test("a write asked after the reset's clear is not merged ahead of it", async () => {
    const cw = fakeChatwootAttributeStore(5, {
      conversations: { 61: { origem: "Instagram" } },
    });
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setConversationCustomAttributes(61, { antes: "1" }),
      c.clearConversationCustomAttributes(61),
      c.setConversationCustomAttributes(61, { depois: "2" }),
    ]);
    expect(cw.conversations.get(61)).toEqual({ depois: "2" });
  });

  test("bot, admin and bot writes to one key leave the last value", async () => {
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setConversationCustomAttributes(61, { etapa: "primeira" }),
      c.setConversationCustomAttributes(
        61,
        { etapa: "segunda" },
        { asAdmin: true },
      ),
      c.setConversationCustomAttributes(61, { etapa: "terceira" }),
    ]);
    expect(
      cw.requests.filter((r) => r.method === "POST").map((r) => r.token),
    ).toEqual(["BOT_TOK", "ADMIN_TOK", "BOT_TOK"]);
    expect(cw.conversations.get(61)).toEqual({ etapa: "terceira" });
  });

  test("another client's write queued in between is not jumped", async () => {
    const cw = fakeChatwootAttributeStore(5);
    const one = await client(cw.fetchImpl);
    const other = await client(cw.fetchImpl);
    await Promise.all([
      one.setConversationCustomAttributes(61, { etapa: "a" }),
      other.setConversationCustomAttributes(61, { etapa: "b" }),
      one.setConversationCustomAttributes(61, { etapa: "c" }),
    ]);
    expect(cw.requests.filter((r) => r.method === "POST")).toHaveLength(3);
    expect(cw.conversations.get(61)).toEqual({ etapa: "c" });
  });

  test("an admin write and a bot write to one conversation do not ride together", async () => {
    const cw = fakeChatwootAttributeStore(5);
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setConversationCustomAttributes(61, { a: "1" }),
      c.setConversationCustomAttributes(61, { b: "2" }, { asAdmin: true }),
    ]);
    expect(
      cw.requests.filter((r) => r.method === "POST").map((r) => r.token),
    ).toEqual(["BOT_TOK", "ADMIN_TOK"]);
    expect(cw.conversations.get(61)).toEqual({ a: "1", b: "2" });
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
    // `conversations#show` is bot-accessible only in Chatwoot builds from 2026-06-05 on, so a
    // bot-token read 401s on older instances and takes the write down with it. The write stays on
    // the bot token (`custom_attributes` is in the bot allowlist) so it is attributed to the persona.
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

  test("a key named __proto__ survives the merge, in the bag and in a call", async () => {
    // The endpoint replaces the bag, so a key the merge drops is a key the write erases.
    const cw = fakeChatwootAttributeStore(5);
    const bodies: string[] = [];
    const odd = (async (url: string, init?: RequestInit) => {
      if (
        (init?.method ?? "GET") === "GET" &&
        url.endsWith("/conversations/61")
      ) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            '{"custom_attributes":{"__proto__":"guardado","origem":"site"}}',
        } as unknown as Response;
      }
      if (init?.method === "POST") bodies.push(String(init.body));
      return (
        cw.fetchImpl as (u: string, i?: RequestInit) => Promise<Response>
      )(url, init);
    }) as unknown as typeof fetch;
    const c = await client(odd);
    await Promise.all([
      c.setConversationCustomAttributes(61, { produto: "cadeira" }),
      c.setConversationCustomAttributes(
        61,
        JSON.parse('{"__proto__":"novo"}') as Record<string, unknown>,
      ),
    ]);
    expect(bodies).toEqual([
      '{"custom_attributes":{"__proto__":"novo","origem":"site","produto":"cadeira"}}',
    ]);
    const alone = await client(odd);
    bodies.length = 0;
    await alone.setConversationCustomAttributes(61, { produto: "mesa" });
    expect(bodies).toEqual([
      '{"custom_attributes":{"__proto__":"guardado","origem":"site","produto":"mesa"}}',
    ]);
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

describe("kanban card attribute writes against the replacing tasks#update", () => {
  test("a card write keeps the attributes already on the card", async () => {
    const cw = fakeChatwootAttributeStore(5, {
      tasks: { 4: { faturamento_mensal: "15 mil" } },
    });
    const c = await client(cw.fetchImpl);
    await c.setKanbanTaskCustomAttributes(4, {
      servico_interesse: "Abertura de empresa",
    });
    expect(cw.tasks.get(4)).toEqual({
      faturamento_mensal: "15 mil",
      servico_interesse: "Abertura de empresa",
    });
  });

  test("concurrent card writes in one turn all survive", async () => {
    const cw = fakeChatwootAttributeStore(5, { tasks: { 4: { origem: "x" } } });
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setKanbanTaskCustomAttributes(4, { a: "1" }),
      c.setKanbanTaskCustomAttributes(4, { b: "2" }),
      c.setKanbanTaskCustomAttributes(4, { a: "3" }),
    ]);
    expect(cw.tasks.get(4)).toEqual({ origem: "x", a: "3", b: "2" });
  });

  test("a card that cannot be read is not written", async () => {
    const cw = fakeChatwootAttributeStore(5, {
      tasks: { 4: { faturamento_mensal: "15 mil" } },
    });
    const failingRead = (async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return { ok: false, status: 500, text: async () => "" } as Response;
      }
      return (
        cw.fetchImpl as (u: string, i?: RequestInit) => Promise<Response>
      )(url, init);
    }) as unknown as typeof fetch;
    const c = await client(failingRead);
    await expect(
      c.setKanbanTaskCustomAttributes(4, { servico_interesse: "x" }),
    ).rejects.toThrow();
    expect(cw.requests.filter((r) => r.method === "PATCH")).toEqual([]);
    expect(cw.tasks.get(4)).toEqual({ faturamento_mensal: "15 mil" });
  });

  test("a card write called off while it read the card is not sent", async () => {
    const cw = fakeChatwootAttributeStore(5, { tasks: { 4: { a: "1" } } });
    const c = await client(cw.fetchImpl);
    await expect(
      c.setKanbanTaskCustomAttributes(
        4,
        { b: "2" },
        { stillWanted: async () => false },
      ),
    ).rejects.toBeInstanceOf(ChatwootCalledOffError);
    expect(cw.requests.map((r) => r.method)).toEqual(["GET"]);
    expect(cw.tasks.get(4)).toEqual({ a: "1" });
  });

  test("the reset still empties the card, behind a write already queued", async () => {
    const cw = fakeChatwootAttributeStore(5, {
      tasks: { 4: { faturamento_mensal: "15 mil" } },
    });
    const c = await client(cw.fetchImpl);
    await Promise.all([
      c.setKanbanTaskCustomAttributes(4, { a: "1" }),
      c.clearKanbanTaskCustomAttributes(4),
    ]);
    expect(cw.tasks.get(4)).toEqual({});
  });
});
