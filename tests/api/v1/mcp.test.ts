import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import config from "@/config";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// MCP OAuth discovery (root, not SPA) + the MCP endpoint auth gate. No real DB: the discovery is
// pure, and a missing/invalid Bearer is rejected before any DB lookup.
setupPrismaMock();
const app = (await import("@/app")).default;

describe("MCP OAuth discovery (RFC 8414 / 9728) at the root", () => {
  // Pin DCR open (the shipped default) so a developer .env with MCP_DCR_ENABLED=false cannot turn
  // these into false negatives; the parsing of the default itself is asserted in mcp-dcr.test.ts.
  const originalDcr = config.mcpDcrEnabled;
  beforeAll(() => {
    config.mcpDcrEnabled = true;
  });
  afterAll(() => {
    config.mcpDcrEnabled = originalDcr;
  });

  test("authorization-server metadata is JSON, not the SPA HTMLBundle", async () => {
    const res = await app.handle(
      new Request("http://localhost/.well-known/oauth-authorization-server"),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("application/json");
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.issuer).toBeDefined();
    expect(body.token_endpoint).toBeDefined();
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    // We still emit `iss` on the authorization response, but deliberately do NOT advertise support
    // for it: rmcp-based clients (OpenAI Codex) set require_issuer=true from this flag yet drop the
    // callback `iss`, failing login (openai/codex#31573). See metadata.ts.
    expect(body.authorization_response_iss_parameter_supported).toBeUndefined();
    // NOTE: DCR is advertised by default: without it Codex ("Dynamic client registration not supported")
    // and Claude Code ("Incompatible auth server") abort before any login screen, and no supported
    // client has a fallback. Closing it is opt-in (tests/api/v1/mcp-dcr.test.ts).
    expect(body.registration_endpoint).toContain("/api/v1/mcp/oauth/register");
  });

  test("the register endpoint is live by default (rejects a bad redirect_uri, not 404)", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://app.example.com/*"] }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("invalid_redirect_uri");
  });

  test("protected-resource metadata points at the authorization server", async () => {
    const res = await app.handle(
      new Request("http://localhost/.well-known/oauth-protected-resource"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.resource).toContain("/api/v1/mcp");
    expect(Array.isArray(body.authorization_servers)).toBe(true);
  });
});

describe("MCP endpoint auth gate", () => {
  test("POST /api/v1/mcp without a Bearer → 401 + WWW-Authenticate, never HTML", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((res.headers.get("www-authenticate") ?? "").toLowerCase()).toContain(
      "bearer",
    );
    expect((await res.text()).toLowerCase()).not.toContain("<!doctype");
  });

  test("POST /api/v1/mcp with a bogus Bearer → 401 (rejected before any DB hit)", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer not-a-real-token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      }),
    );
    expect(res.status).toBe(401);
  });
});
