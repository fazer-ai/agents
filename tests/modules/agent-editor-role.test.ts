import { describe, expect, test } from "bun:test";
import type { TenantContext } from "@/lib/tenancy";
import { assertAgentUpdateAllowedForRole } from "@/modules/agents/service";

const ctx = (role: TenantContext["role"]): TenantContext => ({
  tenantId: 1n,
  userId: 2n,
  role,
});

describe("agent editor role", () => {
  test("allows agent content changes for an editor", () => {
    expect(() =>
      assertAgentUpdateAllowedForRole(
        ctx("EDITOR"),
        {
          name: "Support",
          systemPrompt: "Help the customer.",
          modelConfig: { provider: "openai", model: "gpt-5" },
          settings: { split: { maxChars: 500 } },
        },
        false,
        {
          modelConfig: { provider: "openai", model: "gpt-4.1" },
          settings: { split: { maxChars: 300 } },
        },
      ),
    ).not.toThrow();
  });

  test("refuses operational fields and tool grants for an editor", () => {
    for (const patch of [
      { enabled: true },
      { mode: "production" as const },
      { businessHoursId: "10" },
      { followUpHoursId: null },
    ]) {
      expect(() =>
        assertAgentUpdateAllowedForRole(ctx("EDITOR"), patch, false),
      ).toThrow();
    }
    expect(() =>
      assertAgentUpdateAllowedForRole(ctx("EDITOR"), {}, true),
    ).toThrow();
  });

  test("refuses credential, provider, and endpoint changes for an editor", () => {
    for (const patch of [
      { modelConfig: { provider: "anthropic" } },
      { modelConfig: { credentialRef: "vault:2" } },
      { modelConfig: { baseURL: "https://new.example.com" } },
      { settings: { tts: { credentialRef: "vault:2" } } },
      {
        settings: {
          webhook: {
            credentialRef: "vault:1",
            endpoint: "https://new.example.com",
          },
        },
      },
    ]) {
      expect(() =>
        assertAgentUpdateAllowedForRole(ctx("EDITOR"), patch, false, {
          modelConfig: {
            provider: "openai",
            credentialRef: "vault:1",
            baseURL: "https://old.example.com",
          },
          settings: {
            tts: { credentialRef: "vault:1" },
            webhook: {
              credentialRef: "vault:1",
              endpoint: "https://old.example.com",
            },
          },
        }),
      ).toThrow();
    }
  });

  test("keeps administrators unrestricted and agents read-only", () => {
    expect(() =>
      assertAgentUpdateAllowedForRole(
        ctx("TENANT_ADMIN"),
        { enabled: true, modelConfig: { credentialRef: "vault:2" } },
        true,
      ),
    ).not.toThrow();
    expect(() =>
      assertAgentUpdateAllowedForRole(ctx("AGENT"), { name: "No" }, false),
    ).toThrow();
  });
});
