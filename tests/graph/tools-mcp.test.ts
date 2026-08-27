import { describe, expect, test } from "bun:test";
import type { StructuredToolInterface } from "@langchain/core/tools";
import {
  buildConnConfig,
  buildMcpContextSection,
  filterAllowed,
  loadMcpToolsForAgent,
  type McpSelection,
  mcpServerSlug,
  namespacedToolName,
} from "@/graph/tools/mcp";

const PUBLIC = "8.8.8.8"; // public IP literal: no DNS lookup, not SSRF-blocked

function sel(over: Partial<McpSelection> = {}): McpSelection {
  return {
    connId: 1n,
    name: "asaas-mcp",
    transport: "streamableHttp",
    url: `https://${PUBLIC}/mcp`,
    command: null,
    secret: null,
    credentialBaseUrl: null,
    enabledTools: ["a", "b"],
    ...over,
  };
}

function fakeTool(name: string): StructuredToolInterface {
  return { name } as unknown as StructuredToolInterface;
}

describe("buildConnConfig", () => {
  test("http with secret → Authorization header", async () => {
    const c = (await buildConnConfig(sel({ secret: "tok" }), {
      stdioEnabled: false,
    })) as { url: string; transport: string; headers: Record<string, string> };
    expect(c.url).toBe(`https://${PUBLIC}/mcp`);
    expect(c.transport).toBe("http");
    expect(c.headers.Authorization).toBe("Bearer tok");
  });

  test("bearer_token credential → Authorization: Bearer", async () => {
    const c = (await buildConnConfig(
      sel({ secret: "tok", credentialKind: "bearer_token" }),
      { stdioEnabled: false },
    )) as { headers: Record<string, string> };
    expect(c.headers.Authorization).toBe("Bearer tok");
  });

  test("basic_auth credential → Authorization: Basic <secret>", async () => {
    const c = (await buildConnConfig(
      sel({ secret: "dXNlcjpwYXNz", credentialKind: "basic_auth" }),
      { stdioEnabled: false },
    )) as { headers: Record<string, string> };
    expect(c.headers.Authorization).toBe("Basic dXNlcjpwYXNz");
  });

  test("header credential → custom header named by paramName", async () => {
    const c = (await buildConnConfig(
      sel({
        secret: "abc123",
        credentialKind: "header",
        credentialParamName: "X-API-Key",
      }),
      { stdioEnabled: false },
    )) as { headers: Record<string, string> };
    expect(c.headers["X-API-Key"]).toBe("abc123");
    expect(c.headers.Authorization).toBeUndefined();
  });

  test("mcp_oauth (resolved access token) → Authorization: Bearer", async () => {
    const c = (await buildConnConfig(
      sel({ secret: "access-tok", credentialKind: "mcp_oauth" }),
      { stdioEnabled: false },
    )) as { headers: Record<string, string> };
    expect(c.headers.Authorization).toBe("Bearer access-tok");
  });

  test("header credential without a paramName → legacy Bearer fallback", async () => {
    const c = (await buildConnConfig(
      sel({ secret: "abc123", credentialKind: "header" }),
      { stdioEnabled: false },
    )) as { headers: Record<string, string> };
    expect(c.headers.Authorization).toBe("Bearer abc123");
  });

  test("sse transport is preserved", async () => {
    const c = (await buildConnConfig(sel({ transport: "sse" }), {
      stdioEnabled: false,
    })) as { transport: string };
    expect(c.transport).toBe("sse");
  });

  test("stdio is rejected unless explicitly enabled", async () => {
    await expect(
      buildConnConfig(
        sel({ transport: "stdio", command: "node srv.js", url: null }),
        {
          stdioEnabled: false,
        },
      ),
    ).rejects.toThrow(/stdio transport disabled/);
  });

  test("stdio (when enabled) splits command into command + args", async () => {
    const c = (await buildConnConfig(
      sel({ transport: "stdio", command: "uvx srv --port 3", url: null }),
      { stdioEnabled: true },
    )) as { command: string; args: string[] };
    expect(c.command).toBe("uvx");
    expect(c.args).toEqual(["srv", "--port", "3"]);
  });

  test("stdio mcp_env credential injects the secret as the named env var", async () => {
    const c = (await buildConnConfig(
      sel({
        transport: "stdio",
        command: "bunx -p hostinger-api-mcp@latest hostinger-hosting-mcp",
        url: null,
        credentialKind: "mcp_env",
        credentialParamName: "HOSTINGER_API_TOKEN",
        secret: "tok-123",
      }),
      { stdioEnabled: true },
    )) as { command: string; args: string[]; env?: Record<string, string> };
    expect(c.command).toBe("bunx");
    expect(c.args).toEqual([
      "-p",
      "hostinger-api-mcp@latest",
      "hostinger-hosting-mcp",
    ]);
    expect(c.env).toEqual({ HOSTINGER_API_TOKEN: "tok-123" });
  });

  test("stdio rejects a non-launcher command at the exec point (import-bypass guard)", async () => {
    await expect(
      buildConnConfig(
        sel({ transport: "stdio", command: "rm -rf /", url: null }),
        { stdioEnabled: true },
      ),
    ).rejects.toThrow(/not an allowed launcher/);
  });

  test("stdio rejects shell metacharacters at the exec point", async () => {
    await expect(
      buildConnConfig(
        sel({ transport: "stdio", command: "bunx; shutdown now", url: null }),
        { stdioEnabled: true },
      ),
    ).rejects.toThrow(/not an allowed launcher/);
  });

  test("stdio with a non-mcp_env credential injects no env", async () => {
    const c = (await buildConnConfig(
      sel({
        transport: "stdio",
        command: "bunx srv",
        url: null,
        credentialKind: "bearer_token",
        secret: "tok-123",
      }),
      { stdioEnabled: true },
    )) as { env?: Record<string, string> };
    expect(c.env).toBeUndefined();
  });

  test("stdio mcp_env without a param name injects no env", async () => {
    const c = (await buildConnConfig(
      sel({
        transport: "stdio",
        command: "bunx srv",
        url: null,
        credentialKind: "mcp_env",
        credentialParamName: null,
        secret: "tok-123",
      }),
      { stdioEnabled: true },
    )) as { env?: Record<string, string> };
    expect(c.env).toBeUndefined();
  });

  test("http missing url → throws", async () => {
    await expect(
      buildConnConfig(sel({ url: null }), { stdioEnabled: false }),
    ).rejects.toThrow(/requires a url/);
  });

  test("SSRF guard blocks a loopback MCP url", async () => {
    await expect(
      buildConnConfig(sel({ url: "https://127.0.0.1/mcp" }), {
        stdioEnabled: false,
      }),
    ).rejects.toThrow();
  });

  test("credentialBaseUrl overrides sel.url when present", async () => {
    const c = (await buildConnConfig(
      sel({
        url: `https://${PUBLIC}/old`,
        credentialBaseUrl: `https://${PUBLIC}/mcp-from-cred`,
      }),
      { stdioEnabled: false },
    )) as { url: string };
    expect(c.url).toBe(`https://${PUBLIC}/mcp-from-cred`);
  });

  test("no url and no credentialBaseUrl → throws missing url error", async () => {
    await expect(
      buildConnConfig(sel({ url: null, credentialBaseUrl: null }), {
        stdioEnabled: false,
      }),
    ).rejects.toThrow(/requires a url/);
  });

  test("credentialBaseUrl alone (null url) is sufficient", async () => {
    const c = (await buildConnConfig(
      sel({ url: null, credentialBaseUrl: `https://${PUBLIC}/mcp` }),
      { stdioEnabled: false },
    )) as { url: string };
    expect(c.url).toBe(`https://${PUBLIC}/mcp`);
  });
});

describe("filterAllowed", () => {
  test("keeps only allowlisted tool names; empty allow → none", () => {
    const tools = [fakeTool("a"), fakeTool("b"), fakeTool("c")];
    expect(filterAllowed(tools, ["a", "c"]).map((t) => t.name)).toEqual([
      "a",
      "c",
    ]);
    expect(filterAllowed(tools, [])).toEqual([]);
  });
});

describe("mcpServerSlug", () => {
  test("slugifies the connection name (ASCII-safe, capped)", () => {
    expect(mcpServerSlug("app.fazer.ai")).toBe("app_fazer_ai");
    expect(mcpServerSlug("Açaí Söder")).toBe("acai_soder");
  });

  test("falls back to a digest of the name when it has no usable chars", () => {
    // NOTE: The shape, not the literal digest: asserting the eight characters would make this a test of
    // sha256 and would have to be rewritten by anyone touching the fallback for a real reason.
    expect(mcpServerSlug("***")).toMatch(/^mcp_[0-9a-f]{8}$/);
  });

  test("and that fallback is the same for the same name, and different for a different one", () => {
    // NOTE: The property the transfer depends on (#412): the slug is a function of the name alone, so the
    // row id it used to carry cannot follow the connection into another tenant. Two names that both
    // sanitize to nothing must still land on two slugs, which is why the digest is taken over the raw
    // name and not over the (empty) sanitized one.
    expect(mcpServerSlug("🎯")).toBe(mcpServerSlug("🎯"));
    expect(mcpServerSlug("🎯")).not.toBe(mcpServerSlug("🚀"));
  });
});

describe("namespacedToolName", () => {
  test("builds mcp__<slug>__<tool> and is collision-free within the set", () => {
    const used = new Set<string>();
    expect(namespacedToolName("hub", "whoami", used)).toBe("mcp__hub__whoami");
    // a second identical (slug, tool) gets a deterministic numeric suffix
    expect(namespacedToolName("hub", "whoami", used)).toBe(
      "mcp__hub__whoami_2",
    );
  });

  test("stays within the 64-char limit, trimming the slug before the tool name", () => {
    const used = new Set<string>();
    const longSlug = "a".repeat(60);
    const name = namespacedToolName(longSlug, "do_something", used);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name.endsWith("__do_something")).toBe(true);
  });
});

describe("buildMcpContextSection", () => {
  function metaTool(name: string, server: unknown): StructuredToolInterface {
    return {
      name,
      metadata: { mcpServer: server },
    } as unknown as StructuredToolInterface;
  }

  test("returns null when there are no MCP tools", () => {
    expect(buildMcpContextSection([fakeTool("a")])).toBeNull();
  });

  test("groups tools by server and emits the native instructions when present", () => {
    const section = buildMcpContextSection([
      metaTool("mcp__hub__whoami", {
        label: "Hub",
        instructions: "Manages licenses.",
      }),
      metaTool("mcp__hub__list", {
        label: "Hub",
        instructions: "Manages licenses.",
      }),
      metaTool("mcp__crm__search", { label: "CRM", instructions: null }),
    ]);
    expect(section).toContain("## Ferramentas externas (MCP)");
    expect(section).toContain("### Hub");
    expect(section).toContain("Manages licenses.");
    expect(section).toContain("mcp__hub__whoami, mcp__hub__list");
    expect(section).toContain("### CRM");
    expect(section).toContain("mcp__crm__search");
  });
});

describe("loadMcpToolsForAgent", () => {
  test("filters by allowlist and namespaces the exposed name (allowlist stays bare)", async () => {
    const tools = await loadMcpToolsForAgent(
      7n,
      [sel({ enabledTools: ["a"] })],
      {
        connect: async () => [fakeTool("a"), fakeTool("b")],
      },
    );
    // The allowlist matches the bare server name "a"; the model sees the namespaced name.
    // normalizeToolName keeps hyphens, so "asaas-mcp" → slug "asaas-mcp".
    expect(tools.map((t) => t.name)).toEqual(["mcp__asaas-mcp__a"]);
  });

  test("a connection that fails to load is skipped (never breaks the turn)", async () => {
    const tools = await loadMcpToolsForAgent(
      7n,
      [
        sel({ name: "down", enabledTools: ["a"] }),
        sel({ name: "up", enabledTools: ["x"] }),
      ],
      {
        connect: async (s) => {
          if (s.name === "down") throw new Error("ECONNREFUSED");
          return [fakeTool("x")];
        },
      },
    );
    expect(tools.map((t) => t.name)).toEqual(["mcp__up__x"]);
  });

  test("invokes onDiscoverError for each failing connection, still loading the rest", async () => {
    const failures: Array<{ name: string; message: string }> = [];
    const tools = await loadMcpToolsForAgent(
      7n,
      [
        sel({ name: "down", enabledTools: ["a"] }),
        sel({ name: "up", enabledTools: ["x"] }),
      ],
      {
        connect: async (s) => {
          if (s.name === "down") throw new Error("ECONNREFUSED");
          return [fakeTool("x")];
        },
        onDiscoverError: (s, err) =>
          failures.push({
            name: s.name,
            message: err instanceof Error ? err.message : String(err),
          }),
      },
    );
    // The healthy connection still loads (fail-open preserved)...
    expect(tools.map((t) => t.name)).toEqual(["mcp__up__x"]);
    // ...and exactly the failing one is surfaced to the callback, with its selection + error.
    expect(failures).toEqual([{ name: "down", message: "ECONNREFUSED" }]);
  });

  test("selection with an empty allowlist contributes nothing (fail-closed)", async () => {
    let connectCalls = 0;
    const tools = await loadMcpToolsForAgent(7n, [sel({ enabledTools: [] })], {
      connect: async () => {
        connectCalls++;
        return [fakeTool("a")];
      },
    });
    expect(tools).toEqual([]);
    expect(connectCalls).toBe(0);
  });

  test("same tool name on two servers gets distinct namespaced names (no collision)", async () => {
    const tools = await loadMcpToolsForAgent(
      7n,
      [
        sel({ connId: 1n, name: "alpha", enabledTools: ["search"] }),
        sel({ connId: 2n, name: "beta", enabledTools: ["search"] }),
      ],
      { connect: async () => [fakeTool("search")] },
    );
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__alpha__search",
      "mcp__beta__search",
    ]);
  });

  test("stamps mcpServer metadata (label + instructions) for the prompt section", async () => {
    const tools = await loadMcpToolsForAgent(
      7n,
      [sel({ name: "Hub", enabledTools: ["a"] })],
      {
        connect: async () => [fakeTool("a")],
        instructionsFor: async () => "Manages licenses and instances.",
      },
    );
    const meta = (tools[0] as { metadata?: { mcpServer?: unknown } }).metadata
      ?.mcpServer;
    expect(meta).toEqual({
      label: "Hub",
      instructions: "Manages licenses and instances.",
    });
  });
});
