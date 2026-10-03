import { describe, expect, test } from "bun:test";
import type {
  MerchantOrderStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import {
  ConflictError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { updateMerchantOrderStatus } from "@/modules/merchant/orders";

// updateMerchantOrderStatus enforces the documented lifecycle
// (DRAFT -> CONFIRMED -> PAID, CANCELLED from an open stage) and writes the
// transition compare-and-set style, so the fake's updateMany honors the
// `status = before` clause and the race path is exercised for real.

const ctx: TenantContext = { tenantId: 7n, userId: 3n, role: "TENANT_ADMIN" };

interface FakeOrder {
  id: bigint;
  tenantId: bigint;
  leadId: bigint | null;
  contactName: string | null;
  contactPhone: string | null;
  contactAddress: string | null;
  status: MerchantOrderStatus;
  totalAmount: number;
  note: string | null;
  createdAt: Date;
}

function seedOrder(over: Partial<FakeOrder> = {}): FakeOrder {
  return {
    id: 5n,
    tenantId: 7n,
    leadId: null,
    contactName: "Chị Lan",
    contactPhone: null,
    contactAddress: null,
    status: "DRAFT",
    totalAmount: 289000,
    note: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function fakeDb(
  seed: FakeOrder[] = [],
  hooks: { afterFirstFind?: () => void } = {},
) {
  const store = [...seed];
  const audits: {
    action: string;
    target: string | null;
    before: unknown;
    after: unknown;
  }[] = [];
  let finds = 0;
  const asRow = (o: FakeOrder) => ({
    ...o,
    lead: null,
    items: [
      {
        id: 1n,
        productId: null,
        qty: 1,
        unitPrice: { toString: () => String(o.totalAmount) },
        product: null,
      },
    ],
  });
  const tx = {
    $executeRaw: async () => 0,
    auditLog: {
      create: async ({
        data,
      }: {
        data: {
          action: string;
          target: string | null;
          before: unknown;
          after: unknown;
        };
      }) => {
        audits.push(data);
        return {};
      },
    },
    merchantOrder: {
      findUnique: async ({ where }: { where: { id: bigint } }) => {
        const row = store.find((r) => r.id === where.id);
        const out = row ? asRow(row) : null;
        if (finds++ === 0) hooks.afterFirstFind?.();
        return out;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: bigint } }) => {
        const row = store.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        return asRow(row);
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: bigint; status: MerchantOrderStatus };
        data: { status: MerchantOrderStatus };
      }) => {
        const row = store.find(
          (r) => r.id === where.id && r.status === where.status,
        );
        if (!row) return { count: 0 };
        row.status = data.status;
        return { count: 1 };
      },
    },
  };
  // runScopedOn only needs $extends + $transaction on the base client.
  const base = {
    $extends: () => ({ $transaction: (fn: (t: unknown) => unknown) => fn(tx) }),
  } as unknown as PrismaClient;
  return { base, store, audits };
}

describe("updateMerchantOrderStatus", () => {
  test("walks DRAFT -> CONFIRMED -> PAID and audits each move", async () => {
    const { base, store, audits } = fakeDb([seedOrder({ id: 5n })]);
    const confirmed = await updateMerchantOrderStatus(
      ctx,
      5n,
      { status: "CONFIRMED" },
      base,
    );
    expect(confirmed.status).toBe("CONFIRMED");
    const paid = await updateMerchantOrderStatus(
      ctx,
      5n,
      { status: "PAID" },
      base,
    );
    expect(paid.status).toBe("PAID");
    expect(store[0]?.status).toBe("PAID");
    expect(audits.map((a) => a.after)).toEqual([
      { status: "CONFIRMED" },
      { status: "PAID" },
    ]);
    expect(audits[0]?.action).toBe("merchant_order.update");
    expect(audits[0]?.target).toBe("merchant_order:5");
  });

  test("CANCELLED is reachable from either open stage", async () => {
    const { base } = fakeDb([seedOrder({ id: 5n, status: "DRAFT" })]);
    const draft = await updateMerchantOrderStatus(
      ctx,
      5n,
      { status: "CANCELLED" },
      base,
    );
    expect(draft.status).toBe("CANCELLED");

    const { base: base2 } = fakeDb([
      seedOrder({ id: 6n, status: "CONFIRMED" }),
    ]);
    const confirmed = await updateMerchantOrderStatus(
      ctx,
      6n,
      { status: "CANCELLED" },
      base2,
    );
    expect(confirmed.status).toBe("CANCELLED");
  });

  test("illegal jumps and terminal states answer 409", async () => {
    const { base } = fakeDb([seedOrder({ id: 5n, status: "DRAFT" })]);
    // DRAFT -> PAID skips a stage.
    await expect(
      updateMerchantOrderStatus(ctx, 5n, { status: "PAID" }, base),
    ).rejects.toBeInstanceOf(ConflictError);

    const { base: paid } = fakeDb([seedOrder({ id: 6n, status: "PAID" })]);
    // PAID is terminal: even PAID -> CANCELLED is refused.
    await expect(
      updateMerchantOrderStatus(ctx, 6n, { status: "CANCELLED" }, paid),
    ).rejects.toBeInstanceOf(ConflictError);
    await expect(
      updateMerchantOrderStatus(ctx, 6n, { status: "DRAFT" }, paid),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  test("a concurrent move surfaces as the race conflict, not a silent overwrite", async () => {
    // The row flips to CONFIRMED between the pre-read and the CAS write -
    // exactly what `where status = before` is for.
    const { base, store } = fakeDb([seedOrder({ id: 5n })], {
      afterFirstFind: () => {
        const row = store.at(0);
        if (!row) throw new Error("seed order missing");
        row.status = "CONFIRMED";
      },
    });
    await expect(
      updateMerchantOrderStatus(ctx, 5n, { status: "CANCELLED" }, base),
    ).rejects.toMatchObject({
      statusCode: 409,
      translationKey: "errors.merchantOrderRace",
    });
    // The concurrent write won; nothing overwrote it.
    expect(store[0]?.status).toBe("CONFIRMED");
  });

  test("a missing order throws NotFoundError; a fleet context is refused", async () => {
    const { base, audits } = fakeDb();
    await expect(
      updateMerchantOrderStatus(ctx, 99n, { status: "CONFIRMED" }, base),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(audits).toHaveLength(0);

    await expect(
      updateMerchantOrderStatus(
        { tenantId: null, userId: 3n, role: "TENANT_ADMIN" },
        5n,
        { status: "CONFIRMED" },
        base,
      ),
    ).rejects.toBeInstanceOf(TenantTargetRequiredError);
  });
});
