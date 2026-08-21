import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { SETTINGS_CREDENTIAL_PATHS } from "@/modules/agents/credential-paths";
import { vaultReferences } from "@/modules/vault/service";

// The reverse index behind "is this key still in use?", which the vault UI and the MCP both read
// before offering to delete an entry. A settings path missing from that query reads as UNUSED, so the
// operator deletes a key the runtime needs and the feature goes quiet: for the speech rewrite it
// would skip every call with `credential_not_found`, with the audio still going out unrewritten.

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

// One key per settings path that can hold one, over the SAME list the query is built from, so a
// path the list knows and the query forgets shows up as an empty agent list for that key alone.
const PATHS = SETTINGS_CREDENTIAL_PATHS;

// A settings bag holding `value` at `path`. The bag is built by WALKING the path, because a
// credential is not always a direct child of its block: `memory.compaction.credentialRef` is two
// levels down, and a bag built as `{ [block]: { [field]: value } }` would put the leaf key at the
// top and let the query pass while finding nothing.
function nest(path: readonly string[], value: string): Prisma.InputJsonObject {
  return path.reduceRight<Prisma.InputJsonValue>(
    (acc, step) => ({ [step]: acc }),
    value,
  ) as Prisma.InputJsonObject;
}

const keyIds: Record<string, bigint> = {};

let alertKeyId = 0n;

describe.skipIf(!dbUp)("vaultReferences", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "VREF", slug: `vref-${process.pid}` },
    });
    tenantId = t.id;
    for (const { path } of PATHS) {
      const name = path.join("-");
      const entry = await suDb.vaultEntry.create({
        data: { tenantId, name, secret: encryptJson("sk-x") },
        select: { id: true },
      });
      keyIds[name] = entry.id;
      await suDb.agent.create({
        data: {
          tenantId,
          name: `agent-${name}`,
          systemPrompt: "p",
          modelConfig: {},
          settings: nest(path, `vault:${entry.id}`),
        },
      });
    }
    // An alert channel signs its deliveries with a vault secret like everything else, and it was the
    // one referencing table this query never looked at.
    const alertKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "alert-hmac", secret: encryptJson("sk-a") },
      select: { id: true },
    });
    alertKeyId = alertKey.id;
    await suDb.alertChannel.create({
      data: {
        tenantId,
        name: "ops-webhook",
        type: "webhook",
        url: encryptJson("https://203.0.113.10/alert"),
        secretRef: `vault:${alertKey.id}`,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["agents", "alert_channels", "vault_entries"]) {
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

  for (const { path } of PATHS) {
    const name = path.join("-");
    test(`a key used only as ${path.join(".")} is reported as in use`, async () => {
      const refs = await vaultReferences(ctx(), keyIds[name] as bigint, appDb);
      expect(refs.agents.map((a) => a.name)).toEqual([`agent-${name}`]);
    });
  }

  test("a key used only by an alert channel is reported as in use", async () => {
    const refs = await vaultReferences(ctx(), alertKeyId, appDb);
    expect(refs.alertChannels).toEqual(["ops-webhook"]);
    // Named by its own bucket, not swept into a neighbour's.
    expect(refs.webhooks).toEqual([]);
    expect(refs.integrations).toEqual([]);
  });
});
