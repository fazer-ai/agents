import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";
import { createAgent, updateAgent } from "@/modules/agents/service";
import {
  createAlertChannel,
  updateAlertChannel,
} from "@/modules/flowlog/channels";
import {
  createIntegrationInstance,
  updateIntegrationInstance,
} from "@/modules/integrations/service";
import {
  createMcpConnection,
  updateMcpConnection,
} from "@/modules/mcp-connections/service";
import {
  getTenantSettings,
  updateEmbeddingSettings,
  updateLangfuse,
} from "@/modules/tenant-settings/service";
import {
  createToolDefinition,
  updateToolDefinition,
} from "@/modules/tool-definitions/service";
import {
  createPendingVaultEntry,
  createVaultEntry,
  deleteVaultEntry,
} from "@/modules/vault/service";
import {
  createWebhookSubscription,
  updateWebhookSubscription,
} from "@/modules/webhooks/outbound/subscriptions";
import { outboundUrl } from "../../utils/outbound";

// The context these calls take: the tenant id came from a row this test created, so it carries
// TENANT_ADMIN — the role that tells `runScopedOn` the id never came from outside (issue #280).
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

// Every column that stores a `vault:<id>`, held to the same rule on the way in. A bare NAME was the
// value that got stored and could never resolve: `vaultRefWhere` turns it into a filter matching
// nothing, so the feature behaves as if nothing were configured — silently for five of these, and as
// an unexplained 401 for the inbound secret (issue #124).
//
// The table exists because the finding came in a family. One service fixed and five left alone would
// read as "these were checked", which is worse than nobody having checked at all.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

let seq = 0;
const uniq = (p: string) => `${p}-${process.pid}-${++seq}`;

interface Boundary {
  // What the operator sees in the API, so a failure names the field rather than the test row.
  field: string;
  // The name the REFUSAL puts on the wire (#231/#245), when this boundary names one. Absent for the
  // six columns of #124: the patch key the client sent already is the name, and extending #245's
  // sweep to them is its own change. Asserted in both directions so "these were checked" cannot be
  // read into a boundary that answers without one.
  wireField?: string;
  create: (ref: string) => Promise<bigint>;
  update: (id: bigint, ref: string) => Promise<unknown>;
  read: (id: bigint) => Promise<string | null>;
}

const boundaries: Boundary[] = [
  {
    field: "integrationInstance.inboundSecretRef",
    create: async (ref) =>
      (
        await createIntegrationInstance(
          ctxOf(tenantId),
          {
            catalogType: "ASAAS",
            name: uniq("inbound"),
            inboundAuthStrategy: "STATIC_HEADER",
            inboundSecretRef: ref,
          },
          appDb,
        )
      ).id,
    update: (id, ref) =>
      updateIntegrationInstance(ctx(), id, { inboundSecretRef: ref }, appDb),
    read: async (id) =>
      (
        await suDb.integrationInstance.findUnique({
          where: { id },
          select: { inboundSecretRef: true },
        })
      )?.inboundSecretRef ?? null,
  },
  {
    field: "integrationInstance.credentialRef",
    create: async (ref) =>
      (
        await createIntegrationInstance(
          ctxOf(tenantId),
          {
            catalogType: "ASAAS",
            name: uniq("outbound"),
            credentialRef: ref,
          },
          appDb,
        )
      ).id,
    update: (id, ref) =>
      updateIntegrationInstance(ctx(), id, { credentialRef: ref }, appDb),
    read: async (id) =>
      (
        await suDb.integrationInstance.findUnique({
          where: { id },
          select: { credentialRef: true },
        })
      )?.credentialRef ?? null,
  },
  {
    field: "toolDefinition.credentialRef",
    create: async (ref) => {
      const dto = await createToolDefinition(
        ctx(),
        {
          name: uniq("tool").replace(/-/g, "_"),
          label: "Tool",
          urlTemplate: "https://api.example.com/{{id}}",
          allowedHosts: ["api.example.com"],
          credentialRef: ref,
        },
        appDb,
      );
      return BigInt(dto.id);
    },
    update: (id, ref) =>
      updateToolDefinition(ctx(), id, { credentialRef: ref }, appDb),
    read: async (id) =>
      (
        await suDb.toolDefinition.findUnique({
          where: { id },
          select: { credentialRef: true },
        })
      )?.credentialRef ?? null,
  },
  {
    field: "mcpServerConnection.credentialRef",
    create: async (ref) => {
      const dto = await createMcpConnection(
        ctx(),
        {
          name: uniq("mcp"),
          transport: "streamableHttp",
          url: outboundUrl("/mcp"),
          credentialRef: ref,
        },
        appDb,
      );
      return BigInt(dto.id);
    },
    update: (id, ref) =>
      updateMcpConnection(ctx(), id, { credentialRef: ref }, appDb),
    read: async (id) =>
      (
        await suDb.mcpServerConnection.findUnique({
          where: { id },
          select: { credentialRef: true },
        })
      )?.credentialRef ?? null,
  },
  {
    field: "alertChannel.secretRef",
    create: async (ref) => {
      const dto = await createAlertChannel(
        ctx(),
        {
          name: uniq("alert"),
          type: "webhook",
          url: outboundUrl("/alert"),
          secretRef: ref,
        },
        appDb,
      );
      return BigInt(dto.id);
    },
    update: (id, ref) =>
      updateAlertChannel(ctx(), id, { secretRef: ref }, appDb),
    read: async (id) =>
      (
        await suDb.alertChannel.findUnique({
          where: { id },
          select: { secretRef: true },
        })
      )?.secretRef ?? null,
  },
  {
    field: "webhookSubscription.secretRef",
    create: async (ref) => {
      const dto = await createWebhookSubscription(
        ctx(),
        {
          url: outboundUrl(`/hook/${uniq("s")}`),
          events: ["heartbeat"],
          secretRef: ref,
        },
        appDb,
      );
      return BigInt(dto.id);
    },
    update: (id, ref) =>
      updateWebhookSubscription(ctx(), id, { secretRef: ref }, appDb),
    read: async (id) =>
      (
        await suDb.webhookSubscription.findUnique({
          where: { id },
          select: { secretRef: true },
        })
      )?.secretRef ?? null,
  },
];

// The agent keeps its refs inside two JSON bags rather than in columns of their own, which is how
// they escaped the sweep the first time: there is no `credential_ref` column to grep for. The bags
// are still a write boundary, and the same rule applies to them (issue #254).
const MODEL_BASE = { provider: "openai", model: "gpt-4o-mini" };

// A settings bag holding exactly one credential ref, at `path` — the shape a save of that one
// section sends. Built from the path so a credential added to a NEW block is covered here the moment
// it joins SETTINGS_CREDENTIAL_PATHS, rather than waiting for someone to remember this file.
function settingsWithRef(
  path: readonly string[],
  ref: string,
): Record<string, unknown> {
  let node: Record<string, unknown> = {
    [path[path.length - 1] as string]: ref,
  };
  for (let i = path.length - 2; i >= 0; i--) {
    node = { [path[i] as string]: node };
  }
  return node;
}

function readStoredRef(bag: unknown, path: readonly string[]): string | null {
  let node: unknown = bag;
  for (const step of path) {
    if (!node || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[step];
  }
  return typeof node === "string" ? node : null;
}

const agentBoundaries: Boundary[] = [
  {
    field: "agent.modelConfig.credentialRef",
    wireField: "modelConfig.credentialRef",
    create: async (ref) =>
      BigInt(
        (
          await createAgent(
            ctx(),
            {
              name: uniq("agent"),
              modelConfig: { ...MODEL_BASE, credentialRef: ref },
            },
            appDb,
          )
        ).id,
      ),
    update: (id, ref) =>
      updateAgent(
        ctx(),
        id,
        { modelConfig: { ...MODEL_BASE, credentialRef: ref } },
        appDb,
      ),
    read: async (id) =>
      readStoredRef(
        (
          await suDb.agent.findUnique({
            where: { id },
            select: { modelConfig: true },
          })
        )?.modelConfig,
        ["credentialRef"],
      ),
  },
  ...SETTINGS_CREDENTIAL_PATHS.map(({ path }) => ({
    field: `agent.settings.${path.join(".")}`,
    wireField: `settings.${path.join(".")}`,
    create: async (ref: string) =>
      BigInt(
        (
          await createAgent(
            ctx(),
            { name: uniq("agent"), settings: settingsWithRef(path, ref) },
            appDb,
          )
        ).id,
      ),
    update: (id: bigint, ref: string) =>
      updateAgent(ctx(), id, { settings: settingsWithRef(path, ref) }, appDb),
    read: async (id: bigint) =>
      readStoredRef(
        (
          await suDb.agent.findUnique({
            where: { id },
            select: { settings: true },
          })
        )?.settings,
        path,
      ),
  })),
];

describe.skipIf(!dbUp)("vault ref write boundary", () => {
  let liveRef = "";
  let liveId = 0n;
  let pendingRef = "";
  let goneRef = "";
  let lfRef = "";
  let lfId = 0n;
  let lfPendingRef = "";

  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "REFW", slug: `refw-${process.pid}` },
    });
    tenantId = t.id;
    const live = await createVaultEntry(
      ctx(),
      { name: "live-key", value: "SECRET" },
      undefined,
      undefined,
      appDb,
    );
    liveRef = live.ref;
    liveId = live.id;
    const unfilled = await createPendingVaultEntry(
      ctx(),
      { name: "unfilled-key" },
      appDb,
    );
    pendingRef = unfilled.ref;
    // A ref whose entry existed and then did not: the shape a delete leaves behind.
    const doomed = await createVaultEntry(
      ctx(),
      { name: "doomed-key", value: "GONE" },
      undefined,
      undefined,
      appDb,
    );
    goneRef = doomed.ref;
    await deleteVaultEntry(ctx(), doomed.id, appDb);
    const lf = await createVaultEntry(
      ctx(),
      {
        name: "lf-key",
        value: { publicKey: "pk", secretKey: "sk" },
        kind: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
      },
      undefined,
      undefined,
      appDb,
    );
    lfRef = lf.ref;
    lfId = lf.id;
    const lfUnfilled = await createPendingVaultEntry(
      ctx(),
      {
        name: "lf-unfilled",
        kind: "langfuse",
        baseUrl: "https://cloud.langfuse.com",
      },
      appDb,
    );
    lfPendingRef = lfUnfilled.ref;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "agents",
        "webhook_subscriptions",
        "alert_channels",
        "mcp_server_connections",
        "tool_definitions",
        "integration_instances",
        "scheduler_jobs",
        "vault_entries",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  // The agent is the one boundary whose write carries fields it is not about. Its editor saves the
  // whole bag, and eight credential fields sit across three tabs — so "is this ref valid" is the
  // wrong question and "does this write change it" is the right one. Without that, one deleted vault
  // entry would freeze every agent that named it: no model change, no rename, not even the switch
  // that turns the agent off.
  describe("what an agent write leaves alone", () => {
    // Seeded past the boundary on purpose: this is the state a row is ALREADY in, whether it was
    // written before the check existed or its vault entry was deleted afterwards.
    async function agentHoldingDeadRefs(): Promise<bigint> {
      const row = await suDb.agent.create({
        data: {
          tenantId,
          name: uniq("legacy"),
          systemPrompt: "x",
          modelConfig: { ...MODEL_BASE, credentialRef: "OpenAI Prod" },
          settings: {
            stt: { enabled: true, credentialRef: goneRef },
            guardrails: { credentialRef: "another name" },
          },
        },
      });
      return row.id;
    }

    test("an unrelated field still saves with dead refs sitting in the row", async () => {
      const id = await agentHoldingDeadRefs();
      // The urgent one: switching the agent OFF must never depend on a credential.
      const dto = await updateAgent(ctx(), id, { enabled: false }, appDb);
      expect(dto.enabled).toBe(false);
    });

    test("re-sending the stored refs untouched is not a write of them", async () => {
      const id = await agentHoldingDeadRefs();
      // What the editor actually posts: the whole bag it loaded, with one field edited.
      const dto = await updateAgent(
        ctx(),
        id,
        {
          name: "Renamed",
          modelConfig: { ...MODEL_BASE, credentialRef: "OpenAI Prod" },
          settings: {
            stt: { enabled: false, credentialRef: goneRef },
            guardrails: { credentialRef: "another name" },
          },
        },
        appDb,
      );
      expect(dto.name).toBe("Renamed");
      const row = await suDb.agent.findUniqueOrThrow({
        where: { id },
        select: { settings: true },
      });
      expect(readStoredRef(row.settings, ["stt", "credentialRef"])).toBe(
        goneRef,
      );
    });

    test("but touching one of them, in that same save, is refused by name", async () => {
      const id = await agentHoldingDeadRefs();
      await expect(
        updateAgent(
          ctx(),
          id,
          {
            name: "Renamed",
            settings: {
              stt: { enabled: true, credentialRef: goneRef },
              guardrails: { credentialRef: "a third name" },
            },
          },
          appDb,
        ),
      ).rejects.toMatchObject({
        statusCode: 400,
        translationKey: "errors.invalidVaultRef",
      });
      // And the refusal wrote nothing: the rename did not land either.
      const row = await suDb.agent.findUniqueOrThrow({
        where: { id },
        select: { name: true },
      });
      expect(row.name).not.toBe("Renamed");
    });

    test("a stale editor gets 409, not 400, when the other writer changed a ref", async () => {
      // The precondition is answered on the locked row BEFORE this check, for the same reason the
      // text caps are: a stale editor resends what it loaded, so the other writer's ref reads as an
      // edit of ours. Answering 400 here would skip the editor's conflict flow entirely.
      const id = await agentHoldingDeadRefs();
      await expect(
        updateAgent(
          ctx(),
          id,
          { modelConfig: { ...MODEL_BASE, credentialRef: "some other name" } },
          appDb,
          { expectedUpdatedAt: new Date(0) },
        ),
      ).rejects.toMatchObject({
        statusCode: 409,
        translationKey: "errors.agentModifiedElsewhere",
      });
    });
  });

  // The tenant's two credential blocks. Neither is a column and neither was in the #124 sweep;
  // embedding had no check at all, and langfuse had one that answered "not found" for two values
  // that are something else.
  describe("tenant settings credential blocks", () => {
    test("embedding refuses a bare NAME, and stores a live ref canonically", async () => {
      await expect(
        updateEmbeddingSettings(ctx(), { credentialRef: "live-key" }, appDb),
      ).rejects.toMatchObject({
        statusCode: 400,
        translationKey: "errors.invalidVaultRef",
        field: "embedding.credentialRef",
      });
      await expect(
        updateEmbeddingSettings(ctx(), { credentialRef: goneRef }, appDb),
      ).rejects.toMatchObject({
        statusCode: 400,
        translationKey: "errors.vaultRefNotFound",
        field: "embedding.credentialRef",
      });
      await updateEmbeddingSettings(
        ctx(),
        { credentialRef: `vault:00${liveId}` },
        appDb,
      );
      expect(
        (await getTenantSettings(ctx(), appDb)).embedding.credentialRef,
      ).toBe(liveRef);
      // null still clears it, without asking the vault about anything.
      await updateEmbeddingSettings(ctx(), { credentialRef: null }, appDb);
      expect(
        (await getTenantSettings(ctx(), appDb)).embedding.credentialRef,
      ).toBe(null);
    });

    test("langfuse refuses a bare NAME and keeps refusing the wrong kind", async () => {
      await expect(
        updateLangfuse(ctx(), { credentialRef: "lf-key" }, appDb),
      ).rejects.toMatchObject({
        statusCode: 400,
        translationKey: "errors.invalidVaultRef",
        field: "langfuse.credentialRef",
      });
      await expect(
        updateLangfuse(ctx(), { credentialRef: liveRef }, appDb),
      ).rejects.toMatchObject({
        statusCode: 400,
        translationKey: "errors.invalidCredentialKind",
        field: "langfuse.credentialRef",
      });
    });

    test("langfuse stores the canonical spelling, and admits an unfilled entry", async () => {
      // `vault:007` resolved and was stored verbatim, which is exactly what makes the credential
      // picker call a working credential unavailable; and an entry created empty on purpose was
      // refused as "not found", which is a different fact with the same words.
      await updateLangfuse(ctx(), { credentialRef: `vault:00${lfId}` }, appDb);
      expect(
        (await getTenantSettings(ctx(), appDb)).langfuse.credentialRef,
      ).toBe(lfRef);
      await updateLangfuse(ctx(), { credentialRef: lfPendingRef }, appDb);
      expect(
        (await getTenantSettings(ctx(), appDb)).langfuse.credentialRef,
      ).toBe(lfPendingRef);
    });
  });

  for (const b of [...boundaries, ...agentBoundaries]) {
    describe(b.field, () => {
      test("refuses a bare vault entry NAME on create", async () => {
        await expect(b.create("live-key")).rejects.toMatchObject({
          statusCode: 400,
          translationKey: "errors.invalidVaultRef",
        });
      });

      test("refuses a bare id with the vault: prefix stripped off", async () => {
        // Not decoration: without the prefix check, `BigInt("7")` parses and the column silently
        // accepts a spelling no reader in the system produces or resolves.
        await expect(b.create(String(liveId))).rejects.toMatchObject({
          statusCode: 400,
          translationKey: "errors.invalidVaultRef",
        });
      });

      test("refuses an id no bigint column could hold, without asking the database", async () => {
        // BigInt is arbitrary precision, so parsing succeeds and the oversized value reaches a
        // bigint column, where Postgres refuses it: a 500 for what is plainly a malformed field.
        // Pinned at the EXACT edge (2^63, one past what int8 holds) rather than at some absurd
        // number, because only the edge says where the bound is: a bound set anywhere below the
        // absurd value passes that test just as well.
        await expect(
          b.create("vault:9223372036854775808"),
        ).rejects.toMatchObject({
          statusCode: 400,
          translationKey: "errors.invalidVaultRef",
        });
        // And the largest id a column CAN hold is not malformed, it is merely absent.
        await expect(
          b.create("vault:9223372036854775807"),
        ).rejects.toMatchObject({
          statusCode: 400,
          translationKey: "errors.vaultRefNotFound",
        });
      });

      test("refuses a spelling BigInt would accept but no writer produces", async () => {
        // `0x7` and ` 7 ` parse to the same id as `7`. Readers tolerate that on purpose (see
        // canonicalVaultRef); a column takes one spelling, and refusing the rest here is what makes
        // "stored canonically" a fact rather than a hope.
        for (const ref of [
          `vault:0x${liveId.toString(16)}`,
          `vault: ${liveId} `,
        ]) {
          await expect(b.create(ref)).rejects.toMatchObject({
            statusCode: 400,
            translationKey: "errors.invalidVaultRef",
          });
        }
      });

      test("refuses a well-formed ref whose entry is gone, on create", async () => {
        await expect(b.create(goneRef)).rejects.toMatchObject({
          statusCode: 400,
          translationKey: "errors.vaultRefNotFound",
        });
      });

      test("stores a live ref, and stores it canonically", async () => {
        const id = await b.create(liveRef);
        expect(await b.read(id)).toBe(liveRef);

        // `vault:007` resolves server-side (BigInt tolerates padding) but compares unequal against a
        // list built from ids, so the picker calls a working credential unavailable. Canonicalizing
        // on the way in is what stops that from ever being stored.
        const padded = `vault:00${liveId}`;
        const paddedId = await b.create(padded);
        expect(await b.read(paddedId)).toBe(liveRef);
      });

      test("accepts a reference whose secret is not filled yet", async () => {
        // Deliberate: wiring config to a credential created empty is the whole point of
        // credential_create. The picker is where "fill it" gets said.
        const id = await b.create(pendingRef);
        expect(await b.read(id)).toBe(pendingRef);
      });

      test("says which field it refused, or says nothing at all", async () => {
        // The refusal is the only thing the console can key on: the sentence is localized and the
        // agent keeps eight of these across three tabs, so without a name there is nothing to put
        // the message next to. Both directions, so an entry that quietly stops naming one fails.
        const raised = await b.create("live-key").catch((e: unknown) => e);
        expect((raised as { field?: string }).field).toBe(
          b.wireField as string,
        );
      });

      test("refuses a bare NAME and a dead ref on update too", async () => {
        const id = await b.create(liveRef);
        await expect(b.update(id, "live-key")).rejects.toMatchObject({
          statusCode: 400,
          translationKey: "errors.invalidVaultRef",
        });
        await expect(b.update(id, goneRef)).rejects.toMatchObject({
          statusCode: 400,
          translationKey: "errors.vaultRefNotFound",
        });
        // The refusal left the stored value alone.
        expect(await b.read(id)).toBe(liveRef);
      });
    });
  }
});
