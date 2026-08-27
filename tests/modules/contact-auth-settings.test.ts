import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import {
  BEHAVIOR_SETTINGS_KEYS,
  mergeBehaviorSettings,
  readBehaviorSettings,
} from "@/modules/agents/behavior-settings";
import {
  SettingsTextTooLongError,
  updateAgent,
} from "@/modules/agents/service";
import {
  CONTACT_AUTH_DEFAULTS,
  readContactAuthConfig,
  readContactAuthUrl,
} from "@/modules/contact-auth/settings";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentSettingsGet, agentSettingsSet } from "@/modules/mcp/write";

// The config reader's decision table (defaults, clamps, the strict switch) plus the shared
// behavior-settings surface, so REST/UI/MCP all project the same normalized block.

describe("readContactAuthConfig", () => {
  test("absent/garbage block → defaults, gate off", () => {
    expect(readContactAuthConfig(undefined)).toEqual(CONTACT_AUTH_DEFAULTS);
    expect(readContactAuthConfig({})).toEqual(CONTACT_AUTH_DEFAULTS);
    expect(readContactAuthConfig({ contactAuth: 7 })).toEqual(
      CONTACT_AUTH_DEFAULTS,
    );
  });

  test("the switch is on only for a real boolean true", () => {
    expect(readContactAuthConfig({ contactAuth: {} }).enabled).toBe(false);
    expect(
      readContactAuthConfig({ contactAuth: { enabled: "true" } }).enabled,
    ).toBe(false);
    expect(readContactAuthConfig({ contactAuth: { enabled: 1 } }).enabled).toBe(
      false,
    );
    expect(
      readContactAuthConfig({ contactAuth: { enabled: true } }).enabled,
    ).toBe(true);
  });

  test("numbers clamp into their documented ranges", () => {
    const c = readContactAuthConfig({
      contactAuth: { timeoutMs: 50, noticeCooldownSeconds: 999_999 },
    });
    expect(c.timeoutMs).toBe(1000);
    expect(c.noticeCooldownSeconds).toBe(3600);
    const d = readContactAuthConfig({
      contactAuth: { timeoutMs: 60_000, noticeCooldownSeconds: -5 },
    });
    expect(d.timeoutMs).toBe(10_000);
    expect(d.noticeCooldownSeconds).toBe(0);
    // NOTE: 0 is a meaningful cooldown (notify on every refused message), not a fallback.
    expect(
      readContactAuthConfig({ contactAuth: { noticeCooldownSeconds: 0 } })
        .noticeCooldownSeconds,
    ).toBe(0);
    expect(
      readContactAuthConfig({ contactAuth: { timeoutMs: "fast" } }).timeoutMs,
    ).toBe(5000);
  });

  // The reuse mode (issue #189). Anything that is not the one alternative spelling reads as the
  // default, for the reason the `enabled` switch is strict: a malformed write may only ever leave
  // the gate asking MORE often, never less.
  test("the mode is perMessage unless the bag says exactly `once`", () => {
    expect(readContactAuthConfig({ contactAuth: {} }).mode).toBe("perMessage");
    expect(readContactAuthConfig({ contactAuth: { mode: "once" } }).mode).toBe(
      "once",
    );
    expect(readContactAuthConfig({ contactAuth: { mode: "ONCE" } }).mode).toBe(
      "perMessage",
    );
    expect(
      readContactAuthConfig({ contactAuth: { mode: "cached" } }).mode,
    ).toBe("perMessage");
    expect(readContactAuthConfig({ contactAuth: { mode: true } }).mode).toBe(
      "perMessage",
    );
  });

  test("the grant TTL clamps into its documented range", () => {
    expect(readContactAuthConfig({ contactAuth: {} }).grantTtlSeconds).toBe(
      86_400,
    );
    expect(
      readContactAuthConfig({ contactAuth: { grantTtlSeconds: 5 } })
        .grantTtlSeconds,
    ).toBe(60);
    expect(
      readContactAuthConfig({ contactAuth: { grantTtlSeconds: 99_999_999 } })
        .grantTtlSeconds,
    ).toBe(2_592_000);
    expect(
      readContactAuthConfig({ contactAuth: { grantTtlSeconds: "1h" } })
        .grantTtlSeconds,
    ).toBe(86_400);
    // Zero is not "never reuse": the mode says that. A TTL of zero would be a grant that expires
    // before it is read, which is the same thing said twice and in the more confusing place.
    expect(
      readContactAuthConfig({ contactAuth: { grantTtlSeconds: 0 } })
        .grantTtlSeconds,
    ).toBe(60);
  });

  test("includeMessageText needs a real boolean, and is the STORED opt-in", () => {
    expect(
      readContactAuthConfig({
        contactAuth: { includeMessageText: true },
      }).includeMessageText,
    ).toBe(true);
    expect(
      readContactAuthConfig({
        contactAuth: { includeMessageText: "true" },
      }).includeMessageText,
    ).toBe(false);
    expect(readContactAuthConfig({ contactAuth: {} }).includeMessageText).toBe(
      false,
    );
  });

  // A stored `method` is a leftover from when the request could be a GET. It is not a setting any
  // more, and reading it back as one would resurrect a choice the operator can no longer make.
  test("a leftover method in the bag is ignored, not carried forward", () => {
    const cfg = readContactAuthConfig({
      contactAuth: { method: "GET", includeMessageText: true },
    });
    expect(cfg.includeMessageText).toBe(true);
    expect(cfg).not.toHaveProperty("method");
  });

  test("denyMessage is trimmed and empty collapses to null", () => {
    expect(
      readContactAuthConfig({
        contactAuth: { denyMessage: "  atendemos só clientes  " },
      }).denyMessage,
    ).toBe("atendemos só clientes");
    expect(
      readContactAuthConfig({ contactAuth: { denyMessage: "   " } })
        .denyMessage,
    ).toBeNull();
    expect(
      readContactAuthConfig({ contactAuth: { denyMessage: 42 } }).denyMessage,
    ).toBeNull();
  });

  test("handoff defaults on; the team id must be a positive integer", () => {
    const c = readContactAuthConfig({ contactAuth: {} });
    expect(c.handoffEnabled).toBe(true);
    expect(c.handoffTeamId).toBeNull();
    expect(
      readContactAuthConfig({
        contactAuth: { handoffEnabled: false, handoffTeamId: 12 },
      }),
    ).toMatchObject({ handoffEnabled: false, handoffTeamId: 12 });
    expect(
      readContactAuthConfig({ contactAuth: { handoffTeamId: "12" } })
        .handoffTeamId,
    ).toBeNull();
    expect(
      readContactAuthConfig({ contactAuth: { handoffTeamId: -3 } })
        .handoffTeamId,
    ).toBeNull();
  });
});

describe("readContactAuthUrl", () => {
  test("keeps a plain http(s) URL, query included", () => {
    expect(readContactAuthUrl("https://api.x.com/check?tenant=1")).toBe(
      "https://api.x.com/check?tenant=1",
    );
    expect(readContactAuthUrl(" http://localhost:8080/auth ")).toBe(
      "http://localhost:8080/auth",
    );
  });

  test("refuses whole what cannot be an endpoint", () => {
    expect(readContactAuthUrl("not a url")).toBeNull();
    expect(readContactAuthUrl("ftp://files.x.com/auth")).toBeNull();
    expect(readContactAuthUrl("file:///etc/passwd")).toBeNull();
    // Credentials belong in the vault; a URL carrying them is refused rather than stripped.
    expect(readContactAuthUrl("https://user:pass@api.x.com/auth")).toBeNull();
    expect(readContactAuthUrl("")).toBeNull();
    expect(readContactAuthUrl(undefined)).toBeNull();
  });
});

describe("behavior-settings surface", () => {
  test("contactAuth is an owned key and projects defaults when absent", () => {
    expect(BEHAVIOR_SETTINGS_KEYS).toContain("contactAuth");
    expect(readBehaviorSettings({}).contactAuth).toEqual(CONTACT_AUTH_DEFAULTS);
  });

  test("a partial patch merges + normalizes; unknown bag keys survive", () => {
    const current = {
      foo: "keep",
      contactAuth: {
        enabled: true,
        url: "https://api.x.com/check",
        handoffTeamId: 9,
      },
    };
    const next = mergeBehaviorSettings(current, {
      contactAuth: { denyMessage: "  só clientes  ", timeoutMs: 99_999 },
    });
    const ca = next.contactAuth as Record<string, unknown>;
    expect(ca.enabled).toBe(true);
    expect(ca.url).toBe("https://api.x.com/check");
    expect(ca.handoffTeamId).toBe(9);
    expect(ca.denyMessage).toBe("só clientes");
    expect(ca.timeoutMs).toBe(10_000);
    expect(next.foo).toBe("keep");
  });

  test("an invalid URL collapses to null on write, never a raw store", () => {
    const next = mergeBehaviorSettings(
      {},
      { contactAuth: { enabled: true, url: "https://u:p@api.x.com/a" } },
    );
    expect((next.contactAuth as Record<string, unknown>).url).toBeNull();
  });
});

// ── The write surfaces, against a real Postgres: the REST service path stores the block as sent
// (readers normalize on read), the text cap refuses an oversized denyMessage, and the MCP
// projection speaks credential NAMES in both directions via SETTINGS_CREDENTIAL_PATHS. ──

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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let agentId = 0n;
let credId = 0n;

function ctx(): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

function principal(): VerifiedToken {
  return {
    userId: 1n,
    tenantId,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
  };
}

describe.skipIf(!dbUp)("contactAuth on the write surfaces", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CAS", slug: `cas-${process.pid}` },
    });
    tenantId = t.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Bot",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
      select: { id: true },
    });
    agentId = agent.id;
    const cred = await suDb.vaultEntry.create({
      data: {
        tenantId,
        name: "auth-key",
        kind: "bearer_token",
        secret: encryptJson("sk"),
      },
      select: { id: true },
    });
    credId = cred.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["agents", "vault_entries", "audit_logs"]) {
        await suDb
          .$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          )
          .catch(() => {});
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("REST round-trip: the block persists and the reader projects it back normalized", async () => {
    await updateAgent(
      ctx(),
      agentId,
      {
        settings: {
          contactAuth: {
            enabled: true,
            url: "https://api.example.com/check?tenant=t1",
            method: "post",
            credentialRef: `vault:${credId}`,
            timeoutMs: 99_999,
            noticeCooldownSeconds: 0,
            includeMessageText: true,
            denyMessage: "  Atendemos apenas clientes.  ",
            handoffEnabled: false,
            mode: "once",
            grantTtlSeconds: 99_999_999,
            handoffTeamId: 12,
            handoffTeamInstanceId: 3,
          },
        },
      },
      appDb,
    );
    const row = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { settings: true },
    });
    expect(readContactAuthConfig(row.settings)).toEqual({
      enabled: true,
      url: "https://api.example.com/check?tenant=t1",
      credentialRef: `vault:${credId}`,
      timeoutMs: 10_000,
      noticeCooldownSeconds: 0,
      includeMessageText: true,
      denyMessage: "Atendemos apenas clientes.",
      handoffEnabled: false,
      mode: "once",
      grantTtlSeconds: 2_592_000,
      handoffTeamId: 12,
      handoffTeamInstanceId: 3,
    });
  });

  test("an oversized denyMessage is refused with its dotted path, like every capped text", async () => {
    await expect(
      updateAgent(
        ctx(),
        agentId,
        { settings: { contactAuth: { denyMessage: "x".repeat(2001) } } },
        appDb,
      ),
    ).rejects.toThrow(SettingsTextTooLongError);
  });

  test("MCP get projects the block with the credential as a NAME", async () => {
    const r = await agentSettingsGet(
      principal(),
      { agent_id: String(agentId) },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      const ca = (r.data.settings as Record<string, unknown>)
        .contactAuth as Record<string, unknown>;
      expect(ca.enabled).toBe(true);
      expect(ca.credentialRef).toBe("auth-key");
    }
  });

  test("MCP set resolves a credential NAME to the stable ref before storing", async () => {
    const r = await agentSettingsSet(
      principal(),
      {
        agent_id: String(agentId),
        contactAuth: { credentialRef: "auth-key", noticeCooldownSeconds: 120 },
        dry_run: false,
      },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    const row = await suDb.agent.findUniqueOrThrow({
      where: { id: agentId },
      select: { settings: true },
    });
    const ca = readContactAuthConfig(row.settings);
    expect(ca.credentialRef).toBe(`vault:${credId}`);
    expect(ca.noticeCooldownSeconds).toBe(120);
    // The rest of the block survived the partial patch.
    expect(ca.url).toBe("https://api.example.com/check?tenant=t1");
  });
});
