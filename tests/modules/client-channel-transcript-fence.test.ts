import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { dbProbeFailed } from "@/tests/db-gate";
import { until } from "@/tests/utils/poll";

// A turn whose claim is lost while its reply is being written to the transcript is the lost claim,
// as one lost anywhere else in the round-trip: it answers 409, not the reply. The claim is taken
// during the write, which then lasts until a renewal has found it gone.

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
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const identity = await import("@/modules/client-channel/identity");
const realIdentity = { ...identity };
let lost = false;
mock.module("@/modules/client-channel/identity", () => ({
  ...realIdentity,
  renewClientThread: async (
    p: Parameters<typeof realIdentity.renewClientThread>[0],
  ) => {
    const held = await realIdentity.renewClientThread(p);
    if (!held) lost = true;
    return held;
  },
  recordClientMessage: async (
    p: Parameters<typeof realIdentity.recordClientMessage>[0],
  ) => {
    await realIdentity.recordClientMessage(p);
    if (p.role !== "agent") return;
    await suDb.detachedThread.update({
      where: { threadId: p.threadId },
      data: {
        activeTurnId: "thief",
        activeUntil: new Date(Date.now() + 60_000),
      },
    });
    // NOTE: polled, so the turn has acted on the refused renewal by the time this returns.
    await until("a renewal to find the claim taken", () => lost);
  },
}));
const { runClientTurn } = await import("@/modules/client-channel/service");

let tenantId = 0n;
let agentId = 0n;
let ctx: TenantContext;

describe.skipIf(!dbUp)("a claim lost while the reply is recorded", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "CTF", slug: `ctf-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    agentId = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "copiloto",
          systemPrompt: "x",
          modelConfig: {
            provider: "openai",
            model: "gpt-6-luna",
            credentialRef: `vault:${key.id}`,
          },
        },
      })
    ).id;
  });

  afterAll(async () => {
    mock.module("@/modules/client-channel/identity", () => realIdentity);
    if (tenantId) await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("answers 409, not the reply", async () => {
    const outcome = await runClientTurn({
      ctx,
      agentId,
      user: { id: "ana" },
      message: "oi",
      clientTools: [],
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Olá."] }),
        checkpointer: new MemorySaver(),
        lease: { ms: 60_000, renewEveryMs: 100 },
      },
    }).then(
      (r) => r.status,
      (e) =>
        e instanceof AppError ? `${e.statusCode} ${e.translationKey}` : e,
    );
    expect(outcome).toBe("409 errors.clientTurnClaimLost");
  });

  test("a claim lost before the user's message is recorded records nothing", async () => {
    lost = false;
    // The thread's state is read slowly: the claim is taken meanwhile, and the read returns only once
    // a renewal has found it gone.
    class SlowSaver extends MemorySaver {
      stalled = false;
      override async getTuple(
        config: Parameters<MemorySaver["getTuple"]>[0],
      ): ReturnType<MemorySaver["getTuple"]> {
        const threadId = config.configurable?.thread_id as string;
        if (!this.stalled && threadId) {
          this.stalled = true;
          await suDb.detachedThread.update({
            where: { threadId },
            data: {
              activeTurnId: "thief",
              activeUntil: new Date(Date.now() + 60_000),
            },
          });
          await until("a renewal to find the claim taken", () => lost);
        }
        return super.getTuple(config);
      }
    }
    const outcome = await runClientTurn({
      ctx,
      agentId,
      user: { id: "bruno" },
      message: "não fica",
      clientTools: [],
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Olá."] }),
        checkpointer: new SlowSaver(),
        lease: { ms: 60_000, renewEveryMs: 100 },
      },
    }).then(
      (r) => r.status,
      (e) =>
        e instanceof AppError ? `${e.statusCode} ${e.translationKey}` : e,
    );
    expect({
      outcome,
      recorded: await suDb.clientThreadMessage.count({
        where: { tenantId, text: "não fica" },
      }),
    }).toEqual({ outcome: "409 errors.clientTurnClaimLost", recorded: 0 });
  });
});
