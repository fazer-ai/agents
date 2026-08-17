import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
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

// One key per settings path that can hold one, so a path the query forgets shows up as an empty
// agent list for that key alone.
const PATHS = [
  ["stt", "credentialRef"],
  ["tts", "credentialRef"],
  ["tts", "normalizeCredentialRef"],
  ["vision", "credentialRef"],
] as const;

const keyIds: Record<string, bigint> = {};

describe.skipIf(!dbUp)("vaultReferences over agent settings", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "VREF", slug: `vref-${process.pid}` },
    });
    tenantId = t.id;
    for (const [block, field] of PATHS) {
      const name = `${block}-${field}`;
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
          settings: { [block]: { [field]: `vault:${entry.id}` } },
        },
      });
    }
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["agents", "vault_entries"]) {
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

  for (const [block, field] of PATHS) {
    const name = `${block}-${field}`;
    test(`a key used only as ${block}.${field} is reported as in use`, async () => {
      const refs = await vaultReferences(ctx(), keyIds[name] as bigint, appDb);
      expect(refs.agents.map((a) => a.name)).toEqual([`agent-${name}`]);
    });
  }
});
