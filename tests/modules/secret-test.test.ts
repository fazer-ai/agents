import { describe, expect, test } from "bun:test";
import {
  runSecretTest,
  type SecretTestDeps,
} from "@/modules/vault/secret-test";

interface Call {
  url: string;
  headers: Record<string, string>;
}

// Builds a fake fetch that records each request and replies per a host→status map (default 200).
// An optional host→body map supplies the response body (used to exercise body-aware probe logic).
function fakeFetch(
  statusByHost: Record<string, number> = {},
  bodyByHost: Record<string, string> = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = init?.headers as Record<string, string> | undefined;
    if (h) for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    calls.push({ url, headers });
    const host = new URL(url).host;
    const status = statusByHost[host] ?? 200;
    const body = bodyByHost[host] ?? (status === 200 ? "{}" : "");
    return new Response(body, { status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const passAssert: SecretTestDeps["assertSafe"] = async (url) => new URL(url);

describe("runSecretTest", () => {
  test("reports generic mechanisms as not testable", async () => {
    for (const kind of [
      "generic",
      "bearer_token",
      "header",
      "basic_auth",
      "query",
    ]) {
      const r = await runSecretTest(
        { kind, value: "x" },
        { assertSafe: passAssert },
      );
      expect(r).toEqual({ testable: false });
    }
  });

  test("probes openai with a bearer header and no secret in the URL", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const r = await runSecretTest(
      { kind: "openai", value: "sk-secret" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/models");
    expect(calls[0]?.headers.authorization).toBe("Bearer sk-secret");
    expect(calls[0]?.url).not.toContain("sk-secret");
  });

  test("maps 401 to unauthorized", async () => {
    const { fetchImpl } = fakeFetch({ "api.openai.com": 401 });
    const r = await runSecretTest(
      { kind: "openai", value: "bad" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({
      testable: true,
      ok: false,
      code: "unauthorized",
      status: 401,
    });
  });

  test("maps a 5xx to http_error with the status", async () => {
    const { fetchImpl } = fakeFetch({ "api.openai.com": 503 });
    const r = await runSecretTest(
      { kind: "openai", value: "x" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({
      testable: true,
      ok: false,
      code: "http_error",
      status: 503,
    });
  });

  test("sends anthropic's version header alongside x-api-key", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await runSecretTest(
      { kind: "anthropic", value: "ant-key" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(calls[0]?.headers["x-api-key"]).toBe("ant-key");
    expect(calls[0]?.headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("requires a base URL for self-hosted types", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const r = await runSecretTest(
      { kind: "chatwoot_api_token", value: "tok" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: false, code: "missing_base_url" });
    expect(calls).toHaveLength(0);
  });

  test("probes the chatwoot profile endpoint on the supplied base", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const r = await runSecretTest(
      {
        kind: "chatwoot_api_token",
        value: "tok",
        baseURL: "https://chat.example.com/",
      },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: true });
    expect(calls[0]?.url).toBe("https://chat.example.com/api/v1/profile");
    expect(calls[0]?.headers["api-access-token"]).toBe("tok");
  });

  test("falls through asaas production → sandbox on auth failure", async () => {
    const { calls, fetchImpl } = fakeFetch({ "api.asaas.com": 401 });
    const r = await runSecretTest(
      { kind: "asaas", value: "asaas-key" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: true });
    expect(calls.map((c) => new URL(c.url).host)).toEqual([
      "api.asaas.com",
      "api-sandbox.asaas.com",
    ]);
  });

  test("treats ElevenLabs missing_permissions (valid key, no scope) as a pass", async () => {
    const { calls, fetchImpl } = fakeFetch(
      { "api.elevenlabs.io": 401 },
      {
        "api.elevenlabs.io": JSON.stringify({
          detail: {
            status: "missing_permissions",
            message: "The API key you used is missing the permission user_read",
          },
        }),
      },
    );
    const r = await runSecretTest(
      { kind: "elevenlabs", value: "sk_scoped" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: true });
    expect(calls[0]?.url).toBe("https://api.elevenlabs.io/v1/user");
    expect(calls[0]?.headers["xi-api-key"]).toBe("sk_scoped");
  });

  test("maps an ElevenLabs invalid_api_key body to unauthorized", async () => {
    const { fetchImpl } = fakeFetch(
      { "api.elevenlabs.io": 401 },
      {
        "api.elevenlabs.io": JSON.stringify({
          detail: { status: "invalid_api_key", message: "Invalid API key" },
        }),
      },
    );
    const r = await runSecretTest(
      { kind: "elevenlabs", value: "bad" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({
      testable: true,
      ok: false,
      code: "unauthorized",
      status: 401,
    });
  });

  test("returns blocked_url when the SSRF guard rejects the target", async () => {
    const { fetchImpl } = fakeFetch();
    const r = await runSecretTest(
      {
        kind: "chatwoot_api_token",
        value: "tok",
        baseURL: "http://169.254.169.254",
      },
      {
        fetchImpl,
        assertSafe: async () => {
          throw new Error("blocked");
        },
      },
    );
    expect(r).toEqual({ testable: true, ok: false, code: "blocked_url" });
  });

  test("maps an aborted/timed-out fetch to timeout", async () => {
    const fetchImpl = (async () => {
      const err = new Error("timed out");
      err.name = "TimeoutError";
      throw err;
    }) as unknown as typeof fetch;
    const r = await runSecretTest(
      { kind: "openai", value: "x" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: false, code: "timeout" });
  });

  test("maps a generic network error to unreachable", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await runSecretTest(
      { kind: "openai", value: "x" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: false, code: "unreachable" });
  });
  // TypeSafe (the Jev classifier of the decisions engine): the models list is authenticated and runs
  // no classification, so the probe costs nothing (docs.typesafe.ai, `client.models.list()`).
  test("probes typesafe's models list with a bearer header", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const r = await runSecretTest(
      { kind: "typesafe", value: "ts-secret" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.typesafe.ai/v1/models");
    expect(calls[0]?.headers.authorization).toBe("Bearer ts-secret");
  });

  test("maps a wrong typesafe key (401) to unauthorized", async () => {
    const { fetchImpl } = fakeFetch({ "api.typesafe.ai": 401 });
    const r = await runSecretTest(
      { kind: "typesafe", value: "wrong" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({
      testable: true,
      ok: false,
      code: "unauthorized",
      status: 401,
    });
  });

  // The decisions engine sends the classification to the entry's base URL when it has one, so the
  // probe asks the same server: testing the public API for a key meant for a proxy proves nothing.
  test("probes typesafe on the entry's base URL when it has one", async () => {
    const { calls, fetchImpl } = fakeFetch();
    const r = await runSecretTest(
      {
        kind: "typesafe",
        value: "ts-secret",
        baseURL: "https://ts-proxy.example.com/v1/",
      },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(r).toEqual({ testable: true, ok: true });
    expect(calls.map((c) => c.url)).toEqual([
      "https://ts-proxy.example.com/v1/models",
    ]);
  });

  test("a fixed-host kind ignores a base URL handed to the probe", async () => {
    const { calls, fetchImpl } = fakeFetch();
    await runSecretTest(
      { kind: "openai", value: "x", baseURL: "https://elsewhere.example.com" },
      { fetchImpl, assertSafe: passAssert },
    );
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.openai.com/v1/models",
    ]);
  });
});
