import { afterAll, describe, expect, test } from "bun:test";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import {
  buildLangfuseHandler,
  environmentForSource,
  LANGFUSE_DELIVERY_RETRY,
  langfuseKeysSchema,
  resolveLangfuseConfig,
  shutdownLangfuseClients,
} from "@/graph/observability";
import type { ScopedDb } from "@/lib/tenancy";

afterAll(async () => {
  await shutdownLangfuseClients();
});

describe("langfuse delivery retry", () => {
  test("ships as three retries, three seconds apart", () => {
    expect(LANGFUSE_DELIVERY_RETRY).toEqual({
      fetchRetryCount: 3,
      fetchRetryDelay: 3_000,
    });
  });
});

describe("langfuse key pair", () => {
  test("parses a valid key pair (the vault secret value)", () => {
    const r = langfuseKeysSchema.safeParse({
      publicKey: "pk-1",
      secretKey: "sk-1",
    });
    expect(r.success).toBe(true);
  });

  test("rejects an incomplete key pair (tracing off)", () => {
    expect(langfuseKeysSchema.safeParse({ publicKey: "pk-1" }).success).toBe(
      false,
    );
    expect(langfuseKeysSchema.safeParse(null).success).toBe(false);
  });
});

describe("buildLangfuseHandler", () => {
  test("returns null when there is no config (tracing disabled)", () => {
    expect(
      buildLangfuseHandler(null, { tenantId: 1n, threadId: "1:1:1" }),
    ).toBeNull();
  });
});

describe("environmentForSource", () => {
  test("real traffic (inbox/default) tracks the deployment tier", () => {
    expect(environmentForSource(undefined)).toBe(config.env);
    expect(environmentForSource("inbox")).toBe(config.env);
  });

  test("playground gets a sibling <tier>-playground environment", () => {
    expect(environmentForSource("playground")).toBe(`${config.env}-playground`);
    // Never collides with the real environment, so the UI selector can split them.
    expect(environmentForSource("playground")).not.toBe(
      environmentForSource("inbox"),
    );
  });

  test("the client channel gets its own <tier>-client environment", () => {
    expect(environmentForSource("client")).toBe(`${config.env}-client`);
  });
});

// Helpers for resolveLangfuseConfig unit tests (no real DB needed).
function mockDb(options: {
  settingsBlock: unknown;
  slug?: string;
  vaultEntry?: {
    secret: unknown;
    kind: string;
    baseUrl: string | null;
    paramName: string | null;
    name: string;
  } | null;
}): ScopedDb {
  return {
    tenant: {
      // Serves both reads resolveLangfuseConfig makes: settings (readLangfuseSettings) and slug.
      findUnique: async () => ({
        settings: { langfuse: options.settingsBlock },
        slug: options.slug,
      }),
    },
    vaultEntry: {
      findFirst: async () => {
        if (options.vaultEntry === undefined) return null;
        if (options.vaultEntry === null) return null;
        return {
          secret: encryptJson(options.vaultEntry.secret),
          kind: options.vaultEntry.kind,
          baseUrl: options.vaultEntry.baseUrl,
          paramName: options.vaultEntry.paramName,
          name: options.vaultEntry.name,
        };
      },
    },
  } as unknown as ScopedDb;
}

describe("resolveLangfuseConfig", () => {
  test("returns null when disabled", async () => {
    const db = mockDb({
      settingsBlock: { enabled: false, credentialRef: "vault:1" },
    });
    expect(await resolveLangfuseConfig(db, 1n)).toBeNull();
  });

  test("returns null when no credentialRef", async () => {
    const db = mockDb({
      settingsBlock: { enabled: true, credentialRef: null },
    });
    expect(await resolveLangfuseConfig(db, 1n)).toBeNull();
  });

  test("returns null when vault entry not found", async () => {
    const db = mockDb({
      settingsBlock: { enabled: true, credentialRef: "vault:99" },
      vaultEntry: null,
    });
    expect(await resolveLangfuseConfig(db, 1n)).toBeNull();
  });

  test("baseUrl from the vault entry takes precedence (credential is self-contained)", async () => {
    const db = mockDb({
      settingsBlock: {
        enabled: true,
        credentialRef: "vault:1",
      },
      vaultEntry: {
        secret: { publicKey: "pk-1", secretKey: "sk-1" },
        kind: "langfuse",
        baseUrl: "https://us.cloud.langfuse.com",
        paramName: null,
        name: "lf",
      },
    });
    const cfg = await resolveLangfuseConfig(db, 1n);
    expect(cfg?.baseUrl).toBe("https://us.cloud.langfuse.com");
    expect(cfg?.publicKey).toBe("pk-1");
    expect(cfg?.secretKey).toBe("sk-1");
    // NOTE: environment is not part of the config; it is injected at client creation from config.env.
    expect(
      (cfg as Record<string, unknown> | null)?.environment,
    ).toBeUndefined();
  });

  test("baseUrl is undefined when vault entry has no baseUrl (→ Langfuse cloud default)", async () => {
    const db = mockDb({
      settingsBlock: { enabled: true, credentialRef: "vault:1" },
      vaultEntry: {
        secret: { publicKey: "pk-2", secretKey: "sk-2" },
        kind: "langfuse",
        baseUrl: null,
        paramName: null,
        name: "lf",
      },
    });
    const cfg = await resolveLangfuseConfig(db, 1n);
    expect(cfg).toMatchObject({ publicKey: "pk-2", secretKey: "sk-2" });
    expect(cfg).toHaveProperty("baseUrl", undefined);
  });

  test("exposes the tenant slug as tenantSlug (the Langfuse trace userId source)", async () => {
    const db = mockDb({
      settingsBlock: { enabled: true, credentialRef: "vault:1" },
      slug: "acme-co",
      vaultEntry: {
        secret: { publicKey: "pk-1", secretKey: "sk-1" },
        kind: "langfuse",
        baseUrl: "https://lf.example.com",
        paramName: null,
        name: "lf",
      },
    });
    const cfg = await resolveLangfuseConfig(db, 1n);
    expect(cfg?.tenantSlug).toBe("acme-co");
  });
});
