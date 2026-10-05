import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { generateApiKey } from "@/modules/api-keys/verify";
import type { LinkSearch } from "@/modules/conversations/chatwoot-link";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The route behind the link the Chatwoot fork puts on a conversation: an AGENT-role key (the lowest
// rank that reads conversations) gets its own tenant's conversation, a malformed id is a 400 and not
// a query, and no credential is a 401.

const BunRequest = (globalThis as unknown as { BunRequest: typeof Request })
  .BunRequest;

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

setupPrismaMock();

const verify = await import("@/modules/api-keys/verify");
const realVerify = { ...verify };
mock.module("@/modules/api-keys/verify", () => ({
  ...realVerify,
  verifyApiKey: (token: string) => realVerify.verifyApiKey(token, app),
}));

const link = await import("@/modules/conversations/chatwoot-link");
const realLink = { ...link };
mock.module("@/modules/conversations/chatwoot-link", () => ({
  ...realLink,
  resolveChatwootConversation: (
    who: LinkSearch,
    ref: Parameters<typeof realLink.resolveChatwootConversation>[1],
  ) => realLink.resolveChatwootConversation(who, ref, app),
}));

const server = (await import("@/app")).default;

afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/conversations/chatwoot-link", () => realLink);
});

const ACCOUNT = 90_000 + (process.pid % 9_000);
let tenantId = 0n;
let otherTenantId = 0n;
let convId = "";
let key = "";

function get(path: string, bearer?: string): Promise<Response> {
  return server.handle(
    new BunRequest(`http://localhost/api/v1${path}`, {
      method: "GET",
      headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
    }),
  );
}

describe.skipIf(!dbUp)("GET /v1/conversations/chatwoot-link", () => {
  beforeAll(async () => {
    const s = su as PrismaClient;
    for (const which of ["a", "b"] as const) {
      const t = await s.tenant.create({
        data: { name: `CWL ${which}`, slug: `cwl-${which}-${process.pid}` },
      });
      if (which === "a") tenantId = t.id;
      else otherTenantId = t.id;
      const inst = await seedChatwootInstance(s, {
        tenantId: t.id,
        accountId: ACCOUNT,
        baseUrl: `https://cwl-${which}.test.local`,
      });
      const conv = await s.conversation.create({
        data: {
          tenantId: t.id,
          chatwootInstanceId: inst.id,
          chatwootConversationId: 7,
          threadId: `${t.id}:${inst.id}:7`,
          status: "open",
        },
      });
      if (which === "a") convId = String(conv.id);
    }
    const { token, hash, prefix } = generateApiKey();
    await s.apiKey.create({
      data: {
        tenantId,
        displayName: "cwl-agent",
        keyHash: hash,
        keyPrefix: prefix,
        role: "AGENT",
        createdByUserId: 1n,
        stepUpAt: new Date(),
      },
    });
    key = token;
  });

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      if (id) await su?.tenant.delete({ where: { id } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("a key gets the conversation in its own tenant and nothing from the other", async () => {
    const res = await get(
      `/conversations/chatwoot-link?accountId=${ACCOUNT}&conversationId=7`,
      key,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { matches: unknown };
    expect(body.matches).toEqual([{ id: convId, tenantId: String(tenantId) }]);
  });

  test("a number nothing has answers an empty list", async () => {
    const res = await get(
      `/conversations/chatwoot-link?accountId=${ACCOUNT}&conversationId=8&inboxId=3`,
      key,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { matches: unknown }).matches).toEqual([]);
  });

  test("an id that is not a Chatwoot id is refused by name", async () => {
    for (const [param, value] of [
      ["conversationId", "abc"],
      ["conversationId", "0"],
      ["conversationId", "2147483648"],
      ["accountId", "-1"],
      ["inboxId", "1e3"],
      ["bot", "not-a-hash"],
      ["bot", "A".repeat(64)],
    ] as const) {
      const q = new URLSearchParams({
        accountId: String(ACCOUNT),
        conversationId: "7",
        [param]: value,
      });
      const res = await get(`/conversations/chatwoot-link?${q}`, key);
      expect([param, res.status]).toEqual([param, 400]);
    }
  });

  test("without credentials it is refused", async () => {
    const res = await get(
      `/conversations/chatwoot-link?accountId=${ACCOUNT}&conversationId=7`,
    );
    expect(res.status).toBe(401);
  });
});
