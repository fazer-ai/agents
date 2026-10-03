import { describe, expect, test } from "bun:test";
import type {
  MerchantLeadStatus,
  PrismaClient,
} from "@/../generated/prisma/client";
import { NotFoundError, TenantTargetRequiredError } from "@/lib/errors";
import type { TenantContext } from "@/lib/tenancy";
import { updateLeadStatus } from "@/modules/merchant/leads";

// updateLeadStatus is the operator's funnel-stage call: any enum value is a
// legal target, the write re-reads the row first for the audit's `before`, and
// the trail lands in the same transaction.

const ctx: TenantContext = { tenantId: 7n, userId: 3n, role: "TENANT_ADMIN" };

interface FakeLead {
  id: bigint;
  tenantId: bigint;
  platform: string;
  authorName: string;
  authorHandle: string | null;
  text: string;
  sourceUrl: string | null;
  groupName: string | null;
  score: number;
  status: MerchantLeadStatus;
  sourceId: bigint | null;
  externalId: string | null;
  createdAt: Date;
}

function seedLead(over: Partial<FakeLead> = {}): FakeLead {
  return {
    id: 5n,
    tenantId: 7n,
    platform: "facebook",
    authorName: "Chị Lan",
    authorHandle: "@lan",
    text: "Còn serum này không shop?",
    sourceUrl: null,
    groupName: null,
    score: 72,
    status: "NEW",
    sourceId: null,
    externalId: null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...over,
  };
}

function fakeDb(seed: FakeLead[] = []) {
  const store = [...seed];
  const audits: {
    action: string;
    target: string | null;
    before: unknown;
    after: unknown;
  }[] = [];
  const asRow = (l: FakeLead) => ({
    ...l,
    source: null,
    matches: [] as never[],
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
    lead: {
      findUnique: async ({ where }: { where: { id: bigint } }) => {
        const row = store.find((r) => r.id === where.id);
        return row ? asRow(row) : null;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: bigint };
        data: { status: MerchantLeadStatus };
      }) => {
        const row = store.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        row.status = data.status;
        return asRow(row);
      },
    },
  };
  // runScopedOn only needs $extends + $transaction on the base client.
  const base = {
    $extends: () => ({ $transaction: (fn: (t: unknown) => unknown) => fn(tx) }),
  } as unknown as PrismaClient;
  return { base, store, audits };
}

describe("updateLeadStatus", () => {
  test("moves a lead to any stage and returns the hydrated dto", async () => {
    const { base, store } = fakeDb([seedLead({ id: 5n })]);
    for (const status of [
      "CONTACTED",
      "QUALIFIED",
      "CONVERTED",
      "DEAD",
    ] as const) {
      const dto = await updateLeadStatus(ctx, 5n, { status }, base);
      expect(dto.status).toBe(status);
      expect(dto.id).toBe("5");
      expect(store[0]?.status).toBe(status);
    }
  });

  test("audits the before/after status on lead:<id>", async () => {
    const { base, audits } = fakeDb([
      seedLead({ id: 9n, status: "CONTACTED" }),
    ]);
    await updateLeadStatus(ctx, 9n, { status: "QUALIFIED" }, base);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      action: "merchant_lead.update",
      target: "lead:9",
      before: { status: "CONTACTED" },
      after: { status: "QUALIFIED" },
    });
  });

  test("throws NotFoundError for a missing lead and writes nothing", async () => {
    const { base, audits } = fakeDb();
    await expect(
      updateLeadStatus(ctx, 99n, { status: "DEAD" }, base),
    ).rejects.toBeInstanceOf(NotFoundError);
    expect(audits).toHaveLength(0);
  });

  test("a fleet context (tenantId null) is refused before any parse", async () => {
    const { base } = fakeDb([seedLead({ id: 5n })]);
    await expect(
      updateLeadStatus(
        { tenantId: null, userId: 3n, role: "TENANT_ADMIN" },
        5n,
        { status: "DEAD" },
        base,
      ),
    ).rejects.toBeInstanceOf(TenantTargetRequiredError);
  });

  test("a non-enum status is a parse error, not a write", async () => {
    const { base, store } = fakeDb([seedLead({ id: 5n })]);
    await expect(
      updateLeadStatus(
        ctx,
        5n,
        { status: "BOGUS" as MerchantLeadStatus },
        base,
      ),
    ).rejects.toThrow();
    expect(store[0]?.status).toBe("NEW");
  });
});
