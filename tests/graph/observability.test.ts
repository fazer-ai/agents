import { describe, expect, test } from "bun:test";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import {
  attachLangfuseDeliveryLogging,
  buildLangfuseHandler,
  environmentForSource,
  langfuseKeysSchema,
  makeMask,
  resolveLangfuseConfig,
} from "@/graph/observability";
import type { ScopedDb } from "@/lib/tenancy";

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

describe("mask", () => {
  test("redacts everything by default (privacy-by-default)", () => {
    const mask = makeMask(undefined);
    expect(mask).toBeDefined();
    expect(mask?.()).toBe("[redacted by fazer.ai PII policy]");
  });

  test("no mask when the tenant opts into raw content", () => {
    expect(makeMask(true)).toBeUndefined();
  });
});

describe("buildLangfuseHandler", () => {
  test("returns null when there is no config (tracing disabled)", () => {
    expect(
      buildLangfuseHandler(null, { tenantId: 1n, threadId: "1:1:1" }),
    ).toBeNull();
  });

  // updateRoot lifts a run's name/input/output onto the ROOT trace, which is right for the turn's
  // own generation and wrong for anything that runs after it under the same turnId: the handler
  // treats a call with no parentRunId as the root, so a SECOND top-level call (the speech
  // normalizer) would overwrite the turn's question and answer in the trace list with its own
  // rewrite. Hence the opt-out, and the default has to stay true for every existing caller.
  test("updateRoot defaults to true and a secondary call can turn it off", () => {
    const cfg = {
      publicKey: "pk-lf-fake",
      secretKey: "sk-lf-fake",
      // Unreachable on purpose: nothing here is meant to leave the process.
      baseUrl: "http://127.0.0.1:9",
    };
    const ctx = { tenantId: 1n, threadId: "1:1:1", turnId: "turn-1" };
    const root = buildLangfuseHandler(cfg, ctx) as unknown as {
      updateRoot: boolean;
    };
    const nested = buildLangfuseHandler(cfg, {
      ...ctx,
      updateRoot: false,
    }) as unknown as { updateRoot: boolean };
    expect(root.updateRoot).toBe(true);
    expect(nested.updateRoot).toBe(false);
  });
});

describe("attachLangfuseDeliveryLogging", () => {
  // The whole point: Langfuse swallows delivery failures (a failed flush is an unlistened "warning"
  // event), so without this the broken-ingestion bug was invisible. This asserts those events reach
  // our logger, and that a persistently-broken instance is deduped (logs once per distinct message).
  function fakeClient() {
    const handlers = new Map<string, (p: unknown) => void>();
    return {
      on(event: string, cb: (p: unknown) => void) {
        handlers.set(event, cb);
      },
      has(event: string) {
        return handlers.has(event);
      },
      fire(event: string, payload: unknown) {
        const cb = handlers.get(event);
        if (!cb) throw new Error(`no handler registered for "${event}"`);
        cb(payload);
      },
    };
  }

  test("routes langfuse error/warning events to the logger, deduped per message", () => {
    const client = fakeClient();
    const calls: unknown[][] = [];
    const log = { warn: (...args: unknown[]) => calls.push(args) };
    attachLangfuseDeliveryLogging(
      client,
      {
        tenantId: 7n,
        environment: "production",
        baseUrl: "https://lf.example.com",
      },
      log as unknown as Pick<typeof import("@/api/lib/logger").default, "warn">,
    );
    expect(client.has("error")).toBe(true);
    expect(client.has("warning")).toBe(true);

    // The exact silent path from the real bug: a failed flush emitted as "warning".
    client.fire(
      "warning",
      new Error("Failed to upload events to blob storage"),
    );
    expect(calls.length).toBe(1);
    // Same message again → deduped (no per-turn flooding when the instance stays broken).
    client.fire(
      "warning",
      new Error("Failed to upload events to blob storage"),
    );
    expect(calls.length).toBe(1);
    // A distinct failure still logs.
    client.fire("error", "invalid credentials");
    expect(calls.length).toBe(2);

    // Context the operator needs to act is attached.
    const [meta, msg] = calls[0] as [Record<string, unknown>, string];
    expect(meta.tenantId).toBe("7");
    expect(meta.environment).toBe("production");
    expect(meta.baseUrl).toBe("https://lf.example.com");
    expect(String(msg)).toContain("langfuse trace delivery failed");
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
    // environment is no longer part of the config — it is injected at client-creation time from config.env.
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
    expect(cfg?.baseUrl).toBeUndefined();
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
