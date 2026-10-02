import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  BROADCAST_AUDIENCE_CAP,
  createBroadcast,
  getBroadcast,
  listBroadcasts,
  renderBroadcastBody,
  sendBroadcast,
  updateBroadcast,
} from "@/modules/funnel/broadcasts";
import { setRecipientStatus } from "@/modules/funnel/recipients";

// The broadcast rail is a composer + a manual-send ledger: create resolves the
// audience filter ONCE into rendered recipient rows, edits re-render only the
// still-PENDING ones and knock READY back to DRAFT, and "send" marks rows -
// never posts. The fake tx records mutations so the audience resolution and
// the ledgers are checkable without a database.

const ctx: TenantContext = { tenantId: 7n, userId: 3n, role: "TENANT_ADMIN" };

interface FakeLead {
  id: bigint;
  tenantId: bigint;
  authorName: string;
  authorHandle: string | null;
  platform: string;
  groupName: string | null;
  score: number;
  status: string;
  productTags: string[];
}

interface FakeRecipient {
  id: bigint;
  tenantId: bigint;
  broadcastId: bigint;
  leadId: bigint;
  body: string;
  status: string;
  error: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

interface FakeBroadcast {
  id: bigint;
  tenantId: bigint;
  name: string;
  body: string;
  audienceFilter: unknown;
  status: string;
  sentCount: number;
  sentAt: Date | null;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

function decorate(
  broadcast: FakeBroadcast,
  recipients: FakeRecipient[],
  leads: FakeLead[],
) {
  const rs = recipients
    .filter((r) => r.broadcastId === broadcast.id)
    .sort((a, b) => Number(a.id - b.id))
    .map((r) => {
      const lead = leads.find((l) => l.id === r.leadId);
      return { ...r, lead };
    });
  return { ...broadcast, _count: { recipients: rs.length }, recipients: rs };
}

function fakeDb(
  seedLeads: FakeLead[] = [],
  seedBroadcasts: FakeBroadcast[] = [],
  seedRecipients: FakeRecipient[] = [],
) {
  const leads = [...seedLeads];
  const broadcasts = [...seedBroadcasts];
  const recipients = [...seedRecipients];
  const audits: { action: string; target: string }[] = [];
  let nextBroadcastId = 200n;
  let nextRecipientId = 300n;
  const tx = {
    $executeRaw: async () => 0,
    auditLog: {
      create: async ({
        data,
      }: {
        data: { action: string; target: string };
      }) => {
        audits.push({ action: data.action, target: data.target });
        return {};
      },
    },
    lead: {
      findMany: async ({
        where,
        take,
      }: {
        where?: {
          status?: { in: string[] };
          score?: { gte: number };
          matches?: { some: { product: { tags: { hasSome: string[] } } } };
          id?: { in: bigint[] };
        };
        take?: number;
      }) => {
        let rows = leads;
        if (where?.id?.in)
          rows = rows.filter((l) => where.id?.in.includes(l.id));
        if (where?.status?.in)
          rows = rows.filter((l) => where.status?.in.includes(l.status));
        if (where?.score?.gte !== undefined)
          rows = rows.filter((l) => l.score >= (where.score?.gte ?? 0));
        const tags = where?.matches?.some.product.tags.hasSome;
        if (tags)
          rows = rows.filter((l) =>
            l.productTags.some((t) => tags.includes(t)),
          );
        rows = [...rows].sort(
          (a, b) => b.score - a.score || Number(b.id - a.id),
        );
        if (take) rows = rows.slice(0, take);
        return rows;
      },
    },
    broadcast: {
      create: async ({ data }: { data: Partial<FakeBroadcast> }) => {
        const row: FakeBroadcast = {
          id: nextBroadcastId++,
          tenantId: data.tenantId ?? 7n,
          name: data.name ?? "",
          body: data.body ?? "",
          audienceFilter: data.audienceFilter ?? {},
          status: "DRAFT",
          sentCount: 0,
          sentAt: null,
          createdBy: data.createdBy ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        broadcasts.push(row);
        return row;
      },
      findUnique: async ({ where }: { where: { id: bigint } }) => {
        const row = broadcasts.find((b) => b.id === where.id);
        return row ? decorate(row, recipients, leads) : null;
      },
      findUniqueOrThrow: async ({ where }: { where: { id: bigint } }) => {
        const row = broadcasts.find((b) => b.id === where.id);
        if (!row) throw new Error("not found");
        return decorate(row, recipients, leads);
      },
      findMany: async ({ take }: { take?: number }) => {
        const rows = [...broadcasts].sort((a, b) => Number(b.id - a.id));
        return (take ? rows.slice(0, take) : rows).map((b) =>
          decorate(b, recipients, leads),
        );
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: bigint };
        data: Partial<FakeBroadcast>;
      }) => {
        const row = broadcasts.find((b) => b.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
    },
    broadcastRecipient: {
      createMany: async ({ data }: { data: Partial<FakeRecipient>[] }) => {
        for (const d of data) {
          recipients.push({
            id: nextRecipientId++,
            tenantId: d.tenantId ?? 7n,
            broadcastId: d.broadcastId ?? 0n,
            leadId: d.leadId ?? 0n,
            body: d.body ?? "",
            status: "PENDING",
            error: null,
            sentAt: null,
            createdAt: new Date(),
          });
        }
        return { count: data.length };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { broadcastId: bigint; status?: string };
        data: { status: string; sentAt?: Date };
      }) => {
        let count = 0;
        for (const r of recipients) {
          if (
            r.broadcastId === where.broadcastId &&
            (!where.status || r.status === where.status)
          ) {
            Object.assign(r, data);
            count++;
          }
        }
        return { count };
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: bigint };
        data: Partial<FakeRecipient>;
      }) => {
        const row = recipients.find((r) => r.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
    },
  };
  const base = {
    $extends: () => ({ $transaction: (fn: (t: unknown) => unknown) => fn(tx) }),
  } as unknown as PrismaClient;
  return { base, leads, broadcasts, recipients, audits };
}

function seedLead(over: Partial<FakeLead> = {}): FakeLead {
  return {
    id: 11n,
    tenantId: 7n,
    authorName: "Nguyễn Thảo",
    authorHandle: "@thao",
    platform: "facebook",
    groupName: "Hội mỹ phẩm",
    score: 80,
    status: "NEW",
    productTags: ["serum"],
    ...over,
  };
}

describe("renderBroadcastBody", () => {
  test("resolves the lead tokens and leaves unknown tokens alone", () => {
    const out = renderBroadcastBody(
      "Chào {{authorName}} ({{authorHandle}}) trên {{platform}} nhóm {{groupName}} {{unknown}}",
      seedLead(),
    );
    expect(out).toBe(
      "Chào Nguyễn Thảo (@thao) trên facebook nhóm Hội mỹ phẩm {{unknown}}",
    );
  });

  test("a token with no value renders empty, not a literal", () => {
    const out = renderBroadcastBody("Hi {{authorHandle}}!", {
      ...seedLead(),
      authorHandle: null,
    });
    expect(out).toBe("Hi !");
  });
});

describe("createBroadcast", () => {
  test("resolves the default active-funnel audience and renders per-recipient bodies", async () => {
    const { base, recipients, audits } = fakeDb([
      seedLead({ id: 11n, status: "NEW", score: 80 }),
      seedLead({ id: 12n, status: "CONTACTED", score: 60, authorName: "B" }),
      seedLead({ id: 13n, status: "DEAD", score: 99, authorName: "C" }),
      seedLead({ id: 14n, status: "CONVERTED", score: 99, authorName: "D" }),
    ]);
    const dto = await createBroadcast(
      ctx,
      { name: "Promo", body: "Chào {{authorName}}" },
      base,
    );
    // DEAD + CONVERTED are out of the default audience: reaching them has to
    // be named, or the rail is a spam cannon.
    expect(dto.recipientCount).toBe(2);
    expect(recipients.map((r) => r.leadId).sort()).toEqual([11n, 12n]);
    expect(dto.recipients?.map((r) => r.body)).toEqual([
      "Chào Nguyễn Thảo",
      "Chào B",
    ]);
    expect(audits.some((a) => a.action === "merchant_broadcast.create")).toBe(
      true,
    );
  });

  test("honors minScore, status list and product tags", async () => {
    const { base } = fakeDb([
      seedLead({ id: 11n, status: "NEW", score: 90, productTags: ["serum"] }),
      seedLead({ id: 12n, status: "NEW", score: 10, productTags: ["serum"] }),
      seedLead({ id: 13n, status: "NEW", score: 90, productTags: ["váy"] }),
    ]);
    const dto = await createBroadcast(
      ctx,
      {
        name: "Tagged",
        body: "x",
        audienceFilter: { minScore: 50, status: ["NEW"], tags: ["serum"] },
      },
      base,
    );
    expect(dto.recipientCount).toBe(1);
    expect(dto.recipients?.[0]?.leadId).toBe("11");
  });

  test("caps the resolved audience at BROADCAST_AUDIENCE_CAP", async () => {
    const { base, recipients } = fakeDb(
      Array.from({ length: BROADCAST_AUDIENCE_CAP + 20 }, (_, i) =>
        seedLead({ id: BigInt(i + 1), score: i }),
      ),
    );
    const dto = await createBroadcast(ctx, { name: "Cap", body: "x" }, base);
    expect(dto.recipientCount).toBe(BROADCAST_AUDIENCE_CAP);
    expect(recipients.length).toBe(BROADCAST_AUDIENCE_CAP);
    // best-score-first: the dropped tail is the 20 lowest scores
    expect(recipients.some((r) => r.leadId === 1n)).toBe(false);
  });
});

describe("updateBroadcast", () => {
  function seeded() {
    const broadcasts: FakeBroadcast[] = [
      {
        id: 200n,
        tenantId: 7n,
        name: "Promo",
        body: "Chào {{authorName}}",
        audienceFilter: {},
        status: "READY",
        sentCount: 1,
        sentAt: null,
        createdBy: 3n,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const recipients: FakeRecipient[] = [
      {
        id: 300n,
        tenantId: 7n,
        broadcastId: 200n,
        leadId: 11n,
        body: "Chào Nguyễn Thảo",
        status: "PENDING",
        error: null,
        sentAt: null,
        createdAt: new Date(),
      },
      {
        id: 301n,
        tenantId: 7n,
        broadcastId: 200n,
        leadId: 12n,
        body: "Chào B",
        status: "SENT",
        error: null,
        sentAt: new Date(),
        createdAt: new Date(),
      },
    ];
    return fakeDb(
      [seedLead({ id: 11n }), seedLead({ id: 12n, authorName: "B" })],
      broadcasts,
      recipients,
    );
  }

  test("editing the template re-renders only PENDING recipients and drops READY to DRAFT", async () => {
    const { base, recipients } = seeded();
    const dto = await updateBroadcast(
      ctx,
      200n,
      { body: "Alo {{authorName}} - sale" },
      base,
    );
    expect(dto.status).toBe("DRAFT");
    expect(recipients.find((r) => r.id === 300n)?.body).toBe(
      "Alo Nguyễn Thảo - sale",
    );
    // the already-sent row keeps the text it actually went out with
    expect(recipients.find((r) => r.id === 301n)?.body).toBe("Chào B");
  });

  test("an explicit status wins over the implicit re-review", async () => {
    const { base } = seeded();
    const dto = await updateBroadcast(
      ctx,
      200n,
      { body: "new body", status: "READY" },
      base,
    );
    expect(dto.status).toBe("READY");
  });

  test("a SENT broadcast refuses edits", async () => {
    const { base, broadcasts } = seeded();
    const b0 = broadcasts[0];
    if (!b0) throw new Error("seeded() returned no broadcast");
    b0.status = "SENT";
    await expect(
      updateBroadcast(ctx, 200n, { name: "x" }, base),
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});

describe("sendBroadcast", () => {
  test("marks every PENDING recipient SENT and closes the broadcast", async () => {
    const { base, broadcasts, recipients, audits } = fakeDb(
      [seedLead()],
      [
        {
          id: 200n,
          tenantId: 7n,
          name: "Promo",
          body: "x",
          audienceFilter: {},
          status: "READY",
          sentCount: 0,
          sentAt: null,
          createdBy: 3n,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      [
        {
          id: 300n,
          tenantId: 7n,
          broadcastId: 200n,
          leadId: 11n,
          body: "x",
          status: "PENDING",
          error: null,
          sentAt: null,
          createdAt: new Date(),
        },
      ],
    );
    const dto = await sendBroadcast(ctx, 200n, base);
    expect(dto.status).toBe("SENT");
    expect(dto.sentCount).toBe(1);
    expect(broadcasts[0]?.sentAt).not.toBeNull();
    expect(recipients[0]?.status).toBe("SENT");
    expect(audits.some((a) => a.action === "merchant_broadcast.send")).toBe(
      true,
    );
    // a second send refuses: the rail is closed
    await expect(sendBroadcast(ctx, 200n, base)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("setRecipientStatus", () => {
  function seeded() {
    return fakeDb(
      [seedLead({ id: 11n }), seedLead({ id: 12n, authorName: "B" })],
      [
        {
          id: 200n,
          tenantId: 7n,
          name: "Promo",
          body: "x",
          audienceFilter: {},
          status: "READY",
          sentCount: 0,
          sentAt: null,
          createdBy: 3n,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ],
      [
        {
          id: 300n,
          tenantId: 7n,
          broadcastId: 200n,
          leadId: 11n,
          body: "x",
          status: "PENDING",
          error: null,
          sentAt: null,
          createdAt: new Date(),
        },
        {
          id: 301n,
          tenantId: 7n,
          broadcastId: 200n,
          leadId: 12n,
          body: "y",
          status: "PENDING",
          error: null,
          sentAt: null,
          createdAt: new Date(),
        },
      ],
    );
  }

  test("marking the last pending row closes the broadcast as SENT", async () => {
    const { base, broadcasts } = seeded();
    await setRecipientStatus(ctx, 200n, 300n, { status: "SENT" }, base);
    expect(broadcasts[0]?.status).toBe("READY");
    const dto = await setRecipientStatus(
      ctx,
      200n,
      301n,
      { status: "FAILED", error: "khách block" },
      base,
    );
    expect(dto.status).toBe("SENT");
    expect(dto.sentCount).toBe(1);
  });

  test("a SENT broadcast freezes its recipients", async () => {
    const { base, broadcasts } = seeded();
    const b0 = broadcasts[0];
    if (!b0) throw new Error("seeded() returned no broadcast");
    b0.status = "SENT";
    await expect(
      setRecipientStatus(ctx, 200n, 300n, { status: "SENT" }, base),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("an unknown recipient id is a 404", async () => {
    const { base } = seeded();
    await expect(
      setRecipientStatus(ctx, 200n, 999n, { status: "SENT" }, base),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("list/get", () => {
  test("listBroadcasts returns newest first with recipient counts", async () => {
    const { base } = fakeDb([seedLead()], [], []);
    await createBroadcast(ctx, { name: "A", body: "x" }, base);
    await createBroadcast(ctx, { name: "B", body: "y" }, base);
    const page = await listBroadcasts(ctx, {}, base);
    expect(page.items.map((b) => b.name)).toEqual(["B", "A"]);
    expect(page.items[0]?.recipientCount).toBe(1);
  });

  test("getBroadcast is a 404 outside the tenant scope", async () => {
    const { base } = fakeDb();
    await expect(getBroadcast(ctx, 404n, base)).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
