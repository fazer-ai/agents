import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  createAgent,
  getAgentToolSelections,
  replaceAgentToolSelections,
} from "@/modules/agents/service";
import {
  createKnowledgeBase,
  deleteKnowledgeBase,
} from "@/modules/rag/service";
import { dbProbeFailed } from "@/tests/db-gate";
import { waitUntilBlocked } from "@/tests/utils/pg-waits";

// A RAG grant names its bases in an array, which no foreign key covers. Deleting a base takes it out of
// every grant that names it, as the cascade does for every other grant target, so the agent's set can
// still be written back as it is stored; a grant left with no base is removed, since an empty list
// searches every base of the tenant.

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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

const base = async (name: string) =>
  (await createKnowledgeBase({ ctx: ctx(), name, base: appDb })).id;

const ragOf = async (agentId: bigint) =>
  (await getAgentToolSelections(ctx(), agentId, appDb)).grants.find(
    (g) => g.source === "RAG",
  )?.knowledgeBaseIds;

async function agentWith(name: string, kbs: bigint[]) {
  const a = await createAgent(ctx(), { name }, appDb);
  const id = BigInt(a.id);
  await replaceAgentToolSelections(
    ctx(),
    id,
    [
      {
        source: "RAG",
        enabledTools: ["search_knowledge"],
        knowledgeBaseIds: kbs.map(String),
      },
    ],
    appDb,
  );
  return id;
}

describe.skipIf(!dbUp)("deleting a knowledge base an agent uses", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "KB cascade", slug: `kb-cascade-${process.pid}` },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    await suDb.$executeRawUnsafe(
      `DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM agents WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM knowledge_bases WHERE tenant_id = ${tenantId}`,
    );
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("takes it out of every grant that names it, keeping the rest in order", async () => {
    const [x, y, z] = [await base("X"), await base("Y"), await base("Z")];
    const first = await agentWith("Uses X", [z, x, y]);
    const second = await agentWith("Only X", [x]);
    const other = await agentWith("Not X", [y]);
    await deleteKnowledgeBase({ ctx: ctx(), id: x, base: appDb });
    expect(await ragOf(first)).toEqual([String(z), String(y)]);
    // NOTE: An empty list searches every base, so the grant whose only base this was goes instead.
    expect(await ragOf(second)).toBeUndefined();
    expect(await ragOf(other)).toEqual([String(y)]);
  });

  test("the set as stored can be written back afterwards", async () => {
    const [x, y] = [await base("Gone"), await base("Kept")];
    const agent = await agentWith("Writes back", [x, y]);
    await deleteKnowledgeBase({ ctx: ctx(), id: x, base: appDb });
    const stored = (await getAgentToolSelections(ctx(), agent, appDb)).grants;
    await replaceAgentToolSelections(ctx(), agent, stored, appDb);
    expect(await ragOf(agent)).toEqual([String(y)]);
  });

  // A grant write that names a base waits for a delete of that base in flight, as an FK's
  // referencing insert would, and then refuses it: committing it would store the id the delete just
  // swept from every other grant.
  test("a grant write waits for the delete of a base it names, then refuses", async () => {
    const x = await base("Racing");
    const agent = await agentWith("Racer", []);
    let release: () => void = () => {};
    const held = new Promise<void>((r) => {
      release = r;
    });
    let locked: (pid: number) => void = () => {};
    const gotLock = new Promise<number>((r) => {
      locked = r;
    });
    const deleting = suDb.$transaction(
      async (tx) => {
        const [me] = await tx.$queryRaw<Array<{ pid: number }>>`
          SELECT pg_backend_pid()::int AS pid FROM knowledge_bases WHERE id = ${x} FOR UPDATE`;
        locked(me?.pid as number);
        await held;
        await tx.$executeRaw`DELETE FROM knowledge_bases WHERE id = ${x}`;
      },
      { timeout: 10_000 },
    );
    const holder = await gotLock;
    const writing = replaceAgentToolSelections(
      ctx(),
      agent,
      [
        {
          source: "RAG",
          enabledTools: ["search_knowledge"],
          knowledgeBaseIds: [String(x)],
        },
      ],
      appDb,
    ).then(
      () => "written",
      (e: { statusCode?: number }) => e.statusCode,
    );
    expect(await waitUntilBlocked(suDb, holder, 1)).toBeGreaterThanOrEqual(0);
    release();
    await deleting;
    expect(await writing).toBe(404);
    expect(await ragOf(agent)).toEqual([]);
  });
});
