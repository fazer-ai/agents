import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import {
  readTenantSpendCeiling,
  spendCeilingVerdict,
  tokensUsedSince,
} from "@/modules/spend-ceiling/service";

// What the ledger answers, read the way the gate reads it (issue #146). The rule itself is proved
// without a database in ./spend-ceiling-decide.test.ts; this is the READ.

let appDb: PrismaClient;
let suDb: PrismaClient;
let dbUp = true;
let tenantId = 0n;

if (!process.env.TEST_APP_DATABASE_URL) {
  dbUp = false;
} else {
  appDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_APP_DATABASE_URL,
    }),
  });
  suDb = new PrismaClient({
    adapter: new PrismaPg({
      connectionString: process.env.TEST_MIGRATION_DATABASE_URL,
    }),
  });
  try {
    await suDb.$queryRaw`SELECT 1`;
  } catch {
    dbUp = false;
  }
}

const AUG = new Date("2026-08-15T12:00:00Z");
const AUG_START = new Date("2026-08-01T00:00:00Z");

async function seedUsage(
  rows: Array<{
    source: string;
    prompt: number;
    completion: number;
    cachedRead?: number;
    at: string;
  }>,
) {
  await suDb.llmUsage.createMany({
    data: rows.map((r) => ({
      tenantId,
      model: "gpt-5.4-mini",
      source: r.source,
      promptTokens: r.prompt,
      completionTokens: r.completion,
      cachedReadTokens: r.cachedRead ?? 0,
      createdAt: new Date(r.at),
    })),
  });
}

describe.skipIf(!dbUp)("the spend ceiling against the ledger", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "SC", slug: `sc-${process.pid}` },
    });
    tenantId = t.id;
    await seedUsage([
      // Inside the month, real traffic.
      {
        source: "inbox",
        prompt: 1000,
        completion: 200,
        at: "2026-08-02T10:00:00Z",
      },
      {
        source: "inbox",
        prompt: 500,
        completion: 100,
        at: "2026-08-14T10:00:00Z",
      },
      // Inside the month, and cached: the discount is a SUBSET of promptTokens, so this row is
      // worth exactly its prompt + completion and not one token more.
      {
        source: "inbox",
        prompt: 400,
        completion: 50,
        cachedRead: 380,
        at: "2026-08-14T11:00:00Z",
      },
      // The operator testing, which answers to its own ceiling.
      {
        source: "playground",
        prompt: 900,
        completion: 90,
        at: "2026-08-10T10:00:00Z",
      },
      // Last month, which this month must not inherit.
      {
        source: "inbox",
        prompt: 9_000_000,
        completion: 1,
        at: "2026-07-31T23:59:59Z",
      },
    ]);
  });

  afterAll(async () => {
    if (!dbUp || tenantId === 0n) return;
    await suDb.llmUsage.deleteMany({ where: { tenantId } });
    await suDb.tenant.deleteMany({ where: { id: tenantId } });
    await appDb.$disconnect();
    await suDb.$disconnect();
  });

  describe("reading the month's tokens", () => {
    test("counts prompt + completion for the source asked about", async () => {
      // 1200 + 600 + 450, and NOT the 380 served from cache on top of its own row.
      expect(await tokensUsedSince(tenantId, "inbox", AUG_START, appDb)).toBe(
        2250,
      );
    });

    test("the playground is counted apart", async () => {
      expect(
        await tokensUsedSince(tenantId, "playground", AUG_START, appDb),
      ).toBe(990);
    });

    // The calendar month is the window, so a bad July cannot silence August. Without this the ceiling
    // would be a lifetime total that no operator could ever get back under.
    test("last month does not count against this one", async () => {
      const used = await tokensUsedSince(tenantId, "inbox", AUG_START, appDb);
      expect(used).toBeLessThan(9_000_000);
    });

    test("a tenant with no rows at all reads zero, not null", async () => {
      const other = await suDb.tenant.create({
        data: { name: "SC2", slug: `sc2-${process.pid}` },
      });
      try {
        expect(await tokensUsedSince(other.id, "inbox", AUG_START, appDb)).toBe(
          0,
        );
      } finally {
        await suDb.tenant.deleteMany({ where: { id: other.id } });
      }
    });
  });

  describe("the verdict, end to end", () => {
    test("a tenant that never configured a ceiling is allowed, and is not queried for one", async () => {
      const v = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: AUG,
      });
      expect(v.state).toBe("allowed");
      expect(v.ceilingTokens).toBeNull();
    });

    test("over the ceiling the verdict carries the real numbers", async () => {
      const v = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: AUG,
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          monthlyInboxTokens: 2000,
        },
      });
      expect(v.state).toBe("over");
      expect(v.usedTokens).toBe(2250);
      expect(v.ceilingTokens).toBe(2000);
    });

    // The two halves do not borrow from each other: the same ledger, the same month, opposite answers.
    test("the playground's own spending does not close the inbox", async () => {
      const cfg = {
        ...(await readTenantSpendCeiling(tenantId, appDb)),
        enabled: true,
        monthlyInboxTokens: 10_000,
        monthlyPlaygroundTokens: 500,
      };
      const play = await spendCeilingVerdict({
        tenantId,
        source: "playground",
        base: appDb,
        now: AUG,
        cfg,
      });
      const inbox = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: appDb,
        now: AUG,
        cfg,
      });
      expect(play.state).toBe("over");
      expect(inbox.state).toBe("allowed");
    });

    // THE FAIL-OPEN, which is a claim the comment makes and nothing proved until this. It is the
    // opposite direction from the durable turn claim (#203), so it is exactly the kind of decision
    // that gets "tidied" into a rethrow by someone reading the two side by side.
    //
    // Driven by rejecting the LEDGER SUM alone, matched on a fragment only it contains, so the
    // settings read still works and this measures the branch it is about. The customer who wrote in
    // while our own pool was exhausted gets an answer, not silence.
    test("a ledger read that fails lets the turn through", async () => {
      let refused = 0;
      const blind = appDb.$extends({
        query: {
          async $allOperations({ operation, args, query }) {
            if (operation === "$queryRaw") {
              const sql = ((args as { strings?: string[] }).strings ?? []).join(
                " ",
              );
              if (sql.includes("FROM llm_usage")) {
                refused += 1;
                throw new Error("connection reset");
              }
            }
            return query(args);
          },
        },
      }) as unknown as PrismaClient;
      const v = await spendCeilingVerdict({
        tenantId,
        source: "inbox",
        base: blind,
        now: AUG,
        cfg: {
          ...(await readTenantSpendCeiling(tenantId, appDb)),
          enabled: true,
          // A ceiling this tenant is far past, so a read that DID work would answer "over".
          monthlyInboxTokens: 1,
        },
      });
      // The read the test is about actually ran; without this the assertion below would pass on a
      // path that never reached it.
      expect(refused).toBeGreaterThan(0);
      expect(v.state).toBe("allowed");
    });
  });
});
