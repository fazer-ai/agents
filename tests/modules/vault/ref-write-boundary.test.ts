import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
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
          tenantId,
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
          tenantId,
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

describe.skipIf(!dbUp)("vault ref write boundary", () => {
  let liveRef = "";
  let liveId = 0n;
  let pendingRef = "";
  let goneRef = "";

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
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
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

  for (const b of boundaries) {
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
