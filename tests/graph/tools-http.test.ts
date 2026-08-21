import { describe, expect, test } from "bun:test";
import type { ToolMessage } from "@langchain/core/messages";
import type { z } from "zod";
import {
  buildHttpTool,
  type HttpToolDef,
  parseToolInputSchema,
  sanitizeToolName,
} from "@/graph/tools/http";

// 8.8.8.8 is a public IP literal: the SSRF guard treats it as an IP (no DNS lookup) and does not
// block it, so these tests never touch the network.
const PUBLIC = "8.8.8.8";

interface Captured {
  url?: string;
  init?: RequestInit;
}

function stubFetch(captured: Captured, status = 200, bodyText = '{"ok":true}') {
  return (async (url: string, init: RequestInit) => {
    captured.url = url;
    captured.init = init;
    return new Response(bodyText, {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

function def(over: Partial<HttpToolDef> = {}): HttpToolDef {
  return {
    name: "thing",
    method: "GET",
    urlTemplate: `https://${PUBLIC}/v1/thing`,
    allowedHosts: [PUBLIC],
    headers: {},
    inputSchema: {},
    credentialRef: null,
    ...over,
  };
}

describe("sanitizeToolName / schema", () => {
  test("sanitizes provider-invalid characters", () => {
    expect(sanitizeToolName("asaas payment.create")).toBe(
      "asaas_payment_create",
    );
  });

  test("normalizes accents (NFD), case, spaces and collapses underscores", () => {
    expect(sanitizeToolName("Busca por CPF/CNPJ")).toBe("busca_por_cpf_cnpj");
    expect(sanitizeToolName("Consultar Pedição")).toBe("consultar_pedicao");
    expect(sanitizeToolName("  Olá   Mundo  ")).toBe("ola_mundo");
    expect(sanitizeToolName("___")).toBe("tool");
  });

  test("empty schema → no declared args", () => {
    const schema = parseToolInputSchema({});
    expect(schema.safeParse({}).success).toBe(true);
  });
});

describe("buildHttpTool", () => {
  test("POST: credential into header, non-path fields into JSON body, never the URL", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        name: "asaas payment",
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/payments`,
        headers: { access_token: "{{secret}}" },
        inputSchema: {
          value: { type: "number", required: true },
          customer: { type: "string" },
        },
        credentialRef: "asaas-key",
      }),
      {
        resolveCredential: async () => "SECRET123",
        fetchImpl: stubFetch(captured),
      },
    );

    expect(tool.name).toBe("asaas_payment");
    const out = await tool.invoke({ value: 100, customer: "cus_1" });

    expect(captured.url).toBe(`https://${PUBLIC}/v3/payments`);
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.access_token).toBe("SECRET123");
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      value: 100,
      customer: "cus_1",
    });
    // credential never leaks into the URL or the model-visible return
    expect(captured.url).not.toContain("SECRET123");
    expect(String(out)).toContain("HTTP 200");
    expect(String(out)).not.toContain("SECRET123");
  });

  test("GET: path placeholder is encoded (no traversal), extras become query", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/things/{{id}}`,
        inputSchema: {
          id: { type: "string", required: true },
          q: { type: "string" },
        },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );

    await tool.invoke({ id: "../../admin", q: "hello world" });
    const url = new URL(captured.url as string);
    expect(url.pathname).toBe("/v1/things/..%2F..%2Fadmin");
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(captured.init?.body).toBeUndefined();
  });

  test("rejects when the host is not in the per-tool allowlist", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(def({ allowedHosts: ["1.1.1.1"] }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch(captured),
    });
    await expect(tool.invoke({})).rejects.toThrow(/allowlist/);
    expect(captured.url).toBeUndefined();
  });

  test("SSRF guard blocks a loopback target before any fetch", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        urlTemplate: "https://127.0.0.1/x",
        allowedHosts: ["127.0.0.1"],
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await expect(tool.invoke({})).rejects.toThrow();
    expect(captured.url).toBeUndefined();
  });
});

describe("buildHttpTool credential auto-injection (item 8)", () => {
  test("chatwoot_api_token kind injects the api-access-token header (no {{secret}} needed)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        headers: {},
        credentialRef: "cw",
        credentialKind: "chatwoot_api_token",
      }),
      {
        resolveCredential: async () => "CWTOKEN",
        fetchImpl: stubFetch(captured),
      },
    );
    await tool.invoke({});
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["api-access-token"]).toBe("CWTOKEN");
  });

  test("bearer_token kind injects Authorization: Bearer", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({ credentialRef: "k", credentialKind: "bearer_token" }),
      { resolveCredential: async () => "abc", fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({});
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer abc");
  });

  test("query kind without paramName does not auto-inject (paramName wired at assemble time)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({ credentialRef: "k", credentialKind: "query" }),
      { resolveCredential: async () => "qk", fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({});
    // resolveSecretInjection("query", ...) without paramName → null → no injection.
    expect(
      new URL(captured.url as string).searchParams.get("api_key"),
    ).toBeNull();
  });

  test("header kind + credentialParamName injects the named header", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        headers: {},
        credentialRef: "k",
        credentialKind: "header",
        credentialParamName: "X-Custom-Key",
      }),
      {
        resolveCredential: async () => "tok123",
        fetchImpl: stubFetch(captured),
      },
    );
    await tool.invoke({});
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["X-Custom-Key"]).toBe("tok123");
  });

  test("query kind + credentialParamName injects the named query param", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        headers: {},
        credentialRef: "k",
        credentialKind: "query",
        credentialParamName: "token",
      }),
      { resolveCredential: async () => "qval", fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({});
    expect(new URL(captured.url as string).searchParams.get("token")).toBe(
      "qval",
    );
  });

  test("a manually-set header wins over auto-injection", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        headers: { Authorization: "Bearer MANUAL" },
        credentialRef: "k",
        credentialKind: "bearer_token",
      }),
      { resolveCredential: async () => "abc", fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({});
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer MANUAL");
  });

  test("generic kind does NOT auto-inject (manual {{secret}} still works)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        headers: { "x-token": "{{secret}}" },
        credentialRef: "k",
        credentialKind: "generic",
      }),
      {
        resolveCredential: async () => "s3cr3t",
        fetchImpl: stubFetch(captured),
      },
    );
    await tool.invoke({});
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["x-token"]).toBe("s3cr3t");
    expect(headers.Authorization).toBeUndefined();
  });
});

describe("buildHttpTool — relative urlTemplate + credentialBaseUrl", () => {
  test("relative template + credentialBaseUrl resolves and dispatches to credential base host without extra allowedHosts", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: "/v1/contacts/{{id}}",
        credentialBaseUrl: `https://${PUBLIC}`,
        allowedHosts: [], // empty — host implicitly allowed via credential
        inputSchema: { id: { type: "string", required: true } },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ id: "c_123" });
    expect(captured.url).toMatch(
      new RegExp(`^https://${PUBLIC}/v1/contacts/c_123`),
    );
  });

  test("relative template without credentialBaseUrl → throws at build time", () => {
    expect(() =>
      buildHttpTool(
        def({
          urlTemplate: "/v1/items",
          credentialBaseUrl: null,
          allowedHosts: [],
        }),
        { resolveCredential: async () => null },
      ),
    ).toThrow(/relative urlTemplate requires a credential with a base URL/);
  });

  test("absolute template ignores credentialBaseUrl (existing behavior unchanged)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        urlTemplate: `https://${PUBLIC}/v1/things`,
        credentialBaseUrl: "https://1.1.1.1",
        allowedHosts: [PUBLIC],
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({});
    expect(captured.url).toBe(`https://${PUBLIC}/v1/things`);
  });

  test("origin guard still catches malicious interpolation in a relative template", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: "/v1/items/{{id}}",
        credentialBaseUrl: `https://${PUBLIC}`,
        allowedHosts: [],
        inputSchema: { id: { type: "string", required: true } },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    // A value that tries to change the origin via URL encoding should fail: encodeURIComponent
    // turns "@" into "%40", so the origin stays the same and the path just looks weird.
    // This confirms the value is properly encoded, never breaking out to a new origin.
    await tool.invoke({ id: "evil@1.1.1.1" });
    const url = new URL(captured.url as string);
    expect(url.hostname).toBe(PUBLIC);
    expect(url.pathname).toContain("evil%40");
  });
});

describe("buildHttpTool slow-tool ack (item 4)", () => {
  test("posts the ack BEFORE the fetch when ackMessage is set + emitAck wired", async () => {
    const order: string[] = [];
    const captured: Captured = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      order.push("fetch");
      captured.url = url;
      captured.init = init;
      return new Response('{"ok":true}', {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const tool = buildHttpTool(def({ ackMessage: "Já verifico pra você…" }), {
      resolveCredential: async () => null,
      fetchImpl,
      emitAck: async (m) => {
        order.push(`ack:${m}`);
      },
    });
    // The model MUST write the holding message (__wait_message is required); the operator's ackMessage
    // is only the tone example and is never sent verbatim.
    await tool.invoke({ __wait_message: "Só um momento!" });
    expect(order).toEqual(["ack:Só um momento!", "fetch"]);
  });

  test("__wait_message is required (non-empty) in the schema when ackMessage is set", () => {
    const tool = buildHttpTool(def({ ackMessage: "One sec…" }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch({}),
    });
    const schema = tool.schema as z.ZodTypeAny;
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ __wait_message: "" }).success).toBe(false);
    expect(schema.safeParse({ __wait_message: "Checking…" }).success).toBe(
      true,
    );
  });

  test("rejects the call (no ack, no request) when __wait_message is missing", async () => {
    const captured: Captured = {};
    const acks: string[] = [];
    const tool = buildHttpTool(def({ ackMessage: "One sec…" }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch(captured),
      emitAck: async (m) => {
        acks.push(m);
      },
    });
    await expect(tool.invoke({})).rejects.toThrow();
    expect(acks).toEqual([]);
    expect(captured.url).toBeUndefined();
  });

  test("a whitespace-only __wait_message returns an error and runs neither the ack nor the request", async () => {
    const captured: Captured = {};
    const acks: string[] = [];
    const tool = buildHttpTool(def({ ackMessage: "One sec…" }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch(captured),
      emitAck: async (m) => {
        acks.push(m);
      },
    });
    // Passes the schema's min(1) but the exec guard trims and refuses, returning an error string the
    // model sees (so it retries) — without ever sending a blank ack or hitting the endpoint.
    const result = await tool.invoke({ __wait_message: "   " });
    expect(String(result)).toContain("wait message is required");
    expect(acks).toEqual([]);
    expect(captured.url).toBeUndefined();
  });

  test("no ack when ackMessage is null (default)", async () => {
    const order: string[] = [];
    const captured: Captured = {};
    const tool = buildHttpTool(def({ ackMessage: null }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch(captured),
      emitAck: async (m) => {
        order.push(`ack:${m}`);
      },
    });
    await tool.invoke({});
    expect(order).toEqual([]);
  });

  test("ack arg still required but simply not sent when emitAck is absent (playground)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(def({ ackMessage: "Já verifico…" }), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch(captured),
    });
    // The model still writes __wait_message; with no emitAck wired it is a no-op and the call runs.
    await tool.invoke({ __wait_message: "Checando…" });
    expect(captured.url).toBeDefined();
  });
});

describe("buildHttpTool — n8n model (fixed fields, context, raw body, dynamic ack)", () => {
  test("a spec without source defaults to AI (in the schema); fixed is excluded", () => {
    const aiSchema = parseToolInputSchema({
      x: { type: "string", required: true },
    });
    expect(aiSchema.safeParse({ x: "a" }).success).toBe(true);
    expect(aiSchema.safeParse({}).success).toBe(false);

    const fixedSchema = parseToolInputSchema({
      y: { source: "fixed", value: "v" },
    });
    expect("y" in fixedSchema.shape).toBe(false);
    expect(fixedSchema.safeParse({}).success).toBe(true);
  });

  test("fixed field is sent with its context-interpolated value, not asked of the model", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/payments`,
        inputSchema: {
          amount: { type: "number", required: true },
          conv: { source: "fixed", value: "{{conversation_id}}" },
        },
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: { conversation_id: "42" },
      },
    );
    await tool.invoke({ amount: 100 });
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      amount: 100,
      conv: "42",
    });
  });

  test("context placeholder resolves in the URL", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/conversations/{{conversation_id}}`,
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: { conversation_id: "42" },
      },
    );
    await tool.invoke({});
    expect(new URL(captured.url as string).pathname).toBe(
      "/v1/conversations/42",
    );
  });

  test("new native context vars (message_id/contact_id/inbox_id/agent_name) resolve in URL + body", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v1/inboxes/{{inbox_id}}/contacts/{{contact_id}}`,
        body: {
          mode: "raw",
          raw: '{"msg":"{{message_id}}","agent":"{{agent_name}}"}',
        },
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: {
          inbox_id: "7",
          contact_id: "99",
          message_id: "555",
          agent_name: "Joãozinho",
        },
      },
    );
    await tool.invoke({});
    expect(new URL(captured.url as string).pathname).toBe(
      "/v1/inboxes/7/contacts/99",
    );
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      msg: "555",
      agent: "Joãozinho",
    });
  });

  test("raw body mode sends the interpolated template (AI + context)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        inputSchema: { name: { type: "string", required: true } },
        body: {
          mode: "raw",
          raw: '{"who":"{{name}}","conv":"{{conversation_id}}"}',
        },
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: { conversation_id: "42" },
      },
    );
    await tool.invoke({ name: "Maria" });
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      who: "Maria",
      conv: "42",
    });
  });

  test("{{secret}} resolves wherever written (header, URL, body), never in the model return", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x?token={{secret}}`,
        headers: { authorization: "Bearer {{secret}}" },
        body: { mode: "raw", raw: '{"t":"{{secret}}"}' },
        credentialRef: "k",
      }),
      {
        resolveCredential: async () => "TOPSECRET",
        fetchImpl: stubFetch(captured),
      },
    );
    // No model arg supplies the secret — it comes only from the resolved credential.
    const out = await tool.invoke({});
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer TOPSECRET");
    expect(captured.url).toContain("token=TOPSECRET");
    expect(captured.init?.body as string).toContain("TOPSECRET");
    // The secret still never reaches the model-visible return.
    expect(String(out)).not.toContain("TOPSECRET");
  });

  test("dynamic ack: the model's __wait_message is used and never sent in the request body", async () => {
    const captured: Captured = {};
    const acks: string[] = [];
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        inputSchema: { name: { type: "string" } },
        ackMessage: "One sec…",
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        emitAck: async (m) => {
          acks.push(m);
        },
      },
    );
    await tool.invoke({ name: "Maria", __wait_message: "Checking now!" });
    expect(acks).toEqual(["Checking now!"]);
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      name: "Maria",
    });

    // No static fallback: omitting __wait_message is a schema violation, so the model is forced to
    // retry with a message instead of silently sending the operator's tone example.
    acks.length = 0;
    await expect(tool.invoke({ name: "João" })).rejects.toThrow();
    expect(acks).toEqual([]);
  });
});

describe("buildHttpTool — extended AI types (enum/integer/array/object)", () => {
  test("enum: accepts a listed value, rejects others", () => {
    const schema = parseToolInputSchema({
      status: { type: "enum", enumValues: ["open", "closed"], required: true },
    });
    expect(schema.safeParse({ status: "open" }).success).toBe(true);
    expect(schema.safeParse({ status: "pending" }).success).toBe(false);
  });

  test("enum with no values falls back to a free string", () => {
    const schema = parseToolInputSchema({
      status: { type: "enum", enumValues: [] },
    });
    expect(schema.safeParse({ status: "anything" }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true); // optional
  });

  test("integer rejects a non-integer", () => {
    const schema = parseToolInputSchema({
      n: { type: "integer", required: true },
    });
    expect(schema.safeParse({ n: 3 }).success).toBe(true);
    expect(schema.safeParse({ n: 3.5 }).success).toBe(false);
  });

  test("array of integer keeps its type in the kv body", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        inputSchema: {
          ids: { type: "array", itemType: "integer", required: true },
        },
        body: { mode: "kv", rows: [{ key: "ids", value: "{{ids}}" }] },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ ids: [1, 2, 3] });
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      ids: [1, 2, 3],
    });
  });

  test("object keeps its nested structure in the kv body", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        inputSchema: { data: { type: "object", required: true } },
        body: { mode: "kv", rows: [{ key: "payload", value: "{{data}}" }] },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ data: { a: 1, b: ["x", "y"] } });
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      payload: { a: 1, b: ["x", "y"] },
    });
  });
});

describe("buildHttpTool — kv body assembly", () => {
  test("lone {{aiField}} keeps its type; a literal row stays a string", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        inputSchema: { value: { type: "number", required: true } },
        body: {
          mode: "kv",
          rows: [
            { key: "value", value: "{{value}}" },
            { key: "note", value: "fixed-text" },
          ],
        },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ value: 100 });
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      value: 100,
      note: "fixed-text",
    });
  });

  test("a lone context placeholder resolves to a string", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        body: {
          mode: "kv",
          rows: [{ key: "conv", value: "{{conversation_id}}" }],
        },
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: { conversation_id: "42" },
      },
    );
    await tool.invoke({});
    expect(JSON.parse(captured.init?.body as string)).toEqual({ conv: "42" });
  });

  test('an optional aiField the model omits is dropped (never emitted as "")', async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        inputSchema: { opt: { type: "string" } },
        body: { mode: "kv", rows: [{ key: "opt", value: "{{opt}}" }] },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({});
    expect(JSON.parse(captured.init?.body as string)).toEqual({});
  });
});

describe("buildHttpTool — query params (any method)", () => {
  test("explicit query applies on POST alongside the body", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v3/x`,
        query: { trace: "{{conversation_id}}" },
        body: { mode: "kv", rows: [{ key: "x", value: "1" }] },
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: { conversation_id: "42" },
      },
    );
    await tool.invoke({});
    const url = new URL(captured.url as string);
    expect(url.searchParams.get("trace")).toBe("42");
    expect(JSON.parse(captured.init?.body as string)).toEqual({ x: "1" });
  });

  test("query value is encoded once (no double-encode)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({ method: "GET", query: { q: "hello world" } }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
      },
    );
    await tool.invoke({});
    expect(new URL(captured.url as string).searchParams.get("q")).toBe(
      "hello world",
    );
    expect(captured.url).not.toContain("%2520");
  });

  test("{{secret}} resolves in a query value and never leaks to the return", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        query: { token: "{{secret}}" },
        credentialRef: "k",
      }),
      {
        resolveCredential: async () => "SECRET",
        fetchImpl: stubFetch(captured),
      },
    );
    const out = await tool.invoke({});
    expect(new URL(captured.url as string).searchParams.get("token")).toBe(
      "SECRET",
    );
    expect(String(out)).not.toContain("SECRET");
  });

  test("explicit query suppresses the legacy fields→query derivation", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        inputSchema: { foo: { type: "string" } },
        query: { bar: "static" },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ foo: "X" });
    const url = new URL(captured.url as string);
    expect(url.searchParams.get("bar")).toBe("static");
    expect(url.searchParams.get("foo")).toBeNull();
  });

  test("legacy GET (no query) still derives non-path fields into the query", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        inputSchema: { foo: { type: "string" } },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ foo: "X" });
    expect(new URL(captured.url as string).searchParams.get("foo")).toBe("X");
  });
});

describe("buildHttpTool — programmatic authoring shapes (JSON-Schema input_schema + single-brace placeholders)", () => {
  // NOTE: the natural shapes an API/MCP author writes: standard JSON Schema for the input and
  // OpenAPI-style single-brace path params. Both must work (converted/normalized), not fail silently.
  const JSON_SCHEMA_INPUT = {
    required: ["valor"],
    properties: { valor: { type: "string" } },
  };

  test("JSON-Schema input_schema exposes the real fields, not the schema keywords", () => {
    const schema = parseToolInputSchema(JSON_SCHEMA_INPUT);
    expect("valor" in schema.shape).toBe(true);
    expect("properties" in schema.shape).toBe(false);
    expect("required" in schema.shape).toBe(false);
    expect(schema.safeParse({}).success).toBe(false); // valor is required
    expect(schema.safeParse({ valor: "TESTE123" }).success).toBe(true);
  });

  test("single-brace path var + JSON-Schema input: the argument reaches the URL", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/anything/{valor}`,
        inputSchema: JSON_SCHEMA_INPUT,
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ valor: "TESTE123" });
    expect(new URL(captured.url as string).pathname).toBe("/anything/TESTE123");
  });

  test("two single-brace path vars (compact schema) both substitute", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/debug-echo/{nome_cliente}/{faixa_etaria}`,
        inputSchema: {
          nome_cliente: { type: "string", required: true },
          faixa_etaria: { type: "string", required: true },
        },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ nome_cliente: "Maria", faixa_etaria: "30-40" });
    expect(new URL(captured.url as string).pathname).toBe(
      "/debug-echo/Maria/30-40",
    );
  });

  test("single-brace value in the query dict resolves to the argument", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        inputSchema: { nome_cliente: { type: "string", required: true } },
        query: { nome_cliente: "{nome_cliente}" },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ nome_cliente: "Maria" });
    expect(
      new URL(captured.url as string).searchParams.get("nome_cliente"),
    ).toBe("Maria");
  });

  test("single-brace value in a header resolves to the argument", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        inputSchema: { nome_cliente: { type: "string", required: true } },
        headers: { "X-Nome-Cliente": "{nome_cliente}" },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ nome_cliente: "Maria" });
    const headers = captured.init?.headers as Record<string, string>;
    expect(headers["X-Nome-Cliente"]).toBe("Maria");
  });

  test("POST with empty body config + JSON-Schema input: args land in the JSON body", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        inputSchema: JSON_SCHEMA_INPUT,
        body: {},
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ valor: "TESTE123" });
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      valor: "TESTE123",
    });
  });

  // NOTE: the three "empty" spellings send three different things, and a body-shape refusal that
  // called `{}` "no body" got the first one wrong (issue #150). Pinned together so the contract the
  // REST/MCP descriptions state has something to be checked against.
  test("the three empty body spellings are not interchangeable", async () => {
    const cases: [unknown, string][] = [
      // `{}` is the legacy fallback, NOT an empty request.
      [{}, JSON.stringify({ valor: "TESTE123" })],
      [{ mode: "kv", rows: [] }, "{}"],
      [{ mode: "raw", raw: "" }, ""],
    ];
    for (const [body, want] of cases) {
      const captured: Captured = {};
      const tool = buildHttpTool(
        def({
          method: "POST",
          urlTemplate: `https://${PUBLIC}/v1/x`,
          inputSchema: JSON_SCHEMA_INPUT,
          body,
        }),
        { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
      );
      await tool.invoke({ valor: "TESTE123" });
      expect(captured.init?.body ?? "").toBe(want);
    }
  });

  test("single-brace context var resolves in the URL", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/conversations/{conversation_id}`,
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: { conversation_id: "42" },
      },
    );
    await tool.invoke({});
    expect(new URL(captured.url as string).pathname).toBe(
      "/v1/conversations/42",
    );
  });

  test("a single-brace token matching nothing declared stays literal (raw body)", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "POST",
        urlTemplate: `https://${PUBLIC}/v1/x`,
        inputSchema: { name: { type: "string", required: true } },
        body: {
          mode: "raw",
          raw: '{"who":"{{name}}","tpl":"{unknown_token}"}',
        },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    await tool.invoke({ name: "Maria" });
    expect(JSON.parse(captured.init?.body as string)).toEqual({
      who: "Maria",
      tpl: "{unknown_token}",
    });
  });

  test("{{secret}} in the URL with no resolvable credential throws a config error, no fetch", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x?token={{secret}}`,
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    // NOTE: a missing credential is operator config, not model input: the model must never be told to
    // retry with a "secret" field.
    await expect(tool.invoke({})).rejects.toThrow(/credential/);
    expect(captured.url).toBeUndefined();
  });

  test("a fixed URL field depending on an unavailable {{secret}} throws, no fetch", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/x/{{token}}`,
        inputSchema: { token: { source: "fixed", value: "{{secret}}" } },
        credentialRef: "k",
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    // NOTE: the fixed value resolves to "" (headers/body semantics), but the URL guard must still refuse
    // to fetch an incomplete URL and name the credential as the root cause.
    await expect(tool.invoke({})).rejects.toThrow(/credential/);
    expect(captured.url).toBeUndefined();
  });

  test("a missing context variable in the URL throws (a retry hint would loop), no fetch", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/contacts/{{contact_email}}`,
      }),
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch(captured),
        context: {},
      },
    );
    // NOTE: context vars are injected by the platform; the model can never supply them.
    await expect(tool.invoke({})).rejects.toThrow(/contact_email/);
    expect(captured.url).toBeUndefined();
  });

  test("unresolved URL placeholder returns an instructive error to the model, no fetch", async () => {
    const captured: Captured = {};
    const tool = buildHttpTool(
      def({
        method: "GET",
        urlTemplate: `https://${PUBLIC}/v1/things/{{id}}`,
        inputSchema: { id: { type: "string" } },
      }),
      { resolveCredential: async () => null, fetchImpl: stubFetch(captured) },
    );
    const out = await tool.invoke({});
    expect(String(out)).toContain("id");
    expect(String(out).toLowerCase()).toContain("error");
    expect(captured.url).toBeUndefined();
  });
});

// NOTE: A tool may DECLARE the statuses that are results rather than failures (issue #59). The
// model-facing text is identical either way — same "HTTP <status>" with the same body — so only the
// failure marking, and therefore the log level and the alert dispatch, moves.
describe("buildHttpTool — declared expected statuses (issue #59)", () => {
  async function callWith(status: number, expectedStatuses?: number[]) {
    const tool = buildHttpTool(
      { ...def(), ...(expectedStatuses ? { expectedStatuses } : {}) },
      {
        resolveCredential: async () => null,
        fetchImpl: stubFetch({}, status, '{"found":false}'),
      },
    );
    return (await tool.invoke({
      type: "tool_call",
      id: `call_es_${status}`,
      name: "thing",
      args: {},
    })) as ToolMessage;
  }

  test("a declared 404 stops being an integration failure", async () => {
    const out = await callWith(404, [404]);
    expect(out.status).toBe("success");
  });

  test("the model sees exactly the same text either way", async () => {
    const declared = await callWith(404, [404]);
    const undeclared = await callWith(404);
    expect(String(declared.content)).toContain("HTTP 404");
    expect(String(declared.content)).toBe(String(undeclared.content));
  });

  test("an undeclared status on the same tool is still a failure", async () => {
    const out = await callWith(500, [404]);
    expect(out.status).toBe("error");
  });

  // The reason this is a list and not a range: an operator declaring "not found is data" must not
  // silently stop hearing about the credential failures next to it.
  test("declaring 404 does not cover 401 or 403", async () => {
    for (const s of [401, 403]) {
      const out = await callWith(s, [404]);
      expect(out.status).toBe("error");
    }
  });

  test("an empty declaration leaves issue #40 exactly as it was", async () => {
    const out = await callWith(404, []);
    expect(out.status).toBe("error");
  });
});

// NOTE: For operator-authored HTTP tools EVERY non-2xx is an integration failure (issue #40):
// invoked as a tool_call it returns a ToolMessage with status "error" carrying the same
// "HTTP <status>" body the model already saw; 2xx stays a plain success.
describe("buildHttpTool — non-2xx marked as integration failure (issue #40)", () => {
  test("HTTP 500 and HTTP 404 return ToolMessage status error; 200 stays success", async () => {
    for (const [status, id] of [
      [500, "call_h1"],
      [404, "call_h2"],
    ] as const) {
      const tool = buildHttpTool(def(), {
        resolveCredential: async () => null,
        fetchImpl: stubFetch({}, status, '{"err":true}'),
      });
      const out = (await tool.invoke({
        type: "tool_call",
        id,
        name: "thing",
        args: {},
      })) as ToolMessage;
      expect(out.status).toBe("error");
      expect(String(out.content)).toContain(`HTTP ${status}`);
    }
    const ok = buildHttpTool(def(), {
      resolveCredential: async () => null,
      fetchImpl: stubFetch({}, 200),
    });
    const okOut = (await ok.invoke({
      type: "tool_call",
      id: "call_h3",
      name: "thing",
      args: {},
    })) as ToolMessage;
    expect(okOut.status).toBe("success");
    expect(String(okOut.content)).toContain("HTTP 200");
  });
});
