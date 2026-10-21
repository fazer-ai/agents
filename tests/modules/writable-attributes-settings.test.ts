import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  readWritableAttributesState,
  serializeWritableAttributes,
} from "@/client/pages/agents/WritableAttributesFields";
import { readBehaviorSettings } from "@/modules/agents/behavior-settings";
import { assertAgentCreatable } from "@/modules/agents/service";
import {
  readWritableAttributes,
  WRITABLE_ATTRIBUTES_MAX,
} from "@/modules/agents/tool-guidance";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsGet, agentSettingsSet } from "@/modules/mcp/write";
import { dbProbeFailed } from "@/tests/db-gate";

// `settings.setCustomAttribute.allowed`: one reader for the runtime and the editor, the same domain
// refused on REST and MCP, and the editor's form round-tripping what it stores.

describe("readWritableAttributes", () => {
  test("keeps { scope, key } pairs, trimmed and deduplicated, dropping anything else", () => {
    expect(
      readWritableAttributes({
        setCustomAttribute: {
          allowed: [
            { scope: "contact", key: " nome " },
            { scope: "contact", key: "nome" },
            { scope: "conversation", key: "nome" },
            { scope: "company", key: "x" },
            { scope: "task", key: "" },
            "nome",
            null,
          ],
        },
      }),
    ).toEqual([
      { scope: "contact", key: "nome" },
      { scope: "conversation", key: "nome" },
    ]);
  });

  test("absent or malformed reads as no list", () => {
    expect(readWritableAttributes({})).toEqual([]);
    expect(readWritableAttributes({ setCustomAttribute: [] })).toEqual([]);
    expect(
      readWritableAttributes({ setCustomAttribute: { allowed: "nome" } }),
    ).toEqual([]);
  });

  test("stops at the ceiling", () => {
    const allowed = Array.from(
      { length: WRITABLE_ATTRIBUTES_MAX + 5 },
      (_, i) => ({
        scope: "conversation",
        key: `k${i}`,
      }),
    );
    expect(
      readWritableAttributes({ setCustomAttribute: { allowed } }),
    ).toHaveLength(WRITABLE_ATTRIBUTES_MAX);
  });

  test("the behavior projection carries it", () => {
    expect(
      readBehaviorSettings({
        setCustomAttribute: { allowed: [{ scope: "task", key: "etapa" }] },
      }).setCustomAttribute,
    ).toEqual({ allowed: [{ scope: "task", key: "etapa" }] });
  });
});

describe("the REST write refuses what the reader would throw away", () => {
  const refusal = (settings: Record<string, unknown>) => {
    try {
      assertAgentCreatable({ name: "x", settings });
    } catch (e) {
      return e as { statusCode?: number; message: string };
    }
    return null;
  };

  test("a scope outside the three", () => {
    const err = refusal({
      setCustomAttribute: { allowed: [{ scope: "company", key: "x" }] },
    });
    expect(err?.statusCode).toBe(400);
    expect(err?.message).toContain("setCustomAttribute.allowed.0.scope");
  });

  test("an entry that is a bare key", () => {
    const err = refusal({ setCustomAttribute: { allowed: ["nome"] } });
    expect(err?.message).toContain("setCustomAttribute.allowed.0");
  });

  test("a list past the ceiling", () => {
    const allowed = Array.from(
      { length: WRITABLE_ATTRIBUTES_MAX + 1 },
      (_, i) => ({
        scope: "conversation",
        key: `k${i}`,
      }),
    );
    expect(refusal({ setCustomAttribute: { allowed } })).not.toBeNull();
  });

  test("a well-formed list passes", () => {
    expect(
      refusal({
        setCustomAttribute: { allowed: [{ scope: "contact", key: "nome" }] },
      }),
    ).toBeNull();
  });
});

describe("the editor's form", () => {
  test("round-trips the stored pairs per scope", () => {
    const stored = {
      allowed: [
        { scope: "contact", key: "nome" },
        { scope: "conversation", key: "serie" },
        { scope: "contact", key: "cpf" },
      ],
    };
    const form = readWritableAttributesState(stored);
    expect(form).toEqual({
      conversation: ["serie"],
      contact: ["nome", "cpf"],
      task: [],
    });
    expect(serializeWritableAttributes(form)).toEqual([
      { scope: "conversation", key: "serie" },
      { scope: "contact", key: "nome" },
      { scope: "contact", key: "cpf" },
    ]);
  });
});

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}

describe.skipIf(!dbUp)("MCP writes and reads the list", () => {
  let tenantId = 0n;
  let agentId = 0n;
  const principal = (): VerifiedToken => ({
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  });

  beforeAll(async () => {
    tenantId = (
      await (su as PrismaClient).tenant.create({
        data: { name: "Attr1564", slug: `attr1564-${process.pid}` },
      })
    ).id;
    agentId = (
      await (su as PrismaClient).agent.create({
        data: { tenantId, name: "Bot", systemPrompt: "p" },
      })
    ).id;
  });
  afterAll(async () => {
    await su?.tenant.delete({ where: { id: tenantId } }).catch(() => {});
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("agent_settings_set stores it and agent_settings_get gives it back", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        setCustomAttribute: { allowed: [{ scope: "contact", key: "nome" }] },
      } as never,
      { base: app as PrismaClient },
    );
    expect(r.ok).toBe(true);
    const stored = (
      await (su as PrismaClient).agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, unknown>;
    expect(stored.setCustomAttribute).toEqual({
      allowed: [{ scope: "contact", key: "nome" }],
    });
    const got = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) } as never,
      { base: app as PrismaClient },
    );
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(
      (got.data as { settings: Record<string, unknown> }).settings
        .setCustomAttribute,
    ).toEqual({ allowed: [{ scope: "contact", key: "nome" }] });
  });

  test("an empty list clears it", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        dry_run: false,
        setCustomAttribute: { allowed: [] },
      } as never,
      { base: app as PrismaClient },
    );
    expect(r.ok).toBe(true);
    const stored = (
      await (su as PrismaClient).agent.findUniqueOrThrow({
        where: { id: agentId },
        select: { settings: true },
      })
    ).settings as Record<string, unknown>;
    expect(readWritableAttributes(stored)).toEqual([]);
  });
});
