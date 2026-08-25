import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { transcribePlaygroundAudio } from "@/modules/stt/service";
import { extractPlaygroundFile } from "@/modules/vision/service";

// P8: the playground respects each capability's `enabled` toggle. The check runs before any DB
// access, so a disabled feature reads as "not configured" without a database.
describe("playground respects the enabled toggle", () => {
  test("vision disabled → not configured (no DB)", async () => {
    await expect(
      extractPlaygroundFile({
        ctx: { tenantId: 1n, userId: null, role: "TENANT_ADMIN" },
        agentId: 1n,
        file: new ArrayBuffer(4),
        mimeType: "image/png",
        settings: {
          vision: {
            enabled: false,
            provider: "openai",
            credentialRef: "vault:1",
          },
        },
      }),
    ).rejects.toThrow("not configured");
  });

  test("stt disabled → not configured (no DB)", async () => {
    await expect(
      transcribePlaygroundAudio({
        ctx: { tenantId: 1n, userId: null, role: "TENANT_ADMIN" },
        agentId: 1n,
        audio: new ArrayBuffer(4),
        mimeType: "audio/webm",
        settings: {
          stt: { enabled: false, provider: "openai", credentialRef: "vault:1" },
        },
      }),
    ).rejects.toThrow("not configured");
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
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let vaultRef = "";

// P9: a provider error must NOT interrupt the turn — it degrades to the "unsupported" marker (and is
// logged at error-level). Needs a real vault entry (the credential is resolved before the provider
// call), so it is DB-gated like the other integration tests.
describe.skipIf(!dbUp)(
  "playground extraction degrades on provider error",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "PC", slug: `pc-${process.pid}` },
      });
      tenantId = t.id;
      const vault = await suDb.vaultEntry.create({
        data: { tenantId, name: "k", secret: encryptJson("sk") },
        select: { id: true },
      });
      vaultRef = `vault:${vault.id}`;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of ["vault_entries", "tenants"]) {
          await suDb.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE ${table === "tenants" ? "id" : "tenant_id"} = ${tenantId}`,
          );
        }
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("a provider fetch failure → unsupported marker, not a throw", async () => {
      const res = await extractPlaygroundFile({
        ctx: { tenantId, userId: null, role: "TENANT_ADMIN" },
        agentId: 1n,
        file: new ArrayBuffer(8),
        mimeType: "image/png",
        settings: {
          vision: {
            enabled: true,
            provider: "openai",
            model: "gpt-4o",
            credentialRef: vaultRef,
          },
        },
        base: appDb,
        deps: {
          fetchImpl: (async () => {
            throw new Error("boom");
          }) as unknown as typeof fetch,
        },
      });
      expect(res.kind).toBe("unsupported");
      expect(res.text).toBe("");
    });
  },
);
