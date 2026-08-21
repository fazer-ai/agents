import { describe, expect, test } from "bun:test";
import { SsrfError } from "@/lib/ssrf";
import {
  buildAuthorizationRequest,
  checkContactAuthorization,
  classifyAuthorizationResponse,
  MAX_RESPONSE_BYTES,
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

const IDENTITY = {
  phone: "+5511988887777",
  contactId: 42,
  conversationId: 901,
  inboxId: 7,
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
    ).toEqual({ outcome: "denied", status: 200, reason: "not_customer" });
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
    ).toEqual({ outcome: "denied", status: 404, reason: "unknown_contact" });
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

describe("buildAuthorizationRequest", () => {
  test("GET appends phone + contact_id and preserves the existing query", () => {
    const { url, init } = buildAuthorizationRequest(
      cfg({ url: "https://api.example.com/authorize?tenant=t1" }),
      IDENTITY,
      null,
    );
    expect(url.searchParams.get("tenant")).toBe("t1");
    expect(url.searchParams.get("phone")).toBe(IDENTITY.phone);
    expect(url.searchParams.get("contact_id")).toBe("42");
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
  });

  test("GET omits contact_id when the mirror never learned it", () => {
    const { url } = buildAuthorizationRequest(
      cfg(),
      { ...IDENTITY, contactId: null },
      null,
    );
    expect(url.searchParams.get("phone")).toBe(IDENTITY.phone);
    expect(url.searchParams.has("contact_id")).toBe(false);
  });

  test("POST carries the identity in a JSON body, not on the URL", () => {
    const { url, init } = buildAuthorizationRequest(
      cfg({ method: "POST" }),
      IDENTITY,
      null,
    );
    expect(url.searchParams.has("phone")).toBe(false);
    expect(JSON.parse(String(init.body))).toEqual({
      phone: IDENTITY.phone,
      contactId: 42,
      conversationId: 901,
      inboxId: 7,
    });
    expect((init.headers as Record<string, string>)["content-type"]).toContain(
      "application/json",
    );
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
