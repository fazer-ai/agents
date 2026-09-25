import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import { asSuperAdminOn } from "@/lib/tenancy";
import { type PriceOverridesBlock, readPriceOverrides } from "./overrides";
import { callCostUsd, type PricedTokens, priceCall } from "./price";
import { PRICE_TABLE_VERSION } from "./version";

// RE-PRICING LEDGER ROWS when the table that priced them was wrong (issue #867). A row's cost is
// written once, from the table in force then (#863), and every row keeps its four token counts and
// the name of that table, so it can be priced again from the table in the tree now. The operator runs
// it through `scripts/reprice-usage.ts`; this module is the part that decides and writes, so it is
// testable without spawning the script.
//
// THE PROVIDER IS THE OPERATOR'S TO NAME. `llm_usage` stores the model and not the provider that
// answered, and the table cannot be asked which provider a model id belongs to: `callCostUsd` looks a
// bare id up for openai, anthropic AND deepseek alike, so `deepseek-chat` prices under `openai` (at
// the peak rate, with no off-peak half) and `gpt-4o` prices under `deepseek` (at OpenAI's rate, halved
// off-peak), and an `openai-compatible` server serving either id has no price at all. Guessing would
// write a confident, wrong figure, which is the thing this command exists to undo. So the run names
// one provider and one model, and the provider only decides how the rows of that model are priced:
// it filters nothing, because there is nothing on the row to filter it by.
//
// Three rules the writes keep:
// - a row the table cannot price now is left exactly as it was and counted, so a priced row never
//   becomes `null` and a `null` never becomes zero;
// - each row is priced at its own `created_at`, because DeepSeek's rate depends on the hour;
// - only a row whose figure CHANGES is written, and it is stamped with what priced it now. A row
//   priced to the same figure keeps its stamp: whatever priced it then priced it right.
//
// Rows nothing priced (written before the column, `price_table` null) are left out unless the run
// asks for them with `priceTable: null`: their token counts predate fixes to how the capture reads
// them, and the screens promise those rows stay unpriced rather than half-priced.
//
// EACH ROW IS PRICED AS THE CAPTURE WOULD PRICE IT NOW, in the capture's order: the tenant's own
// price for the model (issue #865) first, saved after the fact included, which is one of the two
// reasons this exists; then, for a row OpenRouter reported (`openrouter:reported`, issue #866), the
// figure OpenRouter charged, which the table never replaces; then the table.

export type PriceFn = (
  provider: string,
  model: string,
  tokens: PricedTokens,
  at: Date,
) => number | null;

export interface LedgerRow {
  id: bigint;
  tenantId: bigint;
  model: string;
  priceTable: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedReadTokens: number;
  cacheCreationTokens: number;
  costUsd: Prisma.Decimal | null;
  createdAt: Date;
}

export interface RepriceGroup {
  tenantId: bigint;
  model: string;
  matched: number;
  // Rows whose figure the current table changes (a `null` it can now price included).
  changed: number;
  unchanged: number;
  // Rows the current table cannot price; left as they were.
  unpriceable: number;
  beforeUsd: Prisma.Decimal;
  afterUsd: Prisma.Decimal;
  unpricedBefore: number;
  unpricedAfter: number;
}

export interface RepriceUpdate {
  id: bigint;
  costUsd: string;
  // What priced it now: the table's version or the tenant's override.
  priceTable: string;
}

// What a row costs now, and what priced it; a null cost is "cannot be priced now".
export type RowPricer = (row: LedgerRow) => {
  costUsd: number | null;
  priceTable: string;
};

const REPORTED = "openrouter:reported";

// The capture's order for one provider, given each tenant's saved prices.
export function capturePricer(
  provider: string,
  overridesOf: (tenantId: bigint) => PriceOverridesBlock | null,
): RowPricer {
  return (row) =>
    priceCall(
      provider,
      row.model,
      {
        promptTokens: row.promptTokens,
        cachedReadTokens: row.cachedReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        completionTokens: row.completionTokens,
      },
      row.createdAt,
      overridesOf(row.tenantId),
    );
}

// A bare table function priced as the table, stamped with `stamp`: what tests pass to pin a table.
export function tablePricer(
  provider: string,
  stamp: string,
  price: PriceFn = callCostUsd,
): RowPricer {
  return (row) => ({
    costUsd: price(
      provider,
      row.model,
      {
        promptTokens: row.promptTokens,
        cachedReadTokens: row.cachedReadTokens,
        cacheCreationTokens: row.cacheCreationTokens,
        completionTokens: row.completionTokens,
      },
      row.createdAt,
    ),
    priceTable: stamp,
  });
}

// The column's scale: a figure that rounds to what is stored is not a change.
const SCALE = 10;

function groupFor(
  groups: Map<string, RepriceGroup>,
  row: LedgerRow,
): RepriceGroup {
  const key = `${row.tenantId}:${row.model}`;
  let g = groups.get(key);
  if (!g) {
    g = {
      tenantId: row.tenantId,
      model: row.model,
      matched: 0,
      changed: 0,
      unchanged: 0,
      unpriceable: 0,
      beforeUsd: new Prisma.Decimal(0),
      afterUsd: new Prisma.Decimal(0),
      unpricedBefore: 0,
      unpricedAfter: 0,
    };
    groups.set(key, g);
  }
  return g;
}

// Pure: what the current table makes of these rows, and the writes that follows from it. `groups`
// accumulates across batches.
export function planReprice(
  rows: LedgerRow[],
  pricer: RowPricer,
  groups: Map<string, RepriceGroup> = new Map(),
): { groups: Map<string, RepriceGroup>; updates: RepriceUpdate[] } {
  const updates: RepriceUpdate[] = [];
  for (const row of rows) {
    const g = groupFor(groups, row);
    g.matched += 1;
    const before = row.costUsd;
    if (before === null) g.unpricedBefore += 1;
    else g.beforeUsd = g.beforeUsd.plus(before);

    const now = pricer(row);
    // What OpenRouter charged stands unless the tenant's own price now comes first.
    if (
      row.priceTable === REPORTED &&
      !now.priceTable.startsWith("tenant-override@")
    ) {
      g.unchanged += 1;
      if (before === null) g.unpricedAfter += 1;
      else g.afterUsd = g.afterUsd.plus(before);
      continue;
    }
    const fresh = now.costUsd;
    if (fresh === null) {
      g.unpriceable += 1;
      if (before === null) g.unpricedAfter += 1;
      else g.afterUsd = g.afterUsd.plus(before);
      continue;
    }
    const after = new Prisma.Decimal(fresh).toDecimalPlaces(SCALE);
    g.afterUsd = g.afterUsd.plus(after);
    if (before !== null && after.equals(before)) {
      g.unchanged += 1;
      continue;
    }
    g.changed += 1;
    updates.push({
      id: row.id,
      costUsd: after.toFixed(SCALE),
      priceTable: now.priceTable,
    });
  }
  return { groups, updates };
}

export interface RepriceOptions {
  tenant: bigint | "all";
  provider: string;
  model: string;
  // `from` inclusive, `to` exclusive.
  from?: Date;
  to?: Date;
  // A stamp (`litellm@…`, `tenant-override@…`, `openrouter:reported`) targets the rows it wrote;
  // `null` targets the rows nothing priced; absent is every row something priced.
  priceTable?: string | null;
  apply: boolean;
  batchSize?: number;
  // Overridable for tests: a table function and its stamp, which replace the capture's order.
  stamp?: string;
  price?: PriceFn;
}

export interface RepriceReport {
  groups: RepriceGroup[];
  written: number;
  applied: boolean;
}

type TransactionCapable = Pick<PrismaClient, "$extends" | "$transaction">;

function rowFilter(opts: RepriceOptions): Prisma.LlmUsageWhereInput {
  const createdAt: Prisma.DateTimeFilter = {};
  if (opts.from) createdAt.gte = opts.from;
  if (opts.to) createdAt.lt = opts.to;
  return {
    model: opts.model,
    ...(opts.tenant === "all" ? {} : { tenantId: opts.tenant }),
    ...(opts.from || opts.to ? { createdAt } : {}),
    priceTable: opts.priceTable === undefined ? { not: null } : opts.priceTable,
  };
}

// Walks the matching rows in id order, one batch per transaction, and in `apply` writes each batch's
// changes in the same transaction it read them in. The rows span tenants, so each batch runs as the
// fleet role (`asSuperAdminOn`), the one path RLS lets see every tenant: on the superuser connection
// the scripts use it changes nothing, and on the runtime role it is what makes the rows visible
// instead of silently answering none.
export async function runReprice(
  base: TransactionCapable,
  opts: RepriceOptions,
): Promise<RepriceReport> {
  const batchSize = opts.batchSize ?? 1000;
  const where = rowFilter(opts);
  // Each tenant's saved prices, read once per run.
  const overrides = new Map<bigint, PriceOverridesBlock>();
  const groups = new Map<string, RepriceGroup>();
  let cursor = 0n;
  let written = 0;
  for (;;) {
    const read = await asSuperAdminOn(base, async (db) => {
      const rows = await db.llmUsage.findMany({
        where: { ...where, id: { gt: cursor } },
        orderBy: { id: "asc" },
        take: batchSize,
        select: {
          id: true,
          tenantId: true,
          model: true,
          promptTokens: true,
          completionTokens: true,
          cachedReadTokens: true,
          cacheCreationTokens: true,
          costUsd: true,
          priceTable: true,
          createdAt: true,
        },
      });
      const unseen = [
        ...new Set(
          rows.map((r) => r.tenantId).filter((t) => !overrides.has(t)),
        ),
      ];
      if (unseen.length > 0) {
        const tenants = await db.tenant.findMany({
          where: { id: { in: unseen } },
          select: { id: true, settings: true },
        });
        for (const t of unseen) {
          const settings = tenants.find((x) => x.id === t)?.settings;
          overrides.set(
            t,
            readPriceOverrides(
              typeof settings === "object" && settings !== null
                ? (settings as Record<string, unknown>)
                : {},
            ),
          );
        }
      }
      const pricer = opts.price
        ? tablePricer(
            opts.provider,
            opts.stamp ?? PRICE_TABLE_VERSION,
            opts.price,
          )
        : capturePricer(opts.provider, (t) => overrides.get(t) ?? null);
      const { updates } = planReprice(rows, pricer, groups);
      if (opts.apply && updates.length > 0) {
        await db.$executeRaw`
          UPDATE llm_usage AS u
             SET cost_usd = v.cost::numeric, price_table = v.stamp
            FROM unnest(${updates.map((u) => u.id.toString())}::text[],
                        ${updates.map((u) => u.costUsd)}::text[],
                        ${updates.map((u) => u.priceTable)}::text[]) AS v(id, cost, stamp)
           WHERE u.id = v.id::bigint`;
      }
      return { rows, updates: updates.length };
    });
    if (opts.apply) written += read.updates;
    const last = read.rows.at(-1);
    if (!last || read.rows.length < batchSize) break;
    cursor = last.id;
  }
  return {
    groups: [...groups.values()].sort((a, b) =>
      a.tenantId === b.tenantId
        ? a.model.localeCompare(b.model)
        : a.tenantId < b.tenantId
          ? -1
          : 1,
    ),
    written,
    applied: opts.apply,
  };
}
