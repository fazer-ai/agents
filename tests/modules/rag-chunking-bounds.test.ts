import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import {
  knowledgeCreate,
  knowledgeUpdate,
} from "@/modules/mcp/write-knowledge";

// `chunkOverlap` is bounded by `floor(chunkSize/2)`, and a knowledge base carries BOTH values, so
// the question is about the row rather than about the arguments. `updateKnowledgeBase` asked it of
// the arguments: it validated the pair when both arrived and, when only one did, fell through to a
// branch that compared against a constant. Either single-field update therefore landed a state the
// two-field update refuses by name. Issue #524.
//
// The same gap left the MCP preview unable to ask at all: `getKnowledgeBase` is the only knowledge
// read that does NOT carry the chunking pair (`listKnowledgeBases` has carried it all along, and
// `knowledge_list` advertises it), so the preview had nothing to compare against and approved what
// the apply refused -- the #490 divergence, on a tool whose fence row only ever proved ownership.

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
const suDb = su as PrismaClient;
const appDb = app as PrismaClient;

describe.skipIf(!dbUp)(
  "a knowledge base's chunking bound is asked of the row",
  () => {
    let tenantId = 0n;
    const principal = (): VerifiedToken => ({
      userId: 1n,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    });

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "Chunking", slug: `chunking-${process.pid}` },
      });
      tenantId = t.id;
    });

    afterAll(async () => {
      const bases = await suDb.knowledgeBase.findMany({
        where: { tenantId },
        select: { id: true },
      });
      await suDb.knowledgeChunk.deleteMany({
        where: { knowledgeBaseId: { in: bases.map((b) => b.id) } },
      });
      await suDb.knowledgeBase.deleteMany({ where: { tenantId } });
      await suDb.tenant.delete({ where: { id: tenantId } });
    });

    // A fresh base, at whatever the schema defaults to (1000/200 today). Each test gets its own so a
    // refusal in one cannot be read off a row another test moved.
    async function freshBase(): Promise<string> {
      const r = await knowledgeCreate(
        principal(),
        { name: `kb-${crypto.randomUUID().slice(0, 8)}`, dry_run: false },
        { base: appDb },
      );
      if (!r.ok) throw new Error(`could not seed: ${r.error}`);
      const data = r.data as Record<string, unknown>;
      return String((data.result as { id?: unknown })?.id ?? data.id);
    }

    const apply = (id: string, args: Record<string, unknown>) =>
      knowledgeUpdate(
        principal(),
        { knowledge_base_id: id, ...args, dry_run: false } as never,
        { base: appDb },
      );
    const stored = (id: string) =>
      suDb.knowledgeBase.findUniqueOrThrow({
        where: { id: BigInt(id) },
        select: { chunkSize: true, chunkOverlap: true },
      });

    test("an overlap alone is measured against the STORED chunk size", async () => {
      const id = await freshBase();
      // NOTE: the row is 1000/200, so the ceiling is 500. The old branch compared against a constant
      // 4000.
      const r = await apply(id, { chunk_overlap: 4000 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("chunkOverlap");
      expect(await stored(id)).toEqual({ chunkSize: 1000, chunkOverlap: 200 });
    });

    test("a chunk size alone is measured against the STORED overlap", async () => {
      const id = await freshBase();
      const wide = await apply(id, { chunk_size: 8000, chunk_overlap: 4000 });
      expect(wide.ok).toBe(true);
      // NOTE: shrinking the chunk alone would now leave overlap 4000 against a ceiling of 100.
      const r = await apply(id, { chunk_size: 200 });
      expect(r.ok).toBe(false);
      expect(await stored(id)).toEqual({ chunkSize: 8000, chunkOverlap: 4000 });
    });

    // NOTE: the control that makes the two above mean something. The SAME end state, asked for in one
    // call, was already refused before this change; without it they would pass on a tool that simply
    // refuses every chunking update.
    test("the pair that is legal together is still accepted", async () => {
      const id = await freshBase();
      const r = await apply(id, { chunk_size: 400, chunk_overlap: 200 });
      expect(r.ok).toBe(true);
      expect(await stored(id)).toEqual({ chunkSize: 400, chunkOverlap: 200 });
    });

    test("the pair that is illegal together is refused, as it always was", async () => {
      const id = await freshBase();
      const r = await apply(id, { chunk_size: 200, chunk_overlap: 4000 });
      expect(r.ok).toBe(false);
    });

    // NOTE: rows already holding an invalid pair exist precisely because the old branch let them
    // through, so the guard has to reach them without holding their metadata hostage. Enforcing an
    // invariant going forward is not the same as refusing every unrelated edit until someone
    // repairs the row, and the refusal it produced named a bound on a field the caller never sent.
    // Review found this; the row here is written straight through Prisma because the fixed code can
    // no longer produce it.
    test("a row left invalid by the old behaviour can still be renamed", async () => {
      const legacy = await suDb.knowledgeBase.create({
        data: { tenantId, name: "legacy", chunkSize: 200, chunkOverlap: 4000 },
        select: { id: true },
      });
      const id = String(legacy.id);
      const previewed = await knowledgeUpdate(
        principal(),
        { knowledge_base_id: id, name: "renamed", dry_run: true },
        { base: appDb },
      );
      expect(previewed.ok).toBe(true);
      const applied = await apply(id, { name: "renamed" });
      expect(applied.ok).toBe(true);
      expect(await stored(id)).toEqual({ chunkSize: 200, chunkOverlap: 4000 });

      // NOTE: the other half of the same sentence. Touching either number on that row IS a chunking
      // patch, so it is judged, and the pair it would leave is still illegal.
      const half = await apply(id, { chunk_overlap: 300 });
      expect(half.ok).toBe(false);
      const whole = await apply(id, { chunk_size: 800, chunk_overlap: 300 });
      expect(whole.ok).toBe(true);
    });
  },
);

describe.skipIf(!dbUp)(
  "knowledge_update's preview answers what its apply answers",
  () => {
    let tenantId = 0n;
    const principal = (): VerifiedToken => ({
      userId: 1n,
      tenantId,
      role: "TENANT_ADMIN",
      scopes: ["mcp:read", "mcp:write"],
      clientId: "c",
      jti: "j",
    });

    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "ChunkPrev", slug: `chunkprev-${process.pid}` },
      });
      tenantId = t.id;
    });
    afterAll(async () => {
      await suDb.knowledgeBase.deleteMany({ where: { tenantId } });
      await suDb.tenant.delete({ where: { id: tenantId } });
      await su?.$disconnect();
      await app?.$disconnect();
    });

    async function freshBase(): Promise<string> {
      const r = await knowledgeCreate(
        principal(),
        { name: `kb-${crypto.randomUUID().slice(0, 8)}`, dry_run: false },
        { base: appDb },
      );
      if (!r.ok) throw new Error(`could not seed: ${r.error}`);
      const data = r.data as Record<string, unknown>;
      return String((data.result as { id?: unknown })?.id ?? data.id);
    }

    const both = async (id: string, args: Record<string, unknown>) => ({
      previewed: await knowledgeUpdate(
        principal(),
        { knowledge_base_id: id, ...args, dry_run: true } as never,
        { base: appDb },
      ),
      applied: await knowledgeUpdate(
        principal(),
        { knowledge_base_id: id, ...args, dry_run: false } as never,
        { base: appDb },
      ),
    });

    test("a chunk size past the ceiling is refused by both halves", async () => {
      const { previewed, applied } = await both(await freshBase(), {
        chunk_size: 99999999,
      });
      expect(applied.ok).toBe(false);
      expect(previewed.ok).toBe(false);
    });

    test("an overlap past the row's ceiling is refused by both halves", async () => {
      const { previewed, applied } = await both(await freshBase(), {
        chunk_overlap: 4000,
      });
      expect(applied.ok).toBe(false);
      expect(previewed.ok).toBe(false);
    });

    // NOTE: a preview whose diff omits the fields it is about tells the operator nothing changes, and
    // then the apply changes them. The tool accepts these two, so the preview names them.
    test("the preview's diff names the chunking fields it will write", async () => {
      const id = await freshBase();
      const r = await knowledgeUpdate(
        principal(),
        {
          knowledge_base_id: id,
          chunk_size: 400,
          chunk_overlap: 100,
          dry_run: true,
        },
        { base: appDb },
      );
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const diff = (r.data as { diff: Record<string, unknown> }).diff;
      expect(Object.keys(diff).sort()).toEqual(["chunkOverlap", "chunkSize"]);
    });
  },
);
