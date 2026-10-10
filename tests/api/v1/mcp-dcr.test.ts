import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import config from "@/config";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// NOTE: DCR is OPEN by default; closing it is the opt-in escape hatch (MCP_DCR_ENABLED=false). Both sides
// are covered here: the env parsing that decides the default, and the two endpoints that change
// shape when an operator closes it. `config.mcpDcrEnabled` is read per request, so flipping the
// field is enough to exercise the closed branch — no module remount, and the result does not depend
// on whatever the developer's own .env happens to say.
setupPrismaMock();
const app = (await import("@/app")).default;

async function dcrDefaultFor(raw: string | undefined): Promise<boolean> {
  const previous = process.env.MCP_DCR_ENABLED;
  if (raw === undefined) delete process.env.MCP_DCR_ENABLED;
  else process.env.MCP_DCR_ENABLED = raw;
  try {
    const mod = (await import(`@/config?dcr=${raw ?? "unset"}`)) as {
      default: typeof config;
    };
    return mod.default.mcpDcrEnabled;
  } finally {
    if (previous === undefined) delete process.env.MCP_DCR_ENABLED;
    else process.env.MCP_DCR_ENABLED = previous;
  }
}

describe("MCP_DCR_ENABLED parsing", () => {
  test("unset → open (every supported MCP client needs DCR to log in)", async () => {
    expect(await dcrDefaultFor(undefined)).toBe(true);
  });

  test('"false" → closed', async () => {
    expect(await dcrDefaultFor("false")).toBe(false);
  });
});

describe("MCP DCR endpoints with MCP_DCR_ENABLED=false", () => {
  const original = config.mcpDcrEnabled;
  beforeEach(() => {
    config.mcpDcrEnabled = false;
  });
  afterEach(() => {
    config.mcpDcrEnabled = original;
  });

  test("POST /api/v1/mcp/oauth/register → 404 (no signal the route exists)", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/v1/mcp/oauth/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://app.example.com/cb"] }),
      }),
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.error).toBe("not_found");
  });

  test("authorization-server metadata drops registration_endpoint", async () => {
    const res = await app.handle(
      new Request("http://localhost/.well-known/oauth-authorization-server"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.registration_endpoint).toBeUndefined();
  });
});
