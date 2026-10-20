import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { getCheckpointer } from "@/graph/checkpointer";
import { AppError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { deleteAgent } from "@/modules/agents/service";
import {
  claimClientThread,
  EXPIRY_CLAIM,
  type ExternalIdentity,
  leaseClientThread,
} from "@/modules/client-channel/identity";
import { MAX_SCREEN_CONTEXT_CHARS } from "@/modules/client-channel/screen-context";
import { runClientTurn } from "@/modules/client-channel/service";
import { dbProbeFailed } from "@/tests/db-gate";

// A client thread belongs to the user and scope it was minted for. Every other caller, whether the
// id is someone else's, unknown, malformed or from another agent, gets the same 404, so the answer
// says nothing about which threads exist.

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

let tenantId = 0n;
let otherTenantId = 0n;
let agentId = 0n;
let otherAgentId = 0n;
let ctx: TenantContext;

const ANA: ExternalIdentity = { id: "user-ana", name: "Ana", scope: "org-1" };
const BRUNO: ExternalIdentity = { id: "user-bruno", scope: "org-1" };

async function claim(
  user: ExternalIdentity,
  threadId?: string,
  agent = agentId,
) {
  return claimClientThread({
    ctx,
    agentId: agent,
    threadId,
    user,
    base: appDb,
  });
}

async function status(run: () => Promise<unknown>) {
  try {
    await run();
    return "ok";
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    return `${e.statusCode} ${e.translationKey}`;
  }
}

describe.skipIf(!dbUp)("client channel: who a thread belongs to", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "CCI", slug: `cci-${process.pid}` },
    });
    tenantId = t.id;
    otherTenantId = (
      await suDb.tenant.create({
        data: { name: "CCI2", slug: `cci2-${process.pid}` },
      })
    ).id;
    ctx = { tenantId, userId: null, role: "TENANT_ADMIN" };
    const key = await suDb.vaultEntry.create({
      data: { tenantId, name: "llm", secret: encryptJson("sk-test") },
      select: { id: true },
    });
    const modelConfig = {
      provider: "openai",
      model: "gpt-6-luna",
      credentialRef: `vault:${key.id}`,
    };
    agentId = (
      await suDb.agent.create({
        data: { tenantId, name: "copiloto", systemPrompt: "x", modelConfig },
      })
    ).id;
    otherAgentId = (
      await suDb.agent.create({
        data: { tenantId, name: "outro", systemPrompt: "x", modelConfig },
      })
    ).id;
  });

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      if (id) await suDb.tenant.deleteMany({ where: { id } });
    }
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  test("a turn with no thread mints one, bound to the user and the scope", async () => {
    const { threadId, externalUserId } = await claim(ANA);
    expect(threadId.startsWith(`${tenantId}:client:${agentId}:`)).toBe(true);
    const row = await suDb.detachedThread.findUnique({ where: { threadId } });
    expect(row).toMatchObject({
      tenantId,
      agentId,
      kind: "client",
      externalUserId,
      scope: "org-1",
    });
    const person = await suDb.externalUser.findUnique({
      where: { id: externalUserId },
    });
    expect(person).toMatchObject({
      tenantId,
      channel: "client",
      externalId: "user-ana",
      name: "Ana",
    });
  });

  test("the same user and scope resume it", async () => {
    const { threadId } = await claim(ANA);
    expect((await claim(ANA, threadId)).threadId).toBe(threadId);
  });

  test("anyone else is told it does not exist, with the same answer every time", async () => {
    const { threadId } = await claim(ANA);
    const notFound = "404 errors.threadNotFound";
    // Another user of the same host, same scope.
    expect(await status(() => claim(BRUNO, threadId))).toBe(notFound);
    // The same user in another scope.
    expect(
      await status(() => claim({ ...ANA, scope: "org-2" }, threadId)),
    ).toBe(notFound);
    // The same user with no scope, against a thread that has one.
    expect(
      await status(() => claim({ id: ANA.id, name: ANA.name }, threadId)),
    ).toBe(notFound);
    // Another agent of the same tenant.
    expect(await status(() => claim(ANA, threadId, otherAgentId))).toBe(
      notFound,
    );
    // Well-formed, never minted.
    expect(
      await status(() =>
        claim(
          ANA,
          `${tenantId}:client:${agentId}:00000000-0000-0000-0000-000000000000`,
        ),
      ),
    ).toBe(notFound);
    // Malformed, and another channel's shape.
    expect(await status(() => claim(ANA, "nope"))).toBe(notFound);
    expect(
      await status(() =>
        claim(ANA, threadId.replace(":client:", ":playground:")),
      ),
    ).toBe(notFound);
  });

  test("another tenant cannot name it either", async () => {
    const { threadId } = await claim(ANA);
    const other = await claimClientThread({
      ctx: { tenantId: otherTenantId, userId: null, role: "TENANT_ADMIN" },
      agentId,
      threadId: undefined,
      user: ANA,
      base: appDb,
    }).catch((e: AppError) => `${e.statusCode} ${e.translationKey}`);
    // The agent belongs to the first tenant, so under the second it does not exist.
    expect(other).toBe("404 errors.agentNotFound");
    expect(
      await status(() =>
        claimClientThread({
          ctx: { tenantId: otherTenantId, userId: null, role: "TENANT_ADMIN" },
          agentId,
          threadId,
          user: ANA,
          base: appDb,
        }),
      ),
    ).toBe("404 errors.threadNotFound");
  });

  test("a name sent refreshes the record, a name omitted keeps it", async () => {
    const { externalUserId } = await claim({ id: "user-carla", name: "Carla" });
    await claim({ id: "user-carla" });
    const kept = await suDb.externalUser.findUnique({
      where: { id: externalUserId },
    });
    expect(kept?.name).toBe("Carla");
    await claim({ id: "user-carla", name: "Carla Souza" });
    const renamed = await suDb.externalUser.findUnique({
      where: { id: externalUserId },
    });
    expect(renamed?.name).toBe("Carla Souza");
    // One person, however many turns.
    expect(
      await suDb.externalUser.count({
        where: { tenantId, externalId: "user-carla" },
      }),
    ).toBe(1);
  });

  test("a user in two scopes is one person with two threads", async () => {
    const a = await claim({ id: "user-dani", scope: "org-1" });
    const b = await claim({ id: "user-dani", scope: "org-2" });
    expect(a.externalUserId).toBe(b.externalUserId);
    expect(a.threadId).not.toBe(b.threadId);
  });

  test("a missing agent is not found, and nothing is written", async () => {
    const before = await suDb.externalUser.count({ where: { tenantId } });
    expect(
      await status(() => claim({ id: "user-eva" }, undefined, 999_999_999n)),
    ).toBe("404 errors.agentNotFound");
    expect(await suDb.externalUser.count({ where: { tenantId } })).toBe(before);
  });

  // The checkpoints live in another store, which the anonymous expiry reaches only through the
  // thread rows the agent's delete cascades away.
  test("deleting an agent deletes its client threads' checkpoints, and waits for a running one", async () => {
    const doomed = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "apagado",
          systemPrompt: "x",
          modelConfig: { provider: "openai", model: "gpt-6-luna" },
        },
      })
    ).id;
    const checkpointer = await getCheckpointer();
    const talked = await runClientTurn({
      ctx,
      agentId: doomed,
      user: { id: "user-del-1" },
      message: "oi",
      clientTools: [],
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Olá."] }),
        checkpointer,
      },
    });
    const busy = await claim({ id: "user-del-2" }, undefined, doomed);
    await leaseClientThread({
      ctx,
      threadId: busy.threadId,
      turnId: "turn-running",
      base: appDb,
      leaseMs: 60_000,
    });
    const saved = async () =>
      (await checkpointer.get({
        configurable: { thread_id: talked.threadId },
      })) !== undefined;
    const refused = await status(() => deleteAgent(ctx, doomed, appDb));
    const whileRunning = {
      refused,
      agent: await suDb.agent.count({ where: { id: doomed } }),
      transcript: await suDb.clientThreadMessage.count({
        where: { threadId: talked.threadId },
      }),
      checkpoint: await saved(),
    };
    // A thread the expiry claimed is on its way out, and does not hold the delete back.
    await suDb.detachedThread.update({
      where: { threadId: busy.threadId },
      data: {
        activeTurnId: EXPIRY_CLAIM,
        activeUntil: new Date("9999-12-31T00:00:00Z"),
      },
    });
    await deleteAgent(ctx, doomed, appDb);
    expect({
      whileRunning,
      agent: await suDb.agent.count({ where: { id: doomed } }),
      rows: await suDb.detachedThread.count({ where: { agentId: doomed } }),
      transcript: await suDb.clientThreadMessage.count({
        where: { threadId: talked.threadId },
      }),
      checkpoint: await saved(),
    }).toEqual({
      whileRunning: {
        refused: "409 errors.agentClientTurnRunning",
        agent: 1,
        transcript: 2,
        checkpoint: true,
      },
      agent: 0,
      rows: 0,
      transcript: 0,
      checkpoint: false,
    });
  });

  test("a checkpoint store that refuses after the agent is gone does not fail the delete", async () => {
    const doomed = (
      await suDb.agent.create({
        data: { tenantId, name: "apagado-2", systemPrompt: "x" },
      })
    ).id;
    await claim({ id: "user-del-3" }, undefined, doomed);
    const asked: string[] = [];
    await deleteAgent(ctx, doomed, appDb, {
      checkpointer: {
        deleteThread: async (threadId: string) => {
          asked.push(threadId);
          throw new Error("checkpoint store down");
        },
      },
    });
    expect({
      agent: await suDb.agent.count({ where: { id: doomed } }),
      asked: asked.length,
    }).toEqual({ agent: 0, asked: 1 });
  });

  // The context rides in the checkpointed message, which the history ceiling never trims.
  test("a page context over the cap is refused before anything is written, and one at the cap runs", async () => {
    const before = await suDb.externalUser.count({ where: { tenantId } });
    // The key, quotes and braces add 11 characters: `{"tela":"…"}`.
    const sized = (chars: number) => ({ tela: "x".repeat(chars - 11) });
    const over = await status(() =>
      runClientTurn({
        ctx,
        agentId,
        user: { id: "user-big-context" },
        message: "oi",
        context: sized(MAX_SCREEN_CONTEXT_CHARS + 1),
        clientTools: [],
        base: appDb,
        deps: {
          makeModel: () => {
            throw new Error("the model must not run");
          },
          checkpointer: new MemorySaver(),
        },
      }),
    );
    const afterRefusal = await suDb.externalUser.count({ where: { tenantId } });
    const atCap = await runClientTurn({
      ctx,
      agentId,
      user: { id: "user-big-context" },
      message: "oi",
      context: sized(MAX_SCREEN_CONTEXT_CHARS),
      clientTools: [],
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Olá."] }),
        checkpointer: new MemorySaver(),
      },
    });
    expect({
      over,
      written: afterRefusal - before,
      atCap: atCap.status,
    }).toEqual({
      over: "413 errors.clientContextTooLarge",
      written: 0,
      atCap: "done",
    });
  });

  test("the turn itself refuses another user's thread before the model runs", async () => {
    const first = await runClientTurn({
      ctx,
      agentId,
      user: ANA,
      message: "oi",
      clientTools: [],
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: ["Olá, Ana."] }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(first).toMatchObject({ status: "done", reply: "Olá, Ana." });
    expect(
      await status(() =>
        runClientTurn({
          ctx,
          agentId,
          user: BRUNO,
          threadId: first.threadId,
          message: "o que a Ana disse?",
          clientTools: [],
          base: appDb,
          deps: {
            makeModel: () => {
              throw new Error("the model must not run for another user");
            },
            checkpointer: new MemorySaver(),
          },
        }),
      ),
    ).toBe("404 errors.threadNotFound");
  });
});
