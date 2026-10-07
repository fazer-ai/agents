import { describe, expect, test } from "bun:test";
import { auditTools, secretInputs } from "@/../scripts/mcp-tools-check";

// The check guards the secret-by-reference rule of docs/mcp.md: no tool takes a raw secret as an
// argument except the documented exceptions. It reads the arguments, because that is where a
// secret crosses the model; a tool's name says neither that it takes one nor that it returns one.

const tool = (name: string, properties: Record<string, unknown> = {}) => ({
  name,
  inputSchema: { type: "object", properties },
});
const str = { type: "string" };

// A listing that satisfies every scope-gating invariant, so a test changes one thing at a time.
function listing(adminExtra: ReturnType<typeof tool>[] = []) {
  const readOnly = [tool("whoami"), tool("agent_get")];
  const write = [...readOnly, tool("agent_create")];
  const admin = [
    ...write,
    tool("tenant_create"),
    tool("branding_set"),
    ...adminExtra,
  ];
  return { readOnly, write, admin };
}

describe("mcp-tools-check", () => {
  test("the real tool listing passes", () => {
    const run = Bun.spawnSync(["bun", "scripts/mcp-tools-check.ts"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = JSON.parse(run.stdout.toString());
    expect(out.failures).toEqual([]);
    expect(run.exitCode).toBe(0);
  });

  test("each scope-gating defect is reported", () => {
    const ok = listing();
    const without = (set: ReturnType<typeof tool>[], name: string) =>
      set.filter((t) => t.name !== name);
    const cases: [ReturnType<typeof listing>, string][] = [
      [
        { ...ok, readOnly: without(ok.readOnly, "whoami") },
        "read-only missing whoami",
      ],
      [
        { ...ok, readOnly: without(ok.readOnly, "agent_get") },
        "read-only missing agent_get",
      ],
      [
        { ...ok, readOnly: [...ok.readOnly, tool("agent_update")] },
        "read-only token exposes a write tool",
      ],
      [
        { ...ok, write: without(ok.write, "agent_create") },
        "write missing agent_create",
      ],
      [
        { ...ok, write: [...ok.write, tool("tenant_create")] },
        "write token exposes tenant_create",
      ],
      [
        { ...ok, admin: without(ok.admin, "tenant_create") },
        "admin missing tenant_create",
      ],
      [
        { ...ok, admin: without(ok.admin, "branding_set") },
        "admin missing branding_set",
      ],
    ];
    expect(auditTools(ok)).toEqual([]);
    for (const [broken, failure] of cases)
      expect(auditTools(broken)).toEqual([failure]);
  });

  test("a raw secret argument outside the documented exceptions fails", () => {
    expect(
      auditTools(
        listing([
          tool("webhook_create", { signing_secret: str }),
          tool("integration_create", {
            settings: { type: "object", properties: { api_key: str } },
          }),
          tool("user_invite", { password: str }),
        ]),
      ),
    ).toEqual([
      "raw secret arguments outside docs/mcp.md's exceptions: webhook_create.signing_secret, integration_create.settings.api_key, user_invite.password",
    ]);
  });

  test("a documented exception covers its own field on its own tool only", () => {
    expect(
      auditTools(
        listing([
          tool("deployment_rotate_token", { admin_token: str }),
          tool("deployment_connect", { admin_token: str, password: str }),
          tool("webhook_update", { admin_token: str }),
        ]),
      ),
    ).toEqual([
      "raw secret arguments outside docs/mcp.md's exceptions: deployment_connect.password, webhook_update.admin_token",
    ]);
  });

  test("a reference, an id, a token count and design tokens are not secrets", () => {
    expect(
      secretInputs(
        tool("x", {
          secret_ref: str,
          credentialRef: str,
          inbound_secret_ref: str,
          api_key_id: str,
          limits: {
            type: "object",
            properties: { maxHistoryTokens: { type: "number" } },
          },
          tokens_light: { type: "object" },
        }),
      ),
    ).toEqual([]);
  });

  test("a secret field is found through arrays, unions and maps", () => {
    expect(
      secretInputs(
        tool("x", {
          list: { type: "array", items: { properties: { token: str } } },
          either: { anyOf: [{ properties: { client_secret: str } }] },
          headers: { additionalProperties: { properties: { apiKey: str } } },
        }),
      ),
    ).toEqual(["list[].token", "either.client_secret", "headers.*.apiKey"]);
  });

  test("a tool whose name says it hands out a secret still fails", () => {
    expect(
      auditTools(
        listing([
          tool("webhook_secret_get"),
          tool("route_token_reveal"),
          tool("password_show"),
          tool("apikey_export"),
          tool("api_key_list"),
        ]),
      ),
    ).toEqual([
      "tool names that read as returning a secret: webhook_secret_get, route_token_reveal, password_show, apikey_export",
    ]);
  });
});
