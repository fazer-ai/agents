import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { Client } from "pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  createAgent,
  replaceAgentToolSelections,
} from "@/modules/agents/service";
import { createKnowledgeBase } from "@/modules/rag/service";
import { dbProbeFailed } from "@/tests/db-gate";

// Runs the actual migration file over grants holding ids no base answers to: a deleted base's, and
// another tenant's. Those leave, the rest keep their order, a grant naming only live bases is not
// rewritten, and a grant whose every id dangles is removed rather than emptied (an empty list searches
// every base of the tenant). A grant already empty is left alone.

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
const MIGRATION =
  "prisma/migrations/20261021200000_sweep_deleted_knowledge_bases_from_grants/migration.sql";

// Read outside the connection guard: folding a missing migration file into the `catch` that answers
// "no database here" would turn it into a silent skip.
const sql = await Bun.file(MIGRATION).text();

let dbUp = false;
let su: Client | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new Client({ connectionString: suUrl });
    await su.connect();
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch (err) {
    dbUp = dbProbeFailed(err);
  }
}
const suDb = su as Client;
const appDb = app as PrismaClient;

const tenants: bigint[] = [];
const ctxOf = (tenantId: bigint): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

async function tenant(slug: string): Promise<bigint> {
  const r = await suDb.query(
    "INSERT INTO tenants (name, slug, updated_at) VALUES ($1, $1, NOW()) RETURNING id",
    [`${slug}-${process.pid}`],
  );
  const id = BigInt(r.rows[0].id);
  tenants.push(id);
  return id;
}

async function ragAgent(tenantId: bigint, kbs: bigint[]): Promise<bigint> {
  const a = await createAgent(ctxOf(tenantId), { name: "Sweep" }, appDb);
  const id = BigInt(a.id);
  await replaceAgentToolSelections(
    ctxOf(tenantId),
    id,
    [
      { source: "NATIVE", enabledTools: ["private_note"] },
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

async function ragIds(agentId: bigint): Promise<string[] | undefined> {
  const r = await suDb.query(
    "SELECT knowledge_base_ids::text[] AS ids FROM agent_tool_selections WHERE agent_id = $1 AND source = 'RAG'",
    [String(agentId)],
  );
  return r.rows[0]?.ids;
}

const ctid = async (agentId: bigint) =>
  (
    await suDb.query(
      "SELECT ctid::text AS c FROM agent_tool_selections WHERE agent_id = $1 AND source = 'RAG'",
      [String(agentId)],
    )
  ).rows[0].c;

describe.skipIf(!dbUp)("migration: sweep deleted bases from the grants", () => {
  let mine: bigint[] = [];
  let theirs = 0n;
  let dangling = 0n;
  let clean = 0n;
  let onlyGone = 0n;
  let empty = 0n;

  beforeAll(async () => {
    const a = await tenant("sweep-a");
    const b = await tenant("sweep-b");
    const kb = async (t: bigint, name: string) =>
      (await createKnowledgeBase({ ctx: ctxOf(t), name, base: appDb })).id;
    mine = [await kb(a, "A1"), await kb(a, "A2"), await kb(a, "Gone")];
    theirs = await kb(b, "B1");
    const [a1, a2, gone] = mine as [bigint, bigint, bigint];
    dangling = await ragAgent(a, [a2, gone, a1]);
    clean = await ragAgent(a, [a1, a2]);
    onlyGone = await ragAgent(a, [gone]);
    empty = await ragAgent(a, []);
    // NOTE: The state the migration repairs, which no write path can produce any more: a deleted
    // base's id, and another tenant's, stored in the array.
    await suDb.query("DELETE FROM knowledge_bases WHERE id = $1", [
      String(gone),
    ]);
    await suDb.query(
      "UPDATE agent_tool_selections SET knowledge_base_ids = knowledge_base_ids || $2::bigint WHERE agent_id = $1 AND source = 'RAG'",
      [String(dangling), String(theirs)],
    );
  });

  afterAll(async () => {
    for (const t of tenants) {
      await suDb.query("DELETE FROM audit_logs WHERE tenant_id = $1", [
        String(t),
      ]);
      await suDb.query("DELETE FROM agents WHERE tenant_id = $1", [String(t)]);
      await suDb.query("DELETE FROM knowledge_bases WHERE tenant_id = $1", [
        String(t),
      ]);
      await suDb.query("DELETE FROM tenants WHERE id = $1", [String(t)]);
    }
    await suDb.end();
    await appDb.$disconnect();
  });

  test("takes out the ids no base of the tenant answers to, keeping the order of the rest", async () => {
    const [a1, a2, gone] = mine as [bigint, bigint, bigint];
    expect(await ragIds(dangling)).toEqual([
      String(a2),
      String(gone),
      String(a1),
      String(theirs),
    ]);
    expect(await ragIds(onlyGone)).toEqual([String(gone)]);
    const untouched = await ctid(clean);
    await suDb.query(sql);
    expect(await ragIds(dangling)).toEqual([String(a2), String(a1)]);
    expect(await ragIds(clean)).toEqual([String(a1), String(a2)]);
    expect(await ragIds(onlyGone)).toBeUndefined();
    expect(await ragIds(empty)).toEqual([]);
    // NOTE: A grant with nothing to take out is not rewritten: same tuple.
    expect(await ctid(clean)).toBe(untouched);
  });
});
