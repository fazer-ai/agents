import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { listConversations } from "@/modules/conversations/service";

const tenant: TenantContext = {
  tenantId: 1n,
  userId: null,
  role: "TENANT_ADMIN",
};

interface FakeDb {
  $extends(): FakeDb;
  $transaction<T>(fn: (tx: FakeDb) => Promise<T>): Promise<T>;
  $executeRaw(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<number>;
  conversation: {
    findMany(args: { where: unknown }): Promise<never[]>;
  };
}

function capturingDb() {
  let capturedWhere: unknown;
  const fake: FakeDb = {
    $extends() {
      return fake;
    },
    async $transaction<T>(fn: (tx: typeof fake) => Promise<T>) {
      return fn(fake);
    },
    async $executeRaw() {
      return 1;
    },
    conversation: {
      async findMany(args: { where: unknown }) {
        capturedWhere = args.where;
        return [];
      },
    },
  };
  return {
    db: fake as unknown as PrismaClient,
    capturedWhere: () => capturedWhere,
  };
}

describe("listConversations group projection", () => {
  test("includes groups by default", async () => {
    const capture = capturingDb();
    await listConversations(tenant, {}, capture.db);
    expect(capture.capturedWhere()).toEqual({});
  });

  test("filters groups before querying when requested", async () => {
    const capture = capturingDb();
    await listConversations(tenant, { excludeGroups: true }, capture.db);
    expect(capture.capturedWhere()).toEqual({ isGroup: false });
  });
});
