import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { LLMResult } from "@langchain/core/outputs";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { sumTurnUsage, UsageCapture } from "@/graph/usage";
import type { TenantContext } from "@/lib/tenancy";
import type { VerifiedToken } from "@/modules/mcp/oauth/tokens";
import { tenantSettingsGet } from "@/modules/mcp/read";
import { tenantSettingsUpdate } from "@/modules/mcp/write-settings";
import {
  cachedPriceOverrides,
  forgetPriceOverrides,
  type PriceOverridesBlock,
  priceOverridesSchema,
  readPriceOverrides,
} from "@/modules/pricing/overrides";
import { callCostUsd, priceCall } from "@/modules/pricing/price";
import { PRICE_TABLE_VERSION } from "@/modules/pricing/version";
import {
  getTenantSettings,
  updatePriceOverrides,
} from "@/modules/tenant-settings/service";

// Issue #865: a tenant's own prices for model calls, consulted before the price table when a ledger
// row is priced, and recorded in the row so a price corrected later can find the rows it wrote.

const tokens = (promptTokens: number, completionTokens: number) => ({
  promptTokens,
  completionTokens,
  cachedReadTokens: 0,
  cacheCreationTokens: 0,
});
const AT = new Date("2026-09-24T07:30:00Z"); // a weekday at DeepSeek's peak

const block = (
  overrides: PriceOverridesBlock["overrides"],
): PriceOverridesBlock => ({
  overrides,
  updatedAt: "2026-09-25T12:00:00.000Z",
});

describe("what prices a call", () => {
  test("the tenant's price wins for its provider and model, and the row says so", () => {
    const own = block([
      { provider: "openai", model: "gpt-4o-mini", input: 0.1, output: 0.3 },
    ]);
    expect(
      priceCall("openai", "gpt-4o-mini", tokens(1_000, 100), AT, own),
    ).toEqual({
      costUsd: (1_000 * 0.1 + 100 * 0.3) / 1e6,
      priceTable: "tenant-override@2026-09-25T12:00:00.000Z",
    });
  });

  test("another model, or the same id on another provider, still prices from the table", () => {
    const own = block([
      { provider: "openrouter", model: "gpt-4o-mini", input: 9, output: 9 },
    ]);
    const r = priceCall("openai", "gpt-4o-mini", tokens(1_000, 100), AT, own);
    expect(r.priceTable).toBe(PRICE_TABLE_VERSION);
    expect(r.costUsd).toBe(
      callCostUsd("openai", "gpt-4o-mini", tokens(1_000, 100), AT),
    );
  });

  test("a server the table can never price is priced by the tenant's own rate", () => {
    const own = block([
      { provider: "openai-compatible", model: "", input: 0.05, output: 0.05 },
    ]);
    expect(
      priceCall("openai-compatible", "", tokens(2_000, 200), AT, own).costUsd,
    ).toBeCloseTo((2_000 * 0.05 + 200 * 0.05) / 1e6, 12);
  });

  test("the image reader's `gemini` finds a price saved under `google`", () => {
    const own = block([
      { provider: "google", model: "gemini-3.5-flash", input: 1, output: 2 },
    ]);
    expect(
      priceCall("gemini", "gemini-3.5-flash", tokens(1_000, 100), AT, own)
        .priceTable,
    ).toMatch(/^tenant-override@/);
  });

  // What the tenant says it pays is what it pays: the table's long-context tier and DeepSeek's
  // off-peak half are the list's rules, not the tenant's.
  test("a tenant's price is taken as stated, with no tier and no off-peak discount", () => {
    const own = block([
      { provider: "openai", model: "gpt-5.6-luna", input: 1, output: 1 },
      { provider: "deepseek", model: "deepseek-flash", input: 1, output: 1 },
    ]);
    expect(
      priceCall("openai", "gpt-5.6-luna", tokens(300_000, 0), AT, own).costUsd,
    ).toBeCloseTo(0.3, 12);
    const saturday = new Date("2026-09-26T12:00:00Z");
    expect(
      priceCall(
        "deepseek",
        "deepseek-flash",
        tokens(1_000_000, 0),
        saturday,
        own,
      ).costUsd,
    ).toBeCloseTo(1, 12);
  });

  // A cache rate the tenant left empty means no discount, never no price (verification of #865).
  test("a cache read or write on a tenant price with no cache rate is charged at its input rate", () => {
    const own = block([
      { provider: "openai", model: "gpt-4o-mini", input: 0.1, output: 0.3 },
    ]);
    expect(
      priceCall(
        "openai",
        "gpt-4o-mini",
        {
          ...tokens(1_000, 100),
          cachedReadTokens: 500,
          cacheCreationTokens: 200,
        },
        AT,
        own,
      ).costUsd,
    ).toBeCloseTo((1_000 * 0.1 + 100 * 0.3) / 1e6, 12);
  });
});

describe("the stored list", () => {
  test("the write refuses a repeated provider and model, naming the row", () => {
    const r = priceOverridesSchema.safeParse([
      { provider: "openai", model: "m", input: 1, output: 1 },
      { provider: "openai", model: "m", input: 2, output: 2 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([1, "model"]);
  });

  test("the write refuses an empty model except for an openai-compatible server", () => {
    const r = priceOverridesSchema.safeParse([
      { provider: "openai", model: "", input: 1, output: 1 },
    ]);
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual([0, "model"]);
    expect(
      priceOverridesSchema.safeParse([
        { provider: "openai-compatible", model: "", input: 1, output: 1 },
      ]).success,
    ).toBe(true);
  });

  test("the write refuses a negative or absurd rate", () => {
    for (const input of [-1, 10_001, Number.NaN]) {
      expect(
        priceOverridesSchema.safeParse([
          { provider: "openai", model: "m", input, output: 1 },
        ]).success,
      ).toBe(false);
    }
  });

  test("the reader keeps the good rows of a hand-edited bag and drops the rest", () => {
    const read = readPriceOverrides({
      priceOverrides: {
        updatedAt: "2026-09-25T00:00:00.000Z",
        overrides: [
          { provider: "openai", model: "a", input: 1, output: 1 },
          { provider: "nobody", model: "b", input: 1, output: 1 },
          { provider: "openai", model: "a", input: 5, output: 5 },
          "garbage",
        ],
      },
    });
    expect(read.overrides).toEqual([
      { provider: "openai", model: "a", input: 1, output: 1 },
    ]);
    expect(read.updatedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(readPriceOverrides({}).overrides).toEqual([]);
  });

  // A read that started before a save must not put the old list back after the save cleared it.
  test("a read in flight across a save does not refill the cache with the old list", async () => {
    const tenant = 876543n;
    let release: (b: PriceOverridesBlock) => void = () => {};
    const stale = cachedPriceOverrides(
      tenant,
      () =>
        new Promise<PriceOverridesBlock>((r) => {
          release = r;
        }),
      1_000,
    );
    forgetPriceOverrides(tenant);
    release(block([{ provider: "openai", model: "old", input: 9, output: 9 }]));
    await stale;
    let loads = 0;
    const fresh = await cachedPriceOverrides(
      tenant,
      async () => {
        loads += 1;
        return block([]);
      },
      2_000,
    );
    expect(loads).toBe(1);
    expect(fresh.overrides).toEqual([]);
    forgetPriceOverrides(tenant);
  });

  test("the cache answers from memory until it is told to forget", async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return block([]);
    };
    await cachedPriceOverrides(987654n, load, 1_000);
    await cachedPriceOverrides(987654n, load, 2_000);
    expect(loads).toBe(1);
    // Past the TTL, a write that reached the row some other way is picked up.
    await cachedPriceOverrides(987654n, load, 1_000 + 61_000);
    expect(loads).toBe(2);
    forgetPriceOverrides(987654n);
    await cachedPriceOverrides(987654n, load, 1_000 + 61_001);
    expect(loads).toBe(3);
  });
});

// Through the real settings row and the real capture: a save applies from the next call, and the
// ledger row carries the tenant's price and says so.
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
const ctx = (): TenantContext => ({
  tenantId,
  userId: null,
  role: "TENANT_ADMIN",
});

function llmResult(input: number, output: number): LLMResult {
  return {
    generations: [
      [
        {
          text: "ok",
          message: {
            usage_metadata: {
              input_tokens: input,
              output_tokens: output,
              total_tokens: input + output,
            },
          },
        } as never,
      ],
    ],
  };
}

describe.skipIf(!dbUp)("a saved price prices the next call", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "p865", slug: `p865-${process.pid}` },
    });
    tenantId = t.id;
  });
  afterAll(async () => {
    await suDb.$executeRaw`DELETE FROM llm_usage WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`;
    await suDb.$executeRaw`DELETE FROM tenants WHERE id = ${tenantId}`;
    await su?.$disconnect();
    await app?.$disconnect();
  });

  const capture = () =>
    new UsageCapture({
      tenantId,
      threadId: `${tenantId}:1:865`,
      provider: "openai",
      model: "gpt-4o-mini",
      base: appDb,
    });

  test("before a save the table prices it; after, the tenant's price, from the very next call", async () => {
    const thread = `${tenantId}:1:865`;
    const before = await sumTurnUsage(thread, async () => {
      await capture().handleLLMEnd(llmResult(1_000, 100), "r1");
    });
    expect(before.usage.tenantPricedCalls).toBe(0);
    expect(before.usage.costUsd).toBeCloseTo(
      (1_000 * 0.15 + 100 * 0.6) / 1e6,
      12,
    );

    const saved = await updatePriceOverrides(
      ctx(),
      [{ provider: "openai", model: "gpt-4o-mini", input: 0.1, output: 0.2 }],
      appDb,
    );
    expect(saved.updatedAt).not.toBeNull();
    // Read back through the settings the console loads.
    expect((await getTenantSettings(ctx(), appDb)).priceOverrides).toEqual(
      saved,
    );

    const after = await sumTurnUsage(thread, async () => {
      await capture().handleLLMEnd(llmResult(1_000, 100), "r2");
    });
    expect(after.usage.tenantPricedCalls).toBe(1);
    expect(after.usage.costUsd).toBeCloseTo(
      (1_000 * 0.1 + 100 * 0.2) / 1e6,
      12,
    );

    const rows = await suDb.llmUsage.findMany({
      where: { tenantId },
      orderBy: { id: "asc" },
      select: { costUsd: true, priceTable: true },
    });
    expect(rows.map((r) => r.priceTable)).toEqual([
      PRICE_TABLE_VERSION,
      `tenant-override@${saved.updatedAt}`,
    ]);
    expect(Number(rows[1]?.costUsd)).toBeCloseTo(
      (1_000 * 0.1 + 100 * 0.2) / 1e6,
      12,
    );
  });

  test("a bad list is refused with the row it came from, and nothing is saved", async () => {
    const before = (await getTenantSettings(ctx(), appDb)).priceOverrides;
    await expect(
      updatePriceOverrides(
        ctx(),
        [
          { provider: "openai", model: "x", input: 1, output: 1 },
          { provider: "openai", model: "x", input: 2, output: 2 },
        ],
        appDb,
      ),
    ).rejects.toMatchObject({
      statusCode: 422,
      translationParams: { row: 2 },
    });
    expect((await getTenantSettings(ctx(), appDb)).priceOverrides).toEqual(
      before,
    );
  });

  test("the save is on the audit trail with the prices on both sides", async () => {
    await suDb.$executeRaw`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}`;
    await updatePriceOverrides(
      ctx(),
      [
        {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          input: 2,
          output: 10,
        },
      ],
      appDb,
    );
    const rows = await suDb.auditLog.findMany({
      where: { tenantId, action: "tenant_settings.price_overrides_set" },
      select: { before: true, after: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.before).toEqual([
      { provider: "openai", model: "gpt-4o-mini", input: 0.1, output: 0.2 },
    ]);
    expect(rows[0]?.after).toEqual([
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        input: 2,
        output: 10,
      },
    ]);
  });

  // The MCP tools read and write the same list, with the same validation (issue #865).
  test("over MCP: a preview writes nothing, an apply saves, the read returns it, and a bad list is refused alike", async () => {
    const token = (scopes: string[]): VerifiedToken => ({
      userId: null as unknown as bigint,
      tenantId,
      role: "TENANT_ADMIN",
      scopes,
      clientId: "c865",
      jti: "j865",
    });
    const rw = token(["mcp:read", "mcp:write"]);
    const before = (await getTenantSettings(ctx(), appDb)).priceOverrides;
    const list = [
      {
        provider: "openai" as const,
        model: "gpt-4o",
        input: 2,
        output: 8,
        cached_input: 1,
      },
    ];
    const preview = await tenantSettingsUpdate(
      rw,
      { price_overrides: list },
      { base: appDb },
    );
    expect(preview.ok).toBe(true);
    expect((await getTenantSettings(ctx(), appDb)).priceOverrides).toEqual(
      before,
    );
    const applied = await tenantSettingsUpdate(
      rw,
      { price_overrides: list, dry_run: false },
      { base: appDb },
    );
    expect(applied.ok).toBe(true);
    const read = await tenantSettingsGet(token(["mcp:read"]), { base: appDb });
    expect(read.ok).toBe(true);
    if (read.ok)
      expect(
        (read.data.settings as { priceOverrides: PriceOverridesBlock })
          .priceOverrides.overrides,
      ).toEqual([
        {
          provider: "openai",
          model: "gpt-4o",
          input: 2,
          output: 8,
          cachedInput: 1,
        },
      ]);
    for (const dry_run of [true, false]) {
      const bad = await tenantSettingsUpdate(
        rw,
        {
          price_overrides: [{ ...list[0], input: -1 }] as typeof list,
          dry_run,
        },
        { base: appDb },
      );
      expect(bad.ok).toBe(false);
      if (!bad.ok)
        expect(bad.error).toContain("price row 1 is not valid: input:");
    }
    // A bad list refuses the whole call: the other block in it is not written either.
    const lfBefore = (await getTenantSettings(ctx(), appDb)).langfuse;
    const mixed = await tenantSettingsUpdate(
      rw,
      {
        langfuse: { send_content: !lfBefore.sendContent },
        price_overrides: [{ ...list[0], input: -1 }] as typeof list,
        dry_run: false,
      },
      { base: appDb },
    );
    expect(mixed.ok).toBe(false);
    expect((await getTenantSettings(ctx(), appDb)).langfuse).toEqual(lfBefore);
    const readOnly = await tenantSettingsUpdate(
      token(["mcp:read"]),
      { price_overrides: [], dry_run: false },
      { base: appDb },
    );
    expect(readOnly.ok).toBe(false);
    expect(
      (await getTenantSettings(ctx(), appDb)).priceOverrides.overrides,
    ).toHaveLength(1);
  });
});
