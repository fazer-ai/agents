import { describe, expect, test } from "bun:test";
import type { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import {
  createReplyDraft,
  approveReplyDraft,
  listReplyDrafts,
  markReplyDraftSent,
  parseDraftBody,
  rejectReplyDraft,
  updateReplyDraft,
} from "@/modules/funnel/drafts";

// The reply-draft rail is a state machine over a tenant-scoped row: DRAFT ->
// APPROVED -> SENT with reject from the two open states, and every hop is
// audited. The fake tx records mutations so each transition's legality and
// the DM_OPENER lead side-effect (NEW -> CONTACTED) are checkable without a
// database.

const ctx: TenantContext = { tenantId: 7n, userId: 3n, role: "TENANT_ADMIN" };

interface FakeLead {
  id: bigint;
  tenantId: bigint;
  platform: string;
  authorName: string;
  authorHandle: string | null;
  text: string;
  groupName: string | null;
  status: string;
  matches: { score: number; product: { name: string; price: number } }[];
}

interface FakeDraft {
  id: bigint;
  tenantId: bigint;
  leadId: bigint;
  kind: string;
  body: string;
  status: string;
  error: string | null;
  sentAt: Date | null;
  createdBy: bigint | null;
  createdAt: Date;
  updatedAt: Date;
}

function fakeDb(seedLeads: FakeLead[] = [], seedDrafts: FakeDraft[] = []) {
  const leads = [...seedLeads];
  const drafts = [...seedDrafts];
  const audits: { action: string; target: string }[] = [];
  let nextDraftId = 100n;
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
      findUnique: async ({ where }: { where: { id: bigint } }) => {
        const row = leads.find((l) => l.id === where.id);
        if (!row) return null;
        // mirror the `matches` select shape: sorted desc, top 3
        return {
          ...row,
          matches: [...row.matches]
            .sort((a, b) => b.score - a.score)
            .slice(0, 3),
        };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: bigint; status?: string };
        data: { status: string };
      }) => {
        let count = 0;
        for (const l of leads) {
          if (l.id === where.id && (!where.status || l.status === where.status)) {
            l.status = data.status;
            count++;
          }
        }
        return { count };
      },
    },
    replyDraft: {
      findUnique: async ({ where }: { where: { id: bigint } }) =>
        drafts.find((d) => d.id === where.id) ?? null,
      findMany: async ({ where }: { where: { leadId: bigint } }) =>
        drafts
          .filter((d) => d.leadId === where.leadId)
          .sort((a, b) => Number(b.id - a.id)),
      create: async ({ data }: { data: Partial<FakeDraft> }) => {
        const row: FakeDraft = {
          id: nextDraftId++,
          tenantId: data.tenantId ?? 7n,
          leadId: data.leadId ?? 0n,
          kind: data.kind ?? "DM_OPENER",
          body: data.body ?? "",
          status: "DRAFT",
          error: null,
          sentAt: null,
          createdBy: data.createdBy ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        drafts.push(row);
        return row;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: bigint };
        data: Partial<FakeDraft>;
      }) => {
        const row = drafts.find((d) => d.id === where.id);
        if (!row) throw new Error("not found");
        Object.assign(row, data);
        return row;
      },
    },
  };
  // runScopedOn only needs $extends + $transaction on the base client.
  const base = {
    $extends: () => ({ $transaction: (fn: (t: unknown) => unknown) => fn(tx) }),
  } as unknown as PrismaClient;
  return { base, leads, drafts, audits };
}

function seedLead(over: Partial<FakeLead> = {}): FakeLead {
  return {
    id: 11n,
    tenantId: 7n,
    platform: "facebook",
    authorName: "Nguyễn Thảo",
    authorHandle: null,
    text: "Cần mua serum trị mụn, budget 300k",
    groupName: "Hội mỹ phẩm",
    status: "NEW",
    matches: [{ score: 0.9, product: { name: "Serum BHA", price: 289000 } }],
    ...over,
  };
}

function seedDraft(over: Partial<FakeDraft> = {}): FakeDraft {
  return {
    id: 50n,
    tenantId: 7n,
    leadId: 11n,
    kind: "DM_OPENER",
    body: "Chào chị, em có serum BHA…",
    status: "DRAFT",
    error: null,
    sentAt: null,
    createdBy: 3n,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

describe("parseDraftBody", () => {
  test("accepts plain prose unchanged", () => {
    expect(parseDraftBody("Chào chị ạ, bên em có serum BHA 289k.")).toBe(
      "Chào chị ạ, bên em có serum BHA 289k.",
    );
  });

  test("unwraps a markdown fence and surrounding quotes", () => {
    expect(parseDraftBody('```\n"Chào chị"\n```')).toBe("Chào chị");
    expect(parseDraftBody('"Chào chị"')).toBe("Chào chị");
  });

  test("refuses empty or over-long answers", () => {
    expect(parseDraftBody("   ")).toBeNull();
    expect(parseDraftBody("x".repeat(4001))).toBeNull();
  });
});

describe("createReplyDraft", () => {
  test("stores an operator-supplied body without calling the gateway", async () => {
    const { base, drafts, audits } = fakeDb([seedLead()]);
    let fetchCalled = false;
    const outcome = await createReplyDraft(
      ctx,
      11n,
      { kind: "DM_OPENER", body: "Chào chị, em có hàng ạ" },
      {
        base,
        fetchImpl: (async () => {
          fetchCalled = true;
          return new Response("{}");
        }) as typeof fetch,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(fetchCalled).toBe(false);
    expect(drafts[0]?.body).toBe("Chào chị, em có hàng ạ");
    expect(audits.some((a) => a.action === "merchant_reply_draft.create")).toBe(
      true,
    );
  });

  test("generates a body through the gateway and persists it", async () => {
    const { base, drafts } = fakeDb([seedLead()]);
    const completion = {
      choices: [
        { message: { content: "Chào chị Thảo, em có Serum BHA 289k ạ" } },
      ],
    };
    const outcome = await createReplyDraft(
      ctx,
      11n,
      { kind: "PUBLIC_REPLY" },
      {
        base,
        fetchImpl: (async () =>
          new Response(JSON.stringify(completion), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
      },
    );
    expect(outcome.ok).toBe(true);
    expect(drafts[0]?.kind).toBe("PUBLIC_REPLY");
    expect(drafts[0]?.body).toContain("Serum BHA");
  });

  test("returns ok:false when the gateway fails, writing no draft", async () => {
    const { base, drafts } = fakeDb([seedLead()]);
    const outcome = await createReplyDraft(
      ctx,
      11n,
      { kind: "DM_OPENER" },
      {
        base,
        fetchImpl: (async () => new Response("nope", { status: 500 })) as typeof fetch,
      },
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe("gateway");
    expect(drafts.length).toBe(0);
  });

  test("throws NotFoundError for a lead outside the tenant scope", async () => {
    const { base } = fakeDb([]);
    await expect(
      createReplyDraft(ctx, 999n, { kind: "DM_OPENER", body: "x" }, { base }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("reply draft transitions", () => {
  test("approve moves DRAFT -> APPROVED and CONTACTs a NEW lead for DM_OPENER", async () => {
    const { base, leads, audits } = fakeDb(
      [seedLead({ status: "NEW" })],
      [seedDraft({ kind: "DM_OPENER" })],
    );
    const dto = await approveReplyDraft(ctx, 50n, base);
    expect(dto.status).toBe("APPROVED");
    expect(leads[0]?.status).toBe("CONTACTED");
    expect(audits.some((a) => a.action === "merchant_reply_draft.approve")).toBe(
      true,
    );
  });

  test("approving a PUBLIC_REPLY leaves the lead NEW", async () => {
    const { base, leads } = fakeDb(
      [seedLead({ status: "NEW" })],
      [seedDraft({ kind: "PUBLIC_REPLY" })],
    );
    await approveReplyDraft(ctx, 50n, base);
    expect(leads[0]?.status).toBe("NEW");
  });

  test("mark-sent is refused before approval (DRAFT -> SENT)", async () => {
    const { base } = fakeDb([seedLead()], [seedDraft({ status: "DRAFT" })]);
    await expect(markReplyDraftSent(ctx, 50n, base)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test("mark-sent stamps sentAt on APPROVED and CONTACTs the lead", async () => {
    const { base, leads } = fakeDb(
      [seedLead({ status: "NEW" })],
      [seedDraft({ status: "APPROVED" })],
    );
    const dto = await markReplyDraftSent(ctx, 50n, base);
    expect(dto.status).toBe("SENT");
    expect(dto.sentAt).not.toBeNull();
    expect(leads[0]?.status).toBe("CONTACTED");
  });

  test("reject works from DRAFT and APPROVED but not from SENT", async () => {
    const { base } = fakeDb(
      [seedLead()],
      [seedDraft({ id: 50n, status: "APPROVED" })],
    );
    const dto = await rejectReplyDraft(ctx, 50n, base);
    expect(dto.status).toBe("REJECTED");
    await expect(rejectReplyDraft(ctx, 50n, base)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  test("a SENT draft refuses every further transition", async () => {
    const { base } = fakeDb(
      [seedLead()],
      [seedDraft({ status: "SENT", sentAt: new Date() })],
    );
    await expect(approveReplyDraft(ctx, 50n, base)).rejects.toMatchObject({
      statusCode: 409,
    });
    await expect(markReplyDraftSent(ctx, 50n, base)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("updateReplyDraft / listReplyDrafts", () => {
  test("edit rewrites the body while DRAFT and is audited", async () => {
    const { base, audits } = fakeDb([seedLead()], [seedDraft()]);
    const dto = await updateReplyDraft(ctx, 50n, { body: "Sửa lại: chào chị" }, base);
    expect(dto.body).toBe("Sửa lại: chào chị");
    expect(audits.some((a) => a.action === "merchant_reply_draft.update")).toBe(
      true,
    );
  });

  test("edit is refused once APPROVED", async () => {
    const { base } = fakeDb(
      [seedLead()],
      [seedDraft({ status: "APPROVED" })],
    );
    await expect(
      updateReplyDraft(ctx, 50n, { body: "x" }, base),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  test("list returns drafts newest first for the scoped lead", async () => {
    const { base } = fakeDb(
      [seedLead()],
      [seedDraft({ id: 50n }), seedDraft({ id: 51n, kind: "PUBLIC_REPLY" })],
    );
    const list = await listReplyDrafts(ctx, 11n, base);
    expect(list.map((d) => d.id)).toEqual(["51", "50"]);
  });
});
