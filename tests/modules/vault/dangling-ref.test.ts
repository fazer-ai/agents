import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { computeConfigIssues } from "@/client/lib/configHealth";
import { formatVaultRef } from "@/client/lib/credentialRef";
import type { TenantContext } from "@/lib/tenancy";
import {
  deleteVaultEntry,
  listVaultEntryInfos,
  vaultReferences,
} from "@/modules/vault/service";

// An agent holding a ref to a vault entry that no longer exists, produced the way the product
// produces it: the operator deletes the key. Nothing blocks that delete and nothing rewrites the
// agents that named the key, so the ref survives its target. This walks the whole chain in one test,
// because each half on its own proves the wrong thing — that the state is reachable says nothing
// about what the editor does with it, and a hand-written "gone" ref in a unit test proves the
// product can produce one only by assertion.

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
let keyId = 0n;
let keptId = 0n;
// The client helper, fed the serialized id exactly as the API hands it to the browser.
const ref = (id: bigint): string => formatVaultRef(String(id));
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

describe.skipIf(!dbUp)("a vault entry deleted out from under an agent", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "DANGLE", slug: `dangle-${process.pid}` },
    });
    tenantId = t.id;
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "openai-main", secret: encryptJson("sk-x") },
      select: { id: true },
    });
    keyId = key.id;
    const kept = await suDb.vaultEntry.create({
      data: { tenantId, name: "eleven", secret: encryptJson("sk-y") },
      select: { id: true },
    });
    keptId = kept.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "dangling",
        systemPrompt: "p",
        modelConfig: { provider: "openai", credentialRef: ref(keyId) },
        settings: {
          tts: { mode: "mirror", credentialRef: ref(keptId) },
        },
      },
      select: { id: true },
    });
    agentId = agent.id;
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

  test("the delete goes through even though an agent names the key", async () => {
    const before = await vaultReferences(ctx(), keyId, appDb);
    expect(before.agents.map((a) => a.name)).toEqual(["dangling"]);
    // The reference list is what the vault UI shows before deleting; it informs, it does not refuse.
    await deleteVaultEntry(ctx(), keyId, appDb);
    const rows = await listVaultEntryInfos(ctx(), appDb);
    expect(rows.map((r) => r.id)).toEqual([String(keptId)]);
  });

  test("the agent still carries the ref, now pointing at nothing", async () => {
    const row = await suDb.agent.findFirst({
      where: { id: agentId },
      select: { modelConfig: true },
    });
    const mc = row?.modelConfig as { credentialRef?: string };
    expect(mc.credentialRef).toBe(ref(keyId));
  });

  // The effect this issue is about: the panel that exists to say "this agent has something that will
  // not run" reads the vault list above, and that list is the only thing that can tell it the key is
  // gone. Same refs, same list the editor loads.
  test("the editor's health panel flags it from the vault list alone", async () => {
    const rows = await listVaultEntryInfos(ctx(), appDb);
    const issues = computeConfigIssues({
      agentEnabled: true,
      modelProvider: "openai",
      modelCredentialRef: ref(keyId),
      savedModelProvider: "openai",
      sttEnabled: false,
      sttCredentialRef: "",
      ttsMode: "mirror",
      ttsCredentialRef: ref(keptId),
      visionEnabled: false,
      visionCredentialRef: "",
      knownRefs: new Set(rows.map((r) => formatVaultRef(r.id))),
      pendingRefs: new Set(
        rows
          .filter((r) => r.status === "pending")
          .map((r) => formatVaultRef(r.id)),
      ),
    });
    expect(issues).toEqual([
      {
        key: "model",
        tab: "general",
        sectionId: "general-model",
        unresolved: true,
      },
    ]);
  });
});
