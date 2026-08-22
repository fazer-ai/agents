import { describe, expect, test } from "bun:test";
import { SsrfError } from "@/lib/ssrf";
import {
  buildAuthorizationRequest,
  type ContactIdentity,
  channelSlug,
  checkContactAuthorization,
  classifyAuthorizationResponse,
  credentialTakesIdentityParam,
  MAX_RESPONSE_BYTES,
  MESSAGE_TEXT_MAX,
  reasonSlug,
} from "@/modules/contact-auth/check";
import {
  CONTACT_AUTH_DEFAULTS,
  type ContactAuthConfig,
} from "@/modules/contact-auth/settings";

// The request/response contract of docs/contact-auth.md, pinned as a decision table. The verdict
// decides whether a customer is served at all, so every ambiguous answer (a 2xx without the
// boolean, prose where a code belongs, a body too big to be a verdict) must land on the fail-closed
// side deliberately, not by accident of a parser.

const IDENTITY: ContactIdentity = {
  phone: "+5511988887777",
  name: "Cliente Exemplo",
  email: "cliente@example.com",
  identifier: "client-4821",
  chatwootContactId: 42,
  conversationId: 901,
  inboxId: 7,
  channel: "whatsapp",
  messageText: null,
};

function cfg(over: Partial<ContactAuthConfig> = {}): ContactAuthConfig {
  return {
    ...CONTACT_AUTH_DEFAULTS,
    enabled: true,
    url: "https://api.example.com/authorize",
    ...over,
  };
}

const okUrl = async (u: string) => new URL(u);

describe("classifyAuthorizationResponse", () => {
  test("2xx with the boolean → allowed / denied, reason code kept", () => {
    expect(classifyAuthorizationResponse(200, '{"authorized":true}')).toEqual({
      outcome: "allowed",
      status: 200,
    });
    expect(
      classifyAuthorizationResponse(
        200,
        '{"authorized":false,"reason":"not_customer"}',
      ),
    ).toEqual({
      outcome: "denied",
      status: 200,
      endpointReason: "not_customer",
    });
  });

  test("a prose reason is dropped, the verdict stands", () => {
    expect(
      classifyAuthorizationResponse(
        200,
        '{"authorized":false,"reason":"o cliente +5511988887777 não consta"}',
      ),
    ).toEqual({ outcome: "denied", status: 200 });
  });

  test("a 2xx WITHOUT the boolean is an error, never a pass", () => {
    expect(classifyAuthorizationResponse(200, '{"ok":true}')).toEqual({
      outcome: "error",
      status: 200,
      reason: "invalid_response",
    });
    expect(classifyAuthorizationResponse(200, "not json")).toEqual({
      outcome: "error",
      status: 200,
      reason: "invalid_response",
    });
    expect(classifyAuthorizationResponse(204, "")).toEqual({
      outcome: "error",
      status: 204,
      reason: "invalid_response",
    });
    // NOTE: `authorized` must be a real boolean; "true" as a string is not one.
    expect(classifyAuthorizationResponse(200, '{"authorized":"true"}')).toEqual(
      { outcome: "error", status: 200, reason: "invalid_response" },
    );
  });

  test("401/403/404 read as denied (REST-style endpoints need no body)", () => {
    for (const status of [401, 403, 404]) {
      expect(classifyAuthorizationResponse(status, "")).toEqual({
        outcome: "denied",
        status,
      });
    }
    expect(
      classifyAuthorizationResponse(404, '{"reason":"unknown_contact"}'),
    ).toEqual({
      outcome: "denied",
      status: 404,
      endpointReason: "unknown_contact",
    });
  });

  // The endpoint's own reason is kept apart from ours and never reaches telemetry: the slug guard
  // is a check on SHAPE, and a phone number is slug-shaped.
  test("what the endpoint calls it never lands in `reason`", () => {
    const v = classifyAuthorizationResponse(
      200,
      '{"authorized":false,"reason":"5511999999999"}',
    );
    expect(v.reason).toBeUndefined();
    expect(v.endpointReason).toBe("5511999999999");
  });

  test("every other status is an error (fail-closed)", () => {
    for (const status of [302, 429, 500, 503]) {
      expect(classifyAuthorizationResponse(status, "")).toEqual({
        outcome: "error",
        status,
        reason: "unexpected_status",
      });
    }
  });

  test("a body past the cap is an error before any parse", () => {
    expect(classifyAuthorizationResponse(200, null)).toEqual({
      outcome: "error",
      status: 200,
      reason: "body_too_large",
    });
  });
});

describe("reasonSlug", () => {
  test("keeps codes, drops prose and oversized values", () => {
    expect(reasonSlug("not_customer")).toBe("not_customer");
    expect(reasonSlug("plan.suspended-2")).toBe("plan.suspended-2");
    expect(reasonSlug("o cliente não consta")).toBeUndefined();
    expect(reasonSlug(`x${"y".repeat(64)}`)).toBeUndefined();
    expect(reasonSlug(42)).toBeUndefined();
    expect(reasonSlug(undefined)).toBeUndefined();
  });
});

describe("channelSlug", () => {
  test("slugs the mirror's raw channel_type", () => {
    expect(channelSlug("Channel::Whatsapp")).toBe("whatsapp");
    expect(channelSlug("Channel::WebWidget")).toBe("web_widget");
    expect(channelSlug("Channel::FacebookPage")).toBe("facebook_page");
    expect(channelSlug("Channel::Api")).toBe("api");
    expect(channelSlug(null)).toBeNull();
    expect(channelSlug("")).toBeNull();
  });
});

describe("buildAuthorizationRequest", () => {
  test("GET appends the scalar identifiers and preserves the existing query", () => {
    const { url, init } = buildAuthorizationRequest(
      cfg({ url: "https://api.example.com/authorize?tenant=t1" }),
      IDENTITY,
      null,
    );
    expect(url.searchParams.get("tenant")).toBe("t1");
    expect(url.searchParams.get("phone")).toBe(IDENTITY.phone);
    expect(url.searchParams.get("contact_id")).toBe("42");
    expect(url.searchParams.get("identifier")).toBe("client-4821");
    expect(url.searchParams.get("email")).toBe("cliente@example.com");
    // Never on a query string: the name, and anything the customer typed.
    expect(url.searchParams.has("name")).toBe(false);
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  test("GET omits what the mirror never learned", () => {
    const { url } = buildAuthorizationRequest(
      cfg(),
      {
        ...IDENTITY,
        phone: null,
        email: null,
        chatwootContactId: null,
      },
      null,
    );
    expect(url.searchParams.has("phone")).toBe(false);
    expect(url.searchParams.has("contact_id")).toBe(false);
    expect(url.searchParams.has("email")).toBe(false);
    expect(url.searchParams.get("identifier")).toBe("client-4821");
  });

  test("GET never carries the message text, even when the flag leaks in", () => {
    // The reader already forces includeMessageText off under GET; the builder does not rely on it.
    const { url } = buildAuthorizationRequest(
      cfg({ includeMessageText: true }),
      { ...IDENTITY, messageText: "meu código é 4821" },
      null,
    );
    expect(url.toString()).not.toContain("4821%20");
    expect([...url.searchParams.keys()].sort()).toEqual([
      "contact_id",
      "email",
      "identifier",
      "phone",
    ]);
  });

  test("POST separates trusted contact, conversation coordinates and no message by default", () => {
    const { url, init } = buildAuthorizationRequest(
      cfg({ method: "POST" }),
      IDENTITY,
      null,
    );
    expect(url.searchParams.has("phone")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      contact: {
        phone: IDENTITY.phone,
        name: "Cliente Exemplo",
        email: "cliente@example.com",
        identifier: "client-4821",
        chatwootContactId: 42,
      },
      conversation: { id: 901, inboxId: 7, channel: "whatsapp" },
    });
    expect((init.headers as Record<string, string>)["content-type"]).toContain(
      "application/json",
    );
  });

  test("POST with includeMessageText carries the text under message, apart from contact", () => {
    const { init } = buildAuthorizationRequest(
      cfg({ method: "POST", includeMessageText: true }),
      { ...IDENTITY, messageText: "  meu código é ABC-123  " },
      null,
    );
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body.message).toEqual({ text: "meu código é ABC-123" });
    // The customer's text never bleeds into the trusted half.
    expect(JSON.stringify(body.contact)).not.toContain("ABC-123");
  });

  test("the forwarded text is capped, and an empty text sends no message at all", () => {
    const { init } = buildAuthorizationRequest(
      cfg({ method: "POST", includeMessageText: true }),
      { ...IDENTITY, messageText: "x".repeat(MESSAGE_TEXT_MAX + 500) },
      null,
    );
    const body = JSON.parse(String(init.body)) as {
      message: { text: string };
    };
    expect(body.message.text.length).toBe(MESSAGE_TEXT_MAX);
    const empty = buildAuthorizationRequest(
      cfg({ method: "POST", includeMessageText: true }),
      { ...IDENTITY, messageText: "   " },
      null,
    );
    expect(
      JSON.parse(String(empty.init.body)) as Record<string, unknown>,
    ).not.toHaveProperty("message");
  });

  test("POST without the opt-in sends no message even when text exists", () => {
    const { init } = buildAuthorizationRequest(
      cfg({ method: "POST" }),
      { ...IDENTITY, messageText: "meu código é ABC-123" },
      null,
    );
    expect(String(init.body)).not.toContain("ABC-123");
  });

  test.each([
    [
      "bearer_token",
      null,
      (h: Record<string, string>, u: URL) =>
        h.Authorization === "Bearer sk-1" && !u.searchParams.has("sk-1"),
    ],
    [
      "header",
      "X-Api-Key",
      (h: Record<string, string>) => h["X-Api-Key"] === "sk-1",
    ],
    [
      "query",
      "api_key",
      (h: Record<string, string>, u: URL) =>
        u.searchParams.get("api_key") === "sk-1" && !h.Authorization,
    ],
    // NOTE: an uncatalogued kind falls back to Bearer, the way MCP connections do.
    [
      "generic",
      null,
      (h: Record<string, string>) => h.authorization === "Bearer sk-1",
    ],
  ])("injects the credential per its kind (%s)", (kind, paramName, check) => {
    const { url, init } = buildAuthorizationRequest(cfg(), IDENTITY, {
      value: "sk-1",
      kind,
      paramName,
    });
    expect(check(init.headers as Record<string, string>, url)).toBe(true);
  });
});

// GET carries the identity on the query string, and a query credential is written after it. A
// credential whose parameter is one of those four names replaces the value it names: the endpoint is
// asked about a phone number that is the secret, and the secret lands in its access logs as one.
describe("credentialTakesIdentityParam", () => {
  const queryCred = (paramName: string) => ({
    value: "s3cr3t",
    kind: "query",
    paramName,
  });

  test("a query credential named after an identity field collides", () => {
    for (const name of ["phone", "contact_id", "identifier", "email"]) {
      expect(credentialTakesIdentityParam(cfg(), queryCred(name))).toBe(true);
    }
  });

  test("any other parameter name is fine", () => {
    expect(credentialTakesIdentityParam(cfg(), queryCred("api_key"))).toBe(
      false,
    );
  });

  test("no credential, or one that travels in a header, cannot collide", () => {
    expect(credentialTakesIdentityParam(cfg(), null)).toBe(false);
    expect(
      credentialTakesIdentityParam(cfg(), {
        value: "s3cr3t",
        kind: "bearer_token",
        paramName: null,
      }),
    ).toBe(false);
  });

  // Under POST the identity travels in the body, so the query is the operator's alone and the name
  // is theirs to reuse.
  test("POST does not reserve the names", () => {
    expect(
      credentialTakesIdentityParam(cfg({ method: "POST" }), queryCred("phone")),
    ).toBe(false);
  });
});

describe("checkContactAuthorization", () => {
  test("happy path: fetches the built request with redirect error and classifies", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchImpl = (async (u: RequestInfo | URL, init?: RequestInit) => {
      seenUrl = String(u);
      seenInit = init;
      return new Response('{"authorized":true}', { status: 200 });
    }) as unknown as typeof fetch;
    const v = await checkContactAuthorization(cfg(), IDENTITY, null, {
      fetchImpl,
      assertSafe: okUrl,
    });
    expect(v).toEqual({ outcome: "allowed", status: 200 });
    expect(seenUrl).toContain("phone=%2B5511988887777");
    expect(seenInit?.redirect).toBe("error");
  });

  test("a network failure is an error verdict, not a throw", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL) => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect(
      await checkContactAuthorization(cfg(), IDENTITY, null, {
        fetchImpl,
        assertSafe: okUrl,
      }),
    ).toEqual({ outcome: "error", reason: "network" });
  });

  test("a timeout aborts the request and is its own reason", async () => {
    const fetchImpl = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      })) as unknown as typeof fetch;
    expect(
      await checkContactAuthorization(cfg({ timeoutMs: 25 }), IDENTITY, null, {
        fetchImpl,
        assertSafe: okUrl,
      }),
    ).toEqual({ outcome: "error", reason: "timeout" });
  });

  test("a blocked URL never reaches fetch (fail-closed before the socket)", async () => {
    let fetched = 0;
    const fetchImpl = (async (_input: RequestInfo | URL) => {
      fetched += 1;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const v = await checkContactAuthorization(cfg(), IDENTITY, null, {
      fetchImpl,
      assertSafe: async () => {
        throw new SsrfError("blocked");
      },
    });
    expect(v).toEqual({ outcome: "error", reason: "unsafe_url" });
    expect(fetched).toBe(0);
  });

  test("a body over the cap is refused without being parsed", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL) =>
      new Response("x".repeat(MAX_RESPONSE_BYTES + 1), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(
      await checkContactAuthorization(cfg(), IDENTITY, null, {
        fetchImpl,
        assertSafe: okUrl,
      }),
    ).toEqual({ outcome: "error", status: 200, reason: "body_too_large" });
  });

  // The URL check resolves DNS, and a resolver that never answers used to hold the whole pre-turn
  // gate: `timeoutMs` only started counting after it. The budget covers every step that waits.
  test("a stalled url check does not outlast the timeout", async () => {
    let fetched = 0;
    const fetchImpl = (async (_input: RequestInfo | URL) => {
      fetched += 1;
      return new Response('{"authorized":true}');
    }) as unknown as typeof fetch;
    const started = Date.now();
    const v = await checkContactAuthorization(
      cfg({ timeoutMs: 25 }),
      IDENTITY,
      null,
      { fetchImpl, assertSafe: () => new Promise<URL>(() => {}) },
    );
    expect(v).toEqual({ outcome: "error", reason: "timeout" });
    expect(fetched).toBe(0);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  // Refusing by the declared size returns before the read loop, which is where the cancel used to
  // live: the stream, and the socket under it, stayed open on every check.
  test("a body refused by its declared size is cancelled", async () => {
    let cancelled = false;
    const fetchImpl = (async (_input: RequestInfo | URL) => {
      const body = new ReadableStream<Uint8Array>({
        start() {},
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-length": String(MAX_RESPONSE_BYTES + 1) },
      });
    }) as unknown as typeof fetch;
    expect(
      await checkContactAuthorization(cfg(), IDENTITY, null, {
        fetchImpl,
        assertSafe: okUrl,
      }),
    ).toEqual({ outcome: "error", status: 200, reason: "body_too_large" });
    expect(cancelled).toBe(true);
  });

  test("no url configured is an error, not a pass", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL) =>
      new Response("{}")) as unknown as typeof fetch;
    expect(
      await checkContactAuthorization(cfg({ url: null }), IDENTITY, null, {
        fetchImpl,
        assertSafe: okUrl,
      }),
    ).toEqual({ outcome: "error", reason: "not_configured" });
  });
});
