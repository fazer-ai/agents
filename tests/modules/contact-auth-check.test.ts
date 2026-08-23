import { describe, expect, test } from "bun:test";
import { SsrfError } from "@/lib/ssrf";
import {
  buildAuthorizationRequest,
  type ContactIdentity,
  channelSlug,
  checkContactAuthorization,
  classifyAuthorizationResponse,
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
    expect(classifyAuthorizationResponse(500, null)).toEqual({
      outcome: "error",
      status: 500,
      reason: "body_too_large",
    });
  });

  // A refusal says everything it needs to say in the status line, so a body we could not read
  // cannot turn it into something else. Behind a proxy a 403 arrives with a large HTML error page,
  // and reading that as an error made a permanent refusal look transient: no deny message, no
  // handoff, and the next message asking all over again.
  test("401/403/404 stay denials even when the body is unreadable", () => {
    for (const status of [401, 403, 404]) {
      expect(classifyAuthorizationResponse(status, null)).toEqual({
        outcome: "denied",
        status,
      });
    }
  });

  test("the context bag travels only with a verdict that lets a turn happen", () => {
    const ctx = '"context":{"plan":"premium"}';
    expect(
      classifyAuthorizationResponse(200, `{"authorized":true,${ctx}}`),
    ).toMatchObject({
      outcome: "allowed",
      context: [{ key: "plan", value: "premium" }],
    });
    // A denial and an error end the turn, so context for them describes a prompt nobody will
    // build. Read as a verdict field it would be dead weight; read as PII it would be stored and
    // shipped to an alert channel for nothing.
    expect(
      classifyAuthorizationResponse(200, `{"authorized":false,${ctx}}`),
    ).not.toHaveProperty("context");
    expect(classifyAuthorizationResponse(403, `{${ctx}}`)).not.toHaveProperty(
      "context",
    );
    expect(classifyAuthorizationResponse(500, `{${ctx}}`)).not.toHaveProperty(
      "context",
    );
  });

  test("a context that says nothing is absent, not empty", () => {
    for (const body of [
      '{"authorized":true}',
      '{"authorized":true,"context":{}}',
      '{"authorized":true,"context":"premium"}',
      '{"authorized":true,"context":{"nested":{"a":1}}}',
    ]) {
      expect(classifyAuthorizationResponse(200, body)).not.toHaveProperty(
        "context",
      );
    }
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
  // The identity is in the BODY and nowhere else: the operator's own query survives untouched, and
  // nothing about the customer is appended to a URL that lands in the endpoint's access logs.
  test("the identity never touches the query string, and the operator's own survives", () => {
    const { url, init } = buildAuthorizationRequest(
      cfg({ url: "https://api.example.com/authorize?tenant=t1" }),
      IDENTITY,
      null,
    );
    expect([...url.searchParams.keys()]).toEqual(["tenant"]);
    expect(url.searchParams.get("tenant")).toBe("t1");
    expect(init.method).toBe("POST");
  });

  test("what the mirror never learned travels as null, not as an absent key", () => {
    const { init } = buildAuthorizationRequest(
      cfg(),
      { ...IDENTITY, phone: null, email: null, chatwootContactId: null },
      null,
    );
    const body = JSON.parse(String(init.body)) as {
      contact: Record<string, unknown>;
    };
    expect(body.contact).toEqual({
      phone: null,
      name: "Cliente Exemplo",
      email: null,
      identifier: "client-4821",
      chatwootContactId: null,
    });
  });

  test("separates trusted contact, conversation coordinates and no message by default", () => {
    const { url, init } = buildAuthorizationRequest(cfg(), IDENTITY, null);
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

  test("includeMessageText carries the text under message, apart from contact", () => {
    const { init } = buildAuthorizationRequest(
      cfg({ includeMessageText: true }),
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
      cfg({ includeMessageText: true }),
      { ...IDENTITY, messageText: "x".repeat(MESSAGE_TEXT_MAX + 500) },
      null,
    );
    const body = JSON.parse(String(init.body)) as {
      message: { text: string };
    };
    expect(body.message.text.length).toBe(MESSAGE_TEXT_MAX);
    const empty = buildAuthorizationRequest(
      cfg({ includeMessageText: true }),
      { ...IDENTITY, messageText: "   " },
      null,
    );
    expect(
      JSON.parse(String(empty.init.body)) as Record<string, unknown>,
    ).not.toHaveProperty("message");
  });

  test("without the opt-in no message is sent even when text exists", () => {
    const { init } = buildAuthorizationRequest(
      cfg(),
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
    expect(seenUrl).toBe("https://api.example.com/authorize");
    expect(String(seenInit?.body)).toContain("+5511988887777");
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

  // A denying status whose body never arrives. The timer stays armed while the body is read, so the
  // abort lands on the READ — the same way a real fetch errors its body stream when its signal
  // fires. Before this, that was indistinguishable from the request timing out: a permanent 403
  // came back as `error/timeout`, so the customer got no deny message, nobody got the handoff, and
  // the next message asked all over again.
  const stallingBody = (signal: AbortSignal | null | undefined) =>
    new ReadableStream<Uint8Array>({
      // Never enqueues and never closes; errors out when the deadline fires, which is what a real
      // fetch body does under an aborted signal.
      start(controller) {
        signal?.addEventListener(
          "abort",
          () => controller.error(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      },
    });

  test("a 403 whose body stalls is still a denial, not a timeout", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(stallingBody(init?.signal), {
        status: 403,
      })) as unknown as typeof fetch;
    expect(
      await checkContactAuthorization(cfg({ timeoutMs: 25 }), IDENTITY, null, {
        fetchImpl,
        assertSafe: okUrl,
      }),
    ).toEqual({ outcome: "denied", status: 403 });
  });

  // The other half of the same rule: only a 2xx has to CARRY its verdict, so a 2xx that stalls has
  // said nothing and stays the error it is.
  test("a 200 whose body stalls is still a timeout", async () => {
    const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Response(stallingBody(init?.signal), {
        status: 200,
      })) as unknown as typeof fetch;
    expect(
      await checkContactAuthorization(cfg({ timeoutMs: 25 }), IDENTITY, null, {
        fetchImpl,
        assertSafe: okUrl,
      }),
    ).toEqual({ outcome: "error", reason: "timeout" });
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
