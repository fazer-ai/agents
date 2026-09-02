import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { formatVaultRef } from "@/client/lib/credentialRef";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { runScopedOn } from "@/lib/tenancy";
import { readAgentConfigHealth } from "@/modules/agents/config-health-read";
import { updateAgent } from "@/modules/agents/service";
import {
  AGENT_EXPORT_KIND,
  AGENT_EXPORT_VERSION,
  importAgent,
} from "@/modules/agents/transfer";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { agentUpdate } from "@/modules/mcp/write-agents";
import { updateEmbeddingSettings } from "@/modules/tenant-settings/service";
import { tryResolveApiKeyEntry } from "@/modules/vault/service";

// A credential reference names an entry that EXISTS; nothing asked whether that entry can produce
// what the field reading it needs. Issue #471.
//
// The two shapes a vault entry can hold are declared in the catalog and neither is a string: a kind
// with `fields` (google_oauth, langfuse) holds a multi-field object, and one with `managedBlob`
// (mcp_oauth) holds a server-managed JSON blob. A third kind of mismatch is not about shape at all:
// `neverOutbound` entries (mcp_env, langfuse) hold a perfectly good string that the catalog says
// must never travel in an outbound request, and an API-key field sends exactly that.
//
// Measured on the base before this change: the REST write returned 200, the MCP write echoed the
// diff, `readAgentConfigHealth` answered `healthy: true` with zero issues, and `loadAgentConfig`
// handed `{ clientId, clientSecret }` down as `cfg.apiKey`, typed `string`.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

let tenantId = 0n;
let agentId = 0n;
let oauthRef = "";
let blobRef = "";
let envRef = "";
let keyRef = "";
let malformedRef = "";

const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});
const principal = (): VerifiedToken => ({
  userId: 1n,
  tenantId,
  role: "TENANT_ADMIN",
  scopes: ["mcp:read", "mcp:write"],
  clientId: "c",
  jti: "j",
});

async function refused(
  fn: () => Promise<unknown>,
): Promise<{ status: number; field?: string; message: string } | null> {
  try {
    await fn();
    return null;
  } catch (e) {
    if (e instanceof AppError) {
      return { status: e.statusCode, field: e.field, message: e.message };
    }
    throw e;
  }
}

describe.skipIf(!dbUp)("a credential whose kind cannot serve the field", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CS", slug: `cs-${process.pid}` },
      })
    ).id;
    const mk = async (
      name: string,
      kind: string,
      secret: unknown,
      extra = {},
    ) =>
      formatVaultRef(
        String(
          (
            await suDb.vaultEntry.create({
              data: {
                tenantId,
                name,
                kind,
                secret: encryptJson(secret),
                ...extra,
              },
              select: { id: true },
            })
          ).id,
        ),
      );
    // Multi-field: the operator supplies the OAuth app pair and the consent flow merges tokens in.
    oauthRef = await mk("google-conn", "google_oauth", {
      clientId: "abc.apps.googleusercontent.com",
      clientSecret: "GOCSPX-zzz",
    });
    // Server-managed blob, created empty by the connect flow.
    blobRef = await mk(
      "mcp-conn",
      "mcp_oauth",
      {},
      {
        baseUrl: "https://mcp.example.com",
      },
    );
    // A plain string the catalog says must NEVER leave in an HTTP request: the stdio loader reads it.
    envRef = await mk("stdio-token", "mcp_env", "tok-abc", {
      paramName: "API_TOKEN",
    });
    keyRef = await mk("model-key", "openai", "sk-live");
    // A kind that DECLARES a plain string, holding something else. `validateVaultValue` refuses this
    // shape today, so it can only exist from before the kind did — or from a path that does not go
    // through it. The catalog cannot see it: only the value can.
    malformedRef = await mk("legacy-shaped", "generic", { apiKey: "sk-x" });
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Probe",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: keyRef,
          },
          settings: { stt: { enabled: false } },
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await suDb.agent.deleteMany({ where: { tenantId } });
    await suDb.vaultEntry.deleteMany({ where: { tenantId } });
    await suDb.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  describe("the REST/console write refuses it, naming the field", () => {
    for (const [label, ref] of [
      ["a multi-field kind", () => oauthRef],
      ["a managed-blob kind", () => blobRef],
      ["a never-outbound kind", () => envRef],
    ] as [string, () => string][]) {
      test(`model credential: ${label}`, async () => {
        const r = await refused(() =>
          updateAgent(
            ctx(),
            agentId,
            {
              modelConfig: {
                provider: "openai",
                model: "gpt-4o-mini",
                credentialRef: ref(),
              },
            },
            appDb,
          ),
        );
        expect(r).not.toBeNull();
        expect(r?.status).toBe(400);
        expect(r?.field).toBe("modelConfig.credentialRef");
      });
    }

    test("a settings credential is named by its dotted path", async () => {
      const r = await refused(() =>
        updateAgent(
          ctx(),
          agentId,
          { settings: { tts: { enabled: true, credentialRef: oauthRef } } },
          appDb,
        ),
      );
      expect(r?.status).toBe(400);
      expect(r?.field).toBe("settings.tts.credentialRef");
    });

    // The finding that made this section grow: the boundary asked the KIND and the runtime asked the
    // kind AND the value, so there was a configuration the write accepted, config-health called
    // healthy, and the turn then dropped. Three surfaces, one question.
    test("a kind that should hold a string, holding something else, is refused", async () => {
      const r = await refused(() =>
        updateAgent(
          ctx(),
          agentId,
          {
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: malformedRef,
            },
          },
          appDb,
        ),
      );
      expect(r?.status).toBe(400);
      expect(r?.field).toBe("modelConfig.credentialRef");
    });

    // The one exemption on the VALUE half, and only that half: a reference-only entry has no secret
    // yet by design, and refusing it would break the flow `credential_create` exists for.
    test("a pending entry is still accepted", async () => {
      const pending = formatVaultRef(
        String(
          (
            await suDb.vaultEntry.create({
              data: {
                tenantId,
                name: "not-filled-yet",
                kind: "openai",
                secret: encryptJson({}),
                status: "pending",
              },
              select: { id: true },
            })
          ).id,
        ),
      );
      const r = await refused(() =>
        updateAgent(
          ctx(),
          agentId,
          {
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: pending,
            },
          },
          appDb,
        ),
      );
      expect(r).toBeNull();
    });

    test("a usable kind still passes", async () => {
      const r = await refused(() =>
        updateAgent(
          ctx(),
          agentId,
          {
            modelConfig: {
              provider: "openai",
              model: "gpt-4o-mini",
              credentialRef: keyRef,
            },
          },
          appDb,
        ),
      );
      expect(r).toBeNull();
    });

    // contactAuth is the one agent field that does NOT read a plain string: it goes through
    // resolveInjectableCredentialEntry, which refreshes a managed-OAuth token and injects THAT. A
    // rule that refused every non-string kind everywhere would break the feature it protects.
    test("contact authorization accepts a managed-OAuth kind", async () => {
      const r = await refused(() =>
        updateAgent(
          ctx(),
          agentId,
          {
            settings: {
              contactAuth: {
                enabled: true,
                credentialRef: oauthRef,
                url: "https://x.example",
              },
            },
          },
          appDb,
        ),
      );
      expect(r).toBeNull();
    });

    // ...and still refuses the one thing it cannot send: a secret the catalog marks never-outbound.
    test("contact authorization refuses a never-outbound kind", async () => {
      const r = await refused(() =>
        updateAgent(
          ctx(),
          agentId,
          {
            settings: {
              contactAuth: {
                enabled: true,
                credentialRef: envRef,
                url: "https://x.example",
              },
            },
          },
          appDb,
        ),
      );
      expect(r?.status).toBe(400);
      expect(r?.field).toBe("settings.contactAuth.credentialRef");
    });
  });

  test("the MCP write refuses it too, through the same boundary", async () => {
    const r = await agentUpdate(
      principal(),
      {
        agent_id: String(agentId),
        model_config: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: oauthRef,
        },
        dry_run: false,
      } as never,
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).toContain("modelConfig.credentialRef");
  });

  // The tenant's embedding key is the one credential outside the agent that this covers, and the
  // reason is written down in rag/documents.ts: without a kind test, an operator who picks the
  // Chatwoot credential here gets every chunk of their knowledge base POSTed at the Chatwoot host.
  test("the tenant's embedding credential is held to the same rule", async () => {
    const bad = await refused(() =>
      updateEmbeddingSettings(ctx(), { credentialRef: oauthRef }, appDb),
    );
    expect(bad?.status).toBe(400);
    expect(bad?.field).toBe("embedding.credentialRef");
    const good = await refused(() =>
      updateEmbeddingSettings(ctx(), { credentialRef: keyRef }, appDb),
    );
    expect(good).toBeNull();

    // ...and the one place the VALUE rule does NOT apply. `resolveEmbeddingStatus` reads
    // `{ apiKey, baseURL }` as well as a plain string, a second form the catalog does not declare,
    // so holding this field's value to its kind would refuse a shape that reader has always taken.
    // The KIND rule still applies to it, which is what the first half of this test proves.
    const envelope = await refused(() =>
      updateEmbeddingSettings(ctx(), { credentialRef: malformedRef }, appDb),
    );
    expect(envelope).toBeNull();
  });

  // An import is the one way a bad pairing can still be CREATED, because the payload is authored
  // elsewhere and the (name, kind) lookup will happily match a google_oauth entry on the model. It is
  // warned rather than refused (a whole bundle must not fail over one field) and the ref stays wired,
  // so the operator can see which credential the author meant.
  test("an import warns instead of refusing, and leaves the ref wired", async () => {
    const result = await importAgent(
      ctx(),
      {
        kind: AGENT_EXPORT_KIND,
        version: AGENT_EXPORT_VERSION,
        agent: {
          name: `Imported ${process.pid}`,
          systemPrompt: "x",
          transferWithSummary: false,
          modelConfig: {
            provider: "openai",
            model: "gpt-4o-mini",
            credentialRef: "google-conn",
          },
          settings: {},
          businessHours: null,
          followUpHours: null,
          tools: [],
          credentials: [{ name: "google-conn", kind: "google_oauth" }],
        },
      },
      appDb,
    );
    const warn = result.warnings.find(
      (w) => w.code === "credentialKindUnusable",
    );
    expect(warn).toBeDefined();
    expect(warn?.params?.field).toBe("modelConfig.credentialRef");
    expect(warn?.params?.kind).toBe("google_oauth");
    // Wired, not unset: the entry exists, unlike the `credentialNotFound` case that drops the ref.
    const row = await suDb.agent.findFirst({
      where: { tenantId, name: `Imported ${process.pid}` },
      select: { modelConfig: true },
    });
    expect(
      (row?.modelConfig as { credentialRef?: string } | null)?.credentialRef,
    ).toBe(oauthRef);
  });

  // The resolver every API-key field now goes through, and both halves of its check. They look
  // redundant and are not: the KIND is what the catalog declares, the VALUE is what is actually
  // stored, and each catches a case the other lets through.
  describe("the runtime resolver", () => {
    const resolve = (ref: string) =>
      runScopedOn(appDb, ctx(), (db) => tryResolveApiKeyEntry(db, ref));

    test("a usable kind with a string secret resolves", async () => {
      expect(await resolve(keyRef)).toEqual({
        state: "ok",
        secret: "sk-live",
        baseUrl: null,
      });
    });

    test("a multi-field kind is unusable, not merely unresolved", async () => {
      expect(await resolve(oauthRef)).toEqual({
        state: "unusable",
        kind: "google_oauth",
      });
    });

    // The case only the KIND check catches: `mcp_env` holds a perfectly good string, so a bare
    // `typeof x === "string"` would hand the operator's stdio token to a model vendor.
    test("a never-outbound kind is unusable even though it holds a string", async () => {
      expect(await resolve(envRef)).toEqual({
        state: "unusable",
        kind: "mcp_env",
      });
    });

    // The case only the VALUE check catches: the catalog says `generic` is a plain string, and this
    // row is not one. Reachable for an entry written before its kind existed, or by any path that
    // stores a value the kind does not describe.
    test("a kind that should hold a string, holding something else, is unusable", async () => {
      expect(await resolve(malformedRef)).toEqual({
        state: "unusable",
        kind: "generic",
      });
    });

    test("a ref the vault does not hold is unresolved", async () => {
      expect(await resolve("vault:99999999")).toEqual({ state: "unresolved" });
    });
  });

  test("config-health reports a stored MALFORMED value the same way", async () => {
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: malformedRef,
        },
      },
    });
    const h = await readAgentConfigHealth(ctx(), agentId, { base: appDb });
    expect(h.healthy).toBe(false);
    expect(h.issues.find((i) => i.key === "model")?.wrongKind).toBe(true);
  });

  test("config-health reports a STORED one instead of calling the agent healthy", async () => {
    // Written past the boundary on purpose: this is the state a write can no longer create and an
    // install can still be in (an import, or a row that predates the rule).
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: oauthRef,
        },
      },
    });
    const h = await readAgentConfigHealth(ctx(), agentId, { base: appDb });
    expect(h.healthy).toBe(false);
    const model = h.issues.find((i) => i.key === "model");
    expect(model).toBeDefined();
    expect(model?.wrongKind).toBe(true);
    // Not the other two verdicts: the entry exists and its secret IS filled. The fix is a different
    // credential, not filling this one in.
    expect(model?.pending).toBeUndefined();
    expect(model?.unresolved).toBeUndefined();
    expect(h.counts.blocking).toBeGreaterThan(0);
  });
});
