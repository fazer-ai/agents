import { describe, expect, test } from "bun:test";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// NOTE: /authorize is opened by a BROWSER (the MCP client launches it), so an anonymous visitor has to
// land on the login screen with the flow preserved. Answering the API's 401/403 JSON instead is a
// dead end: the user stares at raw JSON while the MCP client waits for a callback that never comes.
setupPrismaMock();
const app = (await import("@/app")).default;

const AUTHORIZE_QUERY =
  "client_id=abc123&redirect_uri=http%3A%2F%2F127.0.0.1%3A49700%2Fcallback%2Fxyz" +
  "&response_type=code&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM" +
  "&code_challenge_method=S256&scope=mcp%3Aread&state=st4te";

describe("GET /api/v1/mcp/oauth/authorize without a session", () => {
  test("302s to the login screen with itself as the return destination", async () => {
    const res = await app.handle(
      new Request(
        `http://localhost/api/v1/mcp/oauth/authorize?${AUTHORIZE_QUERY}`,
        { headers: { accept: "text/html" } },
      ),
    );
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("/login?redirect=")).toBe(true);

    // The destination round-trips the full authorize URL (query included) as ONE encoded value, and
    // stays a single-leading-slash local path — LoginPage rejects anything else.
    const target =
      new URLSearchParams(location.slice("/login?".length)).get("redirect") ??
      "";
    expect(target.startsWith("/api/v1/mcp/oauth/authorize?")).toBe(true);
    expect(target.startsWith("//")).toBe(false);
    const resumed = new URLSearchParams(target.split("?")[1]);
    expect(resumed.get("client_id")).toBe("abc123");
    expect(resumed.get("state")).toBe("st4te");
    expect(resumed.get("redirect_uri")).toBe(
      "http://127.0.0.1:49700/callback/xyz",
    );
  });

  test("the response body is not the API's JSON error", async () => {
    const res = await app.handle(
      new Request(
        `http://localhost/api/v1/mcp/oauth/authorize?${AUTHORIZE_QUERY}`,
      ),
    );
    expect(res.status).toBe(302);
    expect((await res.text()).trim()).toBe("");
  });
});
