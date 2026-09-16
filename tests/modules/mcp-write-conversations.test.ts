import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  conversationHandoff,
  conversationStatus,
} from "@/modules/mcp/write-conversations";
import { seedChatwootInstance } from "../utils/chatwoot";

// Conversation-control write tools: gate is DB-free; dry-run previews + tenant fencing read the DB
// only (no Chatwoot). The apply paths post real messages / change state and are exercised live in
// Fase 8.

function principal(over: Partial<VerifiedToken>): VerifiedToken {
  return {
    userId: 1n,
    tenantId: 1n,
    role: "TENANT_ADMIN",
    scopes: ["mcp:read", "mcp:write"],
    clientId: "c",
    jti: "j",
    ...over,
  };
}

describe("MCP conversation-control gate (no DB)", () => {
  // A mesma afirmação de sempre, noutra tool: a #655 removeu conversation_reply, que era a única
  // cobertura deste portão neste arquivo.
  test("conversation_status without mcp:write → insufficient_scope", async () => {
    const r = await conversationStatus(principal({ scopes: ["mcp:read"] }), {
      conversation_id: "1",
      status: "open",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("insufficient_scope");
  });

  test("conversation_status invalid id → error", async () => {
    const r = await conversationStatus(principal({}), {
      conversation_id: "nope",
      status: "open",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("invalid conversation_id");
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

describe.skipIf(!dbUp)("MCP conversation-control tools (DB)", () => {
  let tenantA = 0n;
  let tenantB = 0n;
  let convA = 0n;

  beforeAll(async () => {
    const a = await suDb.tenant.create({
      data: { name: "CVA", slug: `cv-a-${process.pid}` },
    });
    tenantA = a.id;
    const b = await suDb.tenant.create({
      data: { name: "CVB", slug: `cv-b-${process.pid}` },
    });
    tenantB = b.id;
    const inst = await seedChatwootInstance(suDb, {
      tenantId: tenantA,
      accountId: 5,
      baseUrl: "https://chat.example.com",
      adminToken: encryptJson("t"),
    });
    const conv = await suDb.conversation.create({
      data: {
        tenantId: tenantA,
        chatwootInstanceId: inst.id,
        chatwootConversationId: 1234,
        status: "open",
        threadId: `${tenantA}:${inst.id}:1234`,
      },
      select: { id: true },
    });
    convA = conv.id;
  });

  afterAll(async () => {
    for (const tid of [tenantA, tenantB]) {
      if (!tid) continue;
      await suDb.$executeRawUnsafe(
        `DELETE FROM conversations WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(
        `DELETE FROM chatwoot_instances WHERE tenant_id = ${tid}`,
      );
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("conversation_status dry-run previews current → new", async () => {
    const r = await conversationStatus(
      principal({ tenantId: tenantA }),
      { conversation_id: String(convA), status: "resolved" },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.currentStatus).toBe("open");
      expect(r.data.newStatus).toBe("resolved");
    }
  });

  test("conversation_handoff dry-run previews the target", async () => {
    const r = await conversationHandoff(
      principal({ tenantId: tenantA }),
      { conversation_id: String(convA), assignee_id: 7 },
      { base: appDb },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.dryRun).toBe(true);
      expect(r.data.newAssigneeId).toBe(7);
    }
  });

  // Idem: a cerca entre tenants numa APLICAÇÃO de verdade (dry_run false) só era exercitada pelo
  // reply. `status` é a vizinha que também escreve no Chatwoot.
  test("conversation_status cross-tenant → not found", async () => {
    const r = await conversationStatus(
      principal({ tenantId: tenantB }),
      { conversation_id: String(convA), status: "resolved", dry_run: false },
      { base: appDb },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("not found");
  });
});
