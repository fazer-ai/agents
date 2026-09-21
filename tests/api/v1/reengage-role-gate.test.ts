import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import config from "@/config";
import type { TenantContext } from "@/lib/tenancy";
import { generateApiKey } from "@/modules/api-keys/verify";
import { seedChatwootInstance } from "@/tests/utils/chatwoot";
import { mockFindUnique, setupPrismaMock } from "@/tests/utils/prisma-mock";

// WHO MAY MAKE THE AGENT SPEAK TO A CUSTOMER (issue #753).
//
// `POST /v1/conversations/:id/reengage` carried `requireAuth: true` and nothing finer, so authority
// stopped being a question at the door: any authenticated principal of the tenant reached the write
// service. The issue was found as an UNDECIDED holdout scenario of #750 and its body says nothing in
// the product can present a rank below `TENANT_ADMIN` — true of the API key, whose role is fixed at
// mint, and FALSE of the session: `PATCH /api/admin/users/:id` and `POST /api/admin/invitations`
// both take `role: "AGENT"`, `accept-invite` returns the cookie, and `/conversations/:id` is the one
// console route that is deliberately not admin-gated (`docs/ui.md`). So the door is open today.
//
// TWO DOORS, because they resolve the rank by different paths and a guard can cover one of them: the
// session, whose role is read from the USER ROW (a cookie signed `AGENT` against a row that says
// `TENANT_ADMIN` is admitted — an assertion made that way proves nothing), and the Bearer API key,
// whose role is a column. Both are of rank AGENT here and both have to answer alike.
//
// AND THE CONTROL IS PART OF THE MEASUREMENT. A refusal proves nothing about authority unless the
// same call, on the same conversation, in the same harness, gets further for a principal that is
// admitted — otherwise the environment is what refused. That was the whole defect of #750's s7: a
// 500 from DNS that did not separate from the guard.

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

const reengage = await import("@/modules/conversations/reengage");
const conversations = await import("@/modules/conversations/service");
// COPIES taken before the mocks are installed: Bun updates the imported namespace in place, so a
// wrapper that called the module by name would call itself.
const realReengage = { ...reengage };
const realConversations = { ...conversations };

// WHAT REACHED THE SERVICE, counted rather than exercised: running the real re-engagement means a
// model turn, and the question here is the transport's. `tests/modules/reengage*.test.ts` is where
// the behaviour behind this door is measured.
const reached: string[] = [];
const readReached = () => reached;

mock.module("@/modules/conversations/reengage", () => ({
  ...realReengage,
  reengageConversation: mock(async (_ctx: TenantContext) => {
    reached.push("reengage");
    return { outcome: "empty" as const };
  }),
}));
mock.module("@/modules/conversations/service", () => ({
  ...realConversations,
  handoffConversation: mock(async () => {
    reached.push("handoff");
  }),
  returnConversationToAgent: mock(async () => {
    reached.push("return");
    return "unassigned" as const;
  }),
  setConversationStatus: mock(async () => {
    reached.push("status");
  }),
}));

const server = (await import("@/app")).default;

// TOP-LEVEL, outside the describe: an `afterAll` inside a `describe.skipIf(...)` that skips does NOT
// run, while this one does, and the wrappers are already installed for the whole worker.
afterAll(() => {
  mock.module("@/modules/api-keys/verify", () => realVerify);
  mock.module("@/modules/conversations/reengage", () => realReengage);
  mock.module("@/modules/conversations/service", () => realConversations);
});

const USER_ID = 9753n;
let tenantId = 0n;
let instanceId = 0n;
let otherTenantId = 0n;
let convDbId = 0n;
let foreignConvDbId = 0n;
// The session's rank is resolved from the ROW, so this is the value the guard actually reads.
let role: "SUPER_ADMIN" | "TENANT_ADMIN" | "AGENT" = "TENANT_ADMIN";
let agentKey = "";
let adminKey = "";

async function sign(
  signedRole: "SUPER_ADMIN" | "TENANT_ADMIN" | "AGENT",
): Promise<string> {
  const token = await new SignJWT({
    userId: USER_ID.toString(),
    email: "op@example.com",
    role: signedRole,
    tenantId: tenantId.toString(),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(config.jwtSecret));
  return `fazerai_auth_token=${token}`;
}

function call(
  path: string,
  auth: { cookie: string } | { bearer: string },
  body?: Record<string, unknown>,
): Promise<Response> {
  return server.handle(
    new BunRequest(`http://localhost/api/v1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...("cookie" in auth
          ? { cookie: auth.cookie }
          : { authorization: `Bearer ${auth.bearer}` }),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

async function mintKey(
  keyRole: "TENANT_ADMIN" | "AGENT",
  name: string,
): Promise<string> {
  const { token, hash, prefix } = generateApiKey();
  // Inserted directly, and that is the point: `createApiKey` fixes the role at `TENANT_ADMIN`
  // (`FIXED_ROLE`, "fine-grained scopes deferred" beside it), so the rank the issue is about cannot
  // be minted through the service. The row shape is legal — `api_keys_role_tenant_check` only
  // forbids a SUPER_ADMIN carrying a tenant and a non-SUPER_ADMIN without one.
  await su?.apiKey.create({
    data: {
      tenantId,
      displayName: name,
      keyHash: hash,
      keyPrefix: prefix,
      role: keyRole,
      // REQUIRED, and `verifyApiKey` says why: a row without a recorded creator is malformed and
      // resolves to null, so a key minted without it answers 401 and the test would call that a
      // guard. There is no FK on the column, so the mocked user row is enough.
      createdByUserId: USER_ID,
      stepUpAt: new Date(),
    },
  });
  return token;
}

describe.skipIf(!dbUp)(
  "the re-engage door asks for authority, not just a session",
  () => {
    beforeAll(async () => {
      if (!su || !app) return;
      const t = await su.tenant.create({
        data: { name: "REENGGATE", slug: `reenggate-${process.pid}` },
      });
      tenantId = t.id;
      const other = await su.tenant.create({
        data: { name: "REENGOTHER", slug: `reengother-${process.pid}` },
      });
      otherTenantId = other.id;
      const inst = await seedChatwootInstance(su, {
        tenantId,
        accountId: 5,
        baseUrl: "https://203.0.113.9",
        adminToken: encryptJson("ADMIN"),
      });
      instanceId = inst.id;
      const inbox = await su.inbox.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootInboxId: 7,
          name: "Suporte",
        },
      });
      const conv = await su.conversation.create({
        data: {
          tenantId,
          chatwootInstanceId: instanceId,
          chatwootConversationId: 7531,
          inboxId: inbox.id,
          status: "pending",
          threadId: `${tenantId}:${instanceId}:7531`,
          lastEventAt: new Date(),
        },
      });
      convDbId = conv.id;
      const otherInst = await seedChatwootInstance(su, {
        tenantId: otherTenantId,
        accountId: 6,
        baseUrl: "https://203.0.113.10",
        adminToken: encryptJson("ADMIN"),
      });
      const foreign = await su.conversation.create({
        data: {
          tenantId: otherTenantId,
          chatwootInstanceId: otherInst.id,
          chatwootConversationId: 7532,
          status: "pending",
          threadId: `${otherTenantId}:${otherInst.id}:7532`,
          lastEventAt: new Date(),
        },
      });
      foreignConvDbId = foreign.id;
      mockFindUnique.mockImplementation(() =>
        Promise.resolve({
          id: USER_ID,
          tenantId,
          email: "op@example.com",
          passwordHash: null,
          googleId: null,
          name: null,
          role,
          lastLoginAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
      );
      agentKey = await mintKey("AGENT", "atendente");
      adminKey = await mintKey("TENANT_ADMIN", "admin");
    });

    afterAll(async () => {
      if (dbUp && su && tenantId) {
        for (const tid of [tenantId, otherTenantId]) {
          if (!tid) continue;
          for (const table of [
            "audit_logs",
            "api_keys",
            "conversations",
            "inboxes",
            "chatwoot_agent_bots",
            "agents",
            "chatwoot_instances",
          ]) {
            await su.$executeRawUnsafe(
              `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
            );
          }
          await su.$executeRawUnsafe(
            `DELETE FROM chatwoot_deployments WHERE tenant_id = ${tid}`,
          );
          await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
        }
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("both AGENT doors are refused with the same answer, and the service is never reached", async () => {
      reached.length = 0;
      role = "AGENT";
      const bySession = await call(`/conversations/${convDbId}/reengage`, {
        cookie: await sign("AGENT"),
      });
      const byKey = await call(`/conversations/${convDbId}/reengage`, {
        bearer: agentKey,
      });

      // 403 and not 401, and the difference is not cosmetic: `src/client/lib/api.ts` dispatches
      // `auth:unauthorized` on EVERY 401 and the console treats that as the end of the session, so
      // refusing with 401 logs the attendant out for pressing a button that is not theirs.
      expect([bySession.status, byKey.status]).toEqual([403, 403]);
      const bodies = [await bySession.json(), await byKey.json()];
      expect(bodies[0]).toEqual(bodies[1]);
      expect(String(bodies[0]?.error ?? "")).toMatch(/\S/);
      // Nothing behind the door ran. Asserted on the service and not on the status, because a 403
      // produced AFTER the write would look identical from outside.
      expect(readReached()).toEqual([]);
    });

    test("the refusal does not tell an AGENT which conversations exist", async () => {
      reached.length = 0;
      role = "AGENT";
      const cookie = await sign("AGENT");
      const answers = [];
      for (const id of [convDbId, foreignConvDbId, 999_999_999n]) {
        const res = await call(`/conversations/${id}/reengage`, { cookie });
        answers.push([res.status, await res.json()] as const);
      }

      // One that exists and is the tenant's, one that exists in another tenant, one that exists
      // nowhere: the same answer to all three. Authority checked after the id is resolved makes the
      // refusal an existence oracle, and the AGENT enumerates the tenant's conversations by the
      // difference between 403 and 404.
      //
      // WHAT THE RED HERE DID AND DID NOT SAY, because the stub answers where the service would:
      // before the fence all three came back 200, which proves the ROUTE admitted the rank — not
      // that a foreign conversation was re-engaged. The real service is fenced by RLS and would
      // answer 404 for the other tenant's id; what this test measures is the guard's POSITION.
      expect(answers.map(([s]) => s)).toEqual([403, 403, 403]);
      expect(answers.map(([, b]) => b)).toEqual([
        answers[0]?.[1],
        answers[0]?.[1],
        answers[0]?.[1],
      ]);
      expect(readReached()).toEqual([]);
    });

    test("the control: the same call on the same conversation gets through for an admin", async () => {
      reached.length = 0;
      role = "TENANT_ADMIN";
      const bySession = await call(`/conversations/${convDbId}/reengage`, {
        cookie: await sign("TENANT_ADMIN"),
      });
      const byKey = await call(`/conversations/${convDbId}/reengage`, {
        bearer: adminKey,
      });

      expect([bySession.status, byKey.status]).toEqual([200, 200]);
      // What held the two calls above was the principal's authority and not the harness.
      expect(readReached()).toEqual(["reengage", "reengage"]);
    });

    test("the three sibling ops stay open to an AGENT, and that boundary is the decision", async () => {
      reached.length = 0;
      role = "AGENT";
      const cookie = await sign("AGENT");
      const status: number[] = [];
      for (const [path, body] of [
        ["handoff", { assigneeId: 77 }],
        ["return", undefined],
        ["status", { status: "pending" }],
      ] as Array<[string, Record<string, unknown> | undefined]>) {
        const res = await call(
          `/conversations/${convDbId}/${path}`,
          { cookie },
          body,
        );
        status.push(res.status);
      }

      // `docs/ui.md` describes the conversation screen as the ops an attendant gets — "handoff,
      // return-to-AI, resolve, status select" — and re-engagement is not among them: it is the one
      // that SPEAKS to the customer, on the tenant's model budget. So the fence closes that door and
      // leaves these three, and this test is what makes that a recorded decision rather than a
      // residue of having fixed one route.
      expect(status).toEqual([200, 200, 200]);
      expect(readReached()).toEqual(["handoff", "return", "status"]);
    });
  },
);
